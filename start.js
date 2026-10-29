import { LAYER_ID, PANEL_IDENTIFIER } from "./src/constants.js";
import { thicknessEngine } from "./src/engine.js";
import ThicknessHeatmapPanel from "./src/panel.js";

const LAYER_Z_INDEX = 300;
const HOVER_BOUND = Symbol.for("fontra.thicknessHeatmap.hoverBound");

export function start(editorController, pluginPath) {
  ThicknessHeatmapPanel.prototype.iconPath = `${pluginPath}/icon.svg`;

  if (!customElements.get(PANEL_IDENTIFIER)) {
    customElements.define(PANEL_IDENTIFIER, ThicknessHeatmapPanel);
  }

  // Reuse the panel if the plugin is started more than once (for example after
  // a hot reload), so we don't stack duplicate sidebar tabs.
  let panel = document.querySelector(PANEL_IDENTIFIER);
  if (!panel) {
    panel = new ThicknessHeatmapPanel(editorController);
    editorController.addSidebarPanel(panel, "right");
    // Fontra derives the tab tooltip from a translation key. Third-party
    // panels have no entry in Fontra's translation table, so set it directly.
    const tab = document.querySelector(
      `.sidebar-tab[data-sidebar-name="${PANEL_IDENTIFIER}"]`
    );
    if (tab) {
      tab.title = "Thickness heatmap";
    }
  }

  // Register the visualization layer directly on the controller's layer list.
  //
  // Fontra's built client is a webpack bundle and does not serve the
  // individual modules that its `fontra/` import map points at, so importing
  // `fontra/editor/visualization-layer-definitions.js` from a plugin fails
  // with a 404 (reported as a disallowed MIME type). The definitions array and
  // the selection context are stable parts of the controller API, so we can
  // register without importing anything.
  const layers = editorController.visualizationLayers;
  const definitions = layers?.definitions;
  if (!definitions) {
    console.warn(
      "Thickness heatmap: editorController.visualizationLayers is unavailable; " +
        "the overlay layer was not registered."
    );
    return;
  }

  let pointerInsideCanvas = false;

  if (!definitions.some((layer) => layer.identifier === LAYER_ID)) {
    const getFocusContext = (positionedGlyph) => {
      const sceneController = panel.editorController?.sceneController;
      const sceneModel = sceneController?.sceneModel;
      const localPoint = sceneController?.localPoint?.();
      const glyphPoint =
        pointerInsideCanvas && localPoint && positionedGlyph
          ? {
              x: localPoint.x - positionedGlyph.x,
              y: localPoint.y - positionedGlyph.y,
            }
          : null;
      return {
        selection: sceneModel?.selection,
        hoverSelection: pointerInsideCanvas
          ? sceneModel?.hoverSelection
          : null,
        hoverPathHit: pointerInsideCanvas
          ? sceneController?.hoverPathHit
          : null,
        glyphPoint,
      };
    };

    const definition = {
      identifier: LAYER_ID,
      name: "Thickness heatmap",
      selectionFunc: (visContext) =>
        visContext.glyphsBySelectionMode?.editing ?? [],
      userSwitchable: true,
      defaultOn: true,
      zIndex: LAYER_Z_INDEX,
      draw: ({ context, positionedGlyph }) => {
        const settings = panel.controller.model;
        if (settings.enabled === false) {
          return;
        }
        const analysis = thicknessEngine.getAnalysis(positionedGlyph, settings);
        if (!analysis) {
          return;
        }
        const image = thicknessEngine.getImage(
          analysis,
          settings,
          getFocusContext(positionedGlyph)
        );
        if (!image) {
          return;
        }

        context.save();
        context.imageSmoothingEnabled = true;
        context.drawImage(
          image,
          analysis.originX,
          analysis.originY,
          analysis.physicalWidth,
          analysis.physicalHeight
        );
        context.restore();
      },
    };

    let index = definitions.findIndex(
      (layer) => (layer.zIndex ?? 0) > LAYER_Z_INDEX
    );
    if (index < 0) {
      index = definitions.length;
    }
    definitions.splice(index, 0, definition);
  }

  // Hover-focus needs a redraw even when Fontra's hover selection does not
  // change, for example while the pointer moves inside a filled shape.
  const canvas = editorController.canvasController?.canvas;
  if (canvas && !canvas[HOVER_BOUND]) {
    canvas[HOVER_BOUND] = true;
    let pending = false;
    const requestHoverUpdate = (event) => {
      const model = panel.controller?.model;
      if (!model?.perElement || model.elementFocus !== "hovered") {
        return;
      }
      if (event) {
        pointerInsideCanvas = true;
        panel.editorController?.sceneController?.localPoint?.(event);
      }
      if (pending) {
        return;
      }
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        panel.editorController?.canvasController?.requestUpdate();
      });
    };
    canvas.addEventListener("pointermove", requestHoverUpdate);
    canvas.addEventListener("pointerenter", () => {
      pointerInsideCanvas = true;
    });
    canvas.addEventListener("pointerleave", () => {
      pointerInsideCanvas = false;
      requestHoverUpdate();
    });
  }

  // The visualization-layers object was created before this plugin registered
  // its layer, so make sure the new layer is included in the next layer build.
  // Respect the persisted on/off state instead of forcing the layer on every
  // time Fontra starts.
  const enabled = panel.controller.model.enabled !== false;
  if (layers.visibleLayerIds) {
    const next = new Set(layers.visibleLayerIds);
    if (enabled) {
      next.add(LAYER_ID);
    } else {
      next.delete(LAYER_ID);
    }
    layers.visibleLayerIds = next;
  }
  const settingsModel = editorController.visualizationLayersSettings?.model;
  if (settingsModel) {
    settingsModel[LAYER_ID] = enabled;
  }
  layers.requestUpdate?.();
  editorController.canvasController?.requestUpdate();
}
