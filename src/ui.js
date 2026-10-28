/*
 * Self-contained replacements for the few Fontra UI primitives this plugin
 * uses.
 *
 * Fontra's built client is a webpack bundle: it does not ship the individual
 * modules that the `fontra/` import map points at (`/editor/panel.js`,
 * `/core/html-utils.js`, ...). Importing those paths from a plugin therefore
 * fails with a 404 that the browser reports as a disallowed MIME type.
 *
 * Keeping these small helpers local makes the plugin load against any Fontra
 * build, bundled or not, without sacrificing the panel behavior.
 */

export function createDomElement(tag, attributes = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (key === "class") {
      element.className = value;
    } else if (key === "style") {
      element.style.cssText = value;
    } else if (key === "checked") {
      element.checked = !!value;
    } else if (key === "selected") {
      element.selected = !!value;
    } else if (key === "value") {
      element.value = value;
    } else if (key.startsWith("on") && typeof value === "function") {
      element[key] = value;
    } else if (value === true) {
      element.setAttribute(key, "");
    } else if (value !== false) {
      element.setAttribute(key, String(value));
    }
  }

  appendChildren(element, children);
  return element;
}

function appendChildren(element, children) {
  for (const child of children || []) {
    if (child === null || child === undefined || child === false) {
      continue;
    }
    if (Array.isArray(child)) {
      appendChildren(element, child);
    } else if (child instanceof Node) {
      element.appendChild(child);
    } else {
      element.appendChild(document.createTextNode(String(child)));
    }
  }
}

function elementFactory(tag) {
  return (attributes = {}, children = []) =>
    createDomElement(tag, attributes, children);
}

export const button = elementFactory("button");
export const details = elementFactory("details");
export const div = elementFactory("div");
export const input = elementFactory("input");
export const label = elementFactory("label");
export const option = elementFactory("option");
export const select = elementFactory("select");
export const span = elementFactory("span");
export const summary = elementFactory("summary");

/*
 * Minimal Panel base class. Fontra's sidebar only needs `identifier`,
 * `iconPath`, and a DOM element; `contentElement` and the shadow root keep the
 * panel styles isolated, just like Fontra's own Panel.
 */
export class Panel extends HTMLElement {
  constructor(editorController) {
    super();
    this.editorController = editorController;
    this.fontController = editorController?.fontController;

    this.attachShadow({ mode: "open" });

    // Same base stylesheet Fontra's own panels load into their shadow root.
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/css/shared.css";
    this.shadowRoot.appendChild(link);

    const style = document.createElement("style");
    style.textContent = this.constructor.styles || "";
    this.shadowRoot.appendChild(style);

    this.contentElement = this.getContentElement();
    if (this.contentElement) {
      this.shadowRoot.appendChild(this.contentElement);
    }
  }

  getContentElement() {}

  async toggle() {}
}

/*
 * Minimal observable model with the localStorage synchronization behavior the
 * panel relies on: values are stored as flat `prefix + key` entries, strings
 * as-is and everything else as JSON.
 */
export class ObservableController {
  constructor(initialModel = {}) {
    this._listeners = new Set();
    this._keyListeners = new Map();
    this._storagePrefix = null;
    this._stringKeys = new Map();
    this.model = makeObservable(this, { ...initialModel });
  }

  addListener(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  removeListener(listener) {
    this._listeners.delete(listener);
  }

  addKeyListener(keys, listener) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      if (!this._keyListeners.has(key)) {
        this._keyListeners.set(key, new Set());
      }
      this._keyListeners.get(key).add(listener);
    }
  }

  removeKeyListener(keys, listener) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this._keyListeners.get(key)?.delete(listener);
    }
  }

  setItem(key, value) {
    this.model[key] = value;
  }

  synchronizeWithLocalStorage(prefix = "") {
    this._storagePrefix = prefix;

    for (const [key, value] of Object.entries(this.model)) {
      this._stringKeys.set(key, typeof value === "string");
      let storedValue = null;
      try {
        storedValue = localStorage.getItem(prefix + key);
      } catch (error) {
        // localStorage can be unavailable (private mode, file://); the
        // settings still work for the current session.
      }
      if (storedValue !== null) {
        try {
          this.model[key] = this._stringKeys.get(key)
            ? storedValue
            : JSON.parse(storedValue);
        } catch (error) {
          // Ignore corrupt stored values and keep the default.
        }
      }
    }

    this.addListener((event) => this._storeItem(event.key, event.newValue));

    window.addEventListener("storage", (event) => {
      if (
        this._storagePrefix === null ||
        event.key === null ||
        !event.key.startsWith(this._storagePrefix)
      ) {
        return;
      }
      const key = event.key.slice(this._storagePrefix.length);
      if (!this._stringKeys.has(key)) {
        return;
      }
      try {
        this.model[key] = this._stringKeys.get(key)
          ? event.newValue
          : JSON.parse(event.newValue);
      } catch (error) {
        // Ignore corrupt values written by another tab.
      }
    });
  }

  _storeItem(key, value) {
    if (this._storagePrefix === null || !this._stringKeys.has(key)) {
      return;
    }
    const valueAsString = this._stringKeys.get(key)
      ? String(value)
      : JSON.stringify(value);
    try {
      if (localStorage.getItem(this._storagePrefix + key) !== valueAsString) {
        localStorage.setItem(this._storagePrefix + key, valueAsString);
      }
    } catch (error) {
      // See synchronizeWithLocalStorage().
    }
  }

  _dispatchChange(key, oldValue, newValue) {
    const event = { key, oldValue, newValue };
    for (const listener of this._listeners) {
      listener(event);
    }
    for (const listener of this._keyListeners.get(key) || []) {
      listener(event);
    }
  }
}

function makeObservable(controller, target) {
  return new Proxy(target, {
    set(object, key, value) {
      const oldValue = object[key];
      if (Object.is(oldValue, value)) {
        return true;
      }
      object[key] = value;
      controller._dispatchChange(key, oldValue, value);
      return true;
    },
  });
}
