import {
  ObservableController,
  Panel,
  button,
  details,
  div,
  input,
  label,
  option,
  select,
  span,
  summary,
} from "./ui.js";

import { DEFAULT_SETTINGS, MODEL_TYPES, modelLabel, normalizeSettings } from "./core.js";
import {
  deviationGradientCSS,
  legendModel,
  sequentialGradientCSS,
} from "./colormap.js";
import { thicknessEngine } from "./engine.js";
import { LAYER_ID, PANEL_IDENTIFIER } from "./constants.js";
import {
  FLOW_GUIDE_MODES,
  FlowGuideStore,
  flowGuideLength,
  simplifyFlowGuide,
} from "./guides.js";

const FLOW_GUIDE_STORAGE_KEY = "fontra.thickness-heatmap.flow-guides.v1";
const GUIDE_CANVAS_BOUND = Symbol.for("fontra.thicknessHeatmap.guideCanvasBound");
const GUIDE_HANDLE_RADIUS = 3.2;
const GUIDE_LINE_WIDTH = 2.2;
const GUIDE_HALO_WIDTH = 4.8;

const DISPLAY_MODE_LABELS = {
  deviation: "Deviation from model",
  target: "Model target thickness",
  measured: "Measured thickness",
  outliers: "Outliers only",
};

const PALETTE_LABELS = {
  accessible: "Blue / orange (colorblind-friendly)",
  classic: "Blue / red (classic)",
};

const QUALITY_LABELS = {
  fast: "Fast",
  balanced: "Balanced",
  fine: "Fine",
};

const ELEMENT_FOCUS_LABELS = {
  all: "All elements",
  selected: "Selected element(s)",
  hovered: "Hovered element",
};

const FLOW_GUIDE_MODE_LABELS = {
  across: "Across the stroke",
  along: "Along the stroke",
};

function fmt(value, digits = 1) {
  return Number(value).toFixed(digits);
}

function signed(value, digits = 1) {
  const number = Number(value);
  return `${number > 0 ? "+" : ""}${number.toFixed(digits)}`;
}

export default class ThicknessHeatmapPanel extends Panel {
  identifier = PANEL_IDENTIFIER;

  static styles = `
    .heatmap-panel {
      display: flex;
      flex-direction: column;
      gap: 0.8em;
      padding: 1em;
      overflow: hidden auto;
      height: 100%;
      box-sizing: border-box;
      font-size: 0.95em;
      line-height: 1.35;
    }

    .title {
      font-weight: bold;
      font-size: 1.1em;
      margin-bottom: 0.1em;
    }

    .subtitle {
      color: var(--foreground-color);
      opacity: 0.68;
      margin-top: -0.5em;
      font-size: 0.9em;
    }

    .panel-section {
      display: flex;
      flex-direction: column;
      gap: 0.45em;
      padding-top: 0.7em;
      border-top: 1px solid var(--horizontal-rule-color);
    }

    .controls-group {
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }

    .section-heading {
      font-weight: 600;
      font-size: 0.92em;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      opacity: 0.7;
    }

    .field-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 0.5em;
    }

    .field-row label,
    .range-label {
      white-space: nowrap;
    }

    .range-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: baseline;
      gap: 0.5em;
    }

    .range-value {
      font-variant-numeric: tabular-nums;
      font-size: 0.9em;
      opacity: 0.75;
      min-width: 3.5em;
      text-align: right;
    }

    input[type="range"] {
      width: 100%;
      margin: 0.15em 0 0;
      accent-color: var(--fontra-red-color);
    }

    select,
    input[type="number"] {
      min-width: 0;
      border: none;
      border-radius: 5px;
      padding: 0.35em 0.45em;
      font-family: fontra-ui-regular, sans-serif;
      background: var(--text-input-background-color);
      color: var(--text-input-foreground-color);
      font-size: 0.95em;
    }

    input[type="number"] {
      width: 5.5em;
      font-variant-numeric: tabular-nums;
    }

    button {
      border: none;
      border-radius: 5px;
      padding: 0.38em 0.65em;
      font-family: fontra-ui-regular, sans-serif;
      font-size: 0.92em;
      background: var(--ui-element-background-color);
      color: var(--ui-element-foreground-color);
      cursor: pointer;
    }

    button:hover {
      background: var(--editor-tool-button-hover-background-color, #ddd);
    }

    .inline-buttons {
      display: flex;
      gap: 0.4em;
      flex-wrap: wrap;
    }

    .help {
      opacity: 0.62;
      font-size: 0.84em;
    }

    .checkbox-row {
      display: flex;
      align-items: center;
      gap: 0.4em;
    }

    .checkbox-row input {
      accent-color: var(--fontra-red-color);
      margin: 0;
    }

    .checkbox-row.enabled-row {
      font-weight: 600;
    }

    .checkbox-row.disabled {
      opacity: 0.55;
    }

    button.guide-draw-button.active {
      background: var(--fontra-red-color);
      color: #fff;
    }

    .guide-status {
      min-height: 1.2em;
      font-size: 0.86em;
      opacity: 0.72;
      font-variant-numeric: tabular-nums;
    }

    .legend {
      display: flex;
      flex-direction: column;
      gap: 0.25em;
    }

    .legend-title {
      display: flex;
      justify-content: space-between;
      gap: 0.5em;
      font-size: 0.9em;
    }

    .legend-title span:last-child {
      opacity: 0.65;
      font-variant-numeric: tabular-nums;
    }

    .legend-bar {
      position: relative;
      height: 0.85em;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid var(--horizontal-rule-color);
    }

    .legend-tolerance {
      position: absolute;
      top: 0;
      bottom: 0;
      border-left: 1px solid #0008;
      border-right: 1px solid #0008;
      background: #fff2;
      pointer-events: none;
    }

    .legend-labels {
      display: flex;
      justify-content: space-between;
      font-size: 0.78em;
      opacity: 0.7;
      font-variant-numeric: tabular-nums;
    }

    .stats-grid {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0.18em 0.6em;
      font-size: 0.88em;
    }

    .stat-label {
      opacity: 0.68;
    }

    .stat-value {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    .empty-stats {
      opacity: 0.65;
      font-size: 0.88em;
    }

    .status-line {
      min-height: 1.2em;
      font-size: 0.84em;
      opacity: 0.7;
    }

    details {
      font-size: 0.86em;
      opacity: 0.85;
    }

    summary {
      cursor: pointer;
      opacity: 0.8;
    }

    details p {
      margin: 0.45em 0;
    }

    code {
      font-size: 0.95em;
    }
  `;

  constructor(editorController) {
    super(editorController);

    this._analysisListener = (analysis) => {
      this._updateStats(analysis);
      this._updateLegend();
      this._updateElementStatus(analysis);
    };
    thicknessEngine.addListener(this._analysisListener);
    this._updateStats(thicknessEngine.lastAnalysis);
    this._updateLegend();
    this._updateElementStatus(thicknessEngine.lastAnalysis);
    this._syncControls();

    // Keep the panel checkbox in sync when the layer is switched from Fontra's
    // own appearance menu.
    this._layerSettingsListener = (event) => {
      if (event.key !== LAYER_ID) {
        return;
      }
      if (this.model.enabled !== event.newValue) {
        this.model.enabled = event.newValue;
      }
    };
    editorController?.visualizationLayersSettings?.addListener(
      this._layerSettingsListener
    );

    this._sceneSettingsController =
      editorController?.sceneController?.sceneSettingsController;
    this._guideGlyphListener = (event) => {
      if (event.key !== "selectedGlyph") {
        return;
      }
      if (this._guideDrawing) {
        this._stopGuideDrawing();
      }
      this._updateGuideStatus();
    };
    this._sceneSettingsController?.addKeyListener(
      "selectedGlyph",
      this._guideGlyphListener
    );
  }

  get model() {
    return this.controller.model;
  }

  getContentElement() {
    this.controller = new ObservableController({ ...DEFAULT_SETTINGS });
    this.controller.synchronizeWithLocalStorage("fontra.thickness-heatmap.");

    this._sliders = {};
    this._controls = {};
    this._guideStore = new FlowGuideStore(FLOW_GUIDE_STORAGE_KEY);
    this._guideDrawing = false;
    this._guideDraft = null;
    this._guideDraftGlyphName = null;
    this._guideCanvas = null;

    const icon = span({ class: "panel-icon", "aria-hidden": "true" }, ["◒"]);
    const title = div({ class: "title" }, ["Thickness heatmap"]);
    const subtitle = div({ class: "subtitle" }, [
      "Compare the drawing with a Noordzij-style pen model.",
    ]);

    const enabledCheckbox = input({
      type: "checkbox",
      id: "thickness-enabled",
      checked: this.model.enabled !== false,
      onchange: (event) => {
        this.model.enabled = event.target.checked;
      },
    });
    this._controls.enabledCheckbox = enabledCheckbox;

    const enabledSection = div({ class: "panel-section" }, [
      label({ class: "checkbox-row enabled-row" }, [
        enabledCheckbox,
        span({}, ["Show thickness heatmap"]),
      ]),
      div({ class: "help" }, [
        "Turn this off to keep the panel and its settings but stop all measurement and drawing.",
      ]),
    ]);

    const modelSelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.modelType = event.target.value;
        },
      },
      MODEL_TYPES.map((type) =>
        option(
          {
            value: type,
            selected: this.model.modelType === type,
          },
          [modelLabel(type)]
        )
      )
    );
    this._controls.modelSelect = modelSelect;

    this.modelHelp = div({ class: "help" }, []);

    const baseInput = input({
      type: "number",
      min: "0.1",
      step: "0.1",
      value: this.model.baseThickness,
      onchange: (event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value) && value > 0) {
          this.model.baseThickness = value;
        }
        event.target.value = this.model.baseThickness;
      },
    });
    this._controls.baseInput = baseInput;

    const fitButton = button(
      {
        type: "button",
        title: "Estimate vertical and horizontal thicknesses from this glyph",
        onclick: () => this._fitThicknesses(),
      },
      ["Fit to glyph"]
    );

    const baseRow = div({ class: "field-row" }, [
      label({ for: "thickness-base" }, ["Vertical thickness"]),
      div({ class: "inline-buttons" }, [baseInput, fitButton]),
    ]);
    baseInput.id = "thickness-base";

    const penEdgeInput = input({
      type: "number",
      min: "0",
      max: "1000",
      step: "1",
      value: fmt(this.model.translationMin * 100, 1).replace(/\.?0+$/, ""),
      onchange: (event) => {
        const percent = Number(event.target.value);
        if (Number.isFinite(percent) && percent >= 0) {
          this.model.translationMin = Math.min(10, percent / 100);
        }
        event.target.value = fmt(this.model.translationMin * 100, 1).replace(
          /\.?0+$/,
          ""
        );
      },
    });
    penEdgeInput.id = "thickness-pen-edge";
    this._controls.penEdgeInput = penEdgeInput;

    const penEdgeRange = input({
      type: "range",
      min: "0",
      max: "1",
      step: "0.01",
      value: Math.min(this.model.translationMin, 1),
      oninput: (event) => {
        this.model.translationMin = Number(event.target.value);
      },
    });
    this._controls.penEdgeRange = penEdgeRange;

    const penEdgeEstimate = div({ class: "help" }, []);
    this.penEdgeEstimate = penEdgeEstimate;

    const translationSection = div({ class: "controls-group" }, [
      this._makeSlider({
        key: "penAngle",
        label: "Pen angle",
        min: 0,
        max: 80,
        step: 1,
        format: (value) => `${fmt(value, 0)}°`,
        help:
          "Angle of the broad nib's thin direction. 0° gives vertical stems their full width; 30° is a classic calligraphic angle.",
      }),
      div({ class: "range-row" }, [
        label({ class: "range-label", for: "thickness-pen-edge" }, [
          "Pen edge thickness",
        ]),
        div({ class: "inline-buttons" }, [penEdgeInput, span({}, ["%"])]),
      ]),
      penEdgeRange,
      div({ class: "help" }, [
        "The thinnest stroke as a fraction of the vertical target. 100% is a square nib (monoline); above 100% reverses the contrast. The slider stops at 100%, but you can type higher values.",
      ]),
      penEdgeEstimate,
    ]);
    this.translationSection = translationSection;

    const horizontalInput = input({
      type: "number",
      min: "0.1",
      step: "0.1",
      value: this.model.expansionHorizontal,
      onchange: (event) => {
        const value = Number(event.target.value);
        if (Number.isFinite(value) && value > 0) {
          this.model.expansionHorizontal = value;
        }
        event.target.value = this.model.expansionHorizontal;
      },
    });
    this._controls.horizontalInput = horizontalInput;
    horizontalInput.id = "thickness-horizontal";

    const expansionContrast = div({ class: "help" }, []);
    this.expansionContrast = expansionContrast;

    const expansionSection = div({ class: "controls-group" }, [
      div({ class: "field-row" }, [
        label({ for: "thickness-horizontal" }, ["Horizontal thickness"]),
        horizontalInput,
      ]),
      div({ class: "help" }, [
        "Target thickness for horizontal strokes. Vertical and horizontal targets define the contrast; diagonals blend smoothly between them.",
      ]),
      expansionContrast,
    ]);
    this.expansionSection = expansionSection;

    const monolineSection = div({ class: "help" }, [
      "Monoline uses the same target thickness in every direction.",
    ]);
    this.monolineSection = monolineSection;

    const modelSection = div({ class: "panel-section" }, [
      div({ class: "section-heading" }, ["Pen model"]),
      div({ class: "field-row" }, [
        label({ for: "thickness-model" }, ["Model"]),
        modelSelect,
      ]),
      this.modelHelp,
      baseRow,
      div({ class: "help" }, [
        "Vertical thickness is the target for vertical stems. “Fit to glyph” estimates both vertical and horizontal targets from the current outline.",
      ]),
      translationSection,
      expansionSection,
      monolineSection,
    ]);
    modelSelect.id = "thickness-model";

    const displaySelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.displayMode = event.target.value;
        },
      },
      Object.entries(DISPLAY_MODE_LABELS).map(([value, labelText]) =>
        option(
          {
            value,
            selected: this.model.displayMode === value,
          },
          [labelText]
        )
      )
    );
    this._controls.displaySelect = displaySelect;

    const paletteSelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.palette = event.target.value;
        },
      },
      Object.entries(PALETTE_LABELS).map(([value, labelText]) =>
        option(
          {
            value,
            selected: this.model.palette === value,
          },
          [labelText]
        )
      )
    );
    this._controls.paletteSelect = paletteSelect;

    const qualitySelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.quality = event.target.value;
        },
      },
      Object.entries(QUALITY_LABELS).map(([value, labelText]) =>
        option(
          {
            value,
            selected: this.model.quality === value,
          },
          [labelText]
        )
      )
    );
    this._controls.qualitySelect = qualitySelect;

    const fadeCheckbox = input({
      type: "checkbox",
      checked: this.model.fadeLowConfidence,
      onchange: (event) => {
        this.model.fadeLowConfidence = event.target.checked;
      },
    });
    this._controls.fadeCheckbox = fadeCheckbox;

    const carefulCheckbox = input({
      type: "checkbox",
      id: "thickness-careful",
      checked: this.model.carefulMeasurement,
      onchange: (event) => {
        this.model.carefulMeasurement = event.target.checked;
      },
    });
    this._controls.carefulCheckbox = carefulCheckbox;

    this.toleranceSection = this._makeSlider({
      key: "tolerance",
      label: "Tolerance band",
      min: 0,
      max: 25,
      step: 0.5,
      format: (value) => `±${fmt(value, 1)}%`,
      help:
        "Deviations inside this band are treated as neutral. Optically corrected bowls, spines and junctions often belong here.",
    });

    this.scaleSection = this._makeSlider({
      key: "scaleRange",
      label: "Color scale",
      min: 5,
      max: 60,
      step: 1,
      format: (value) => `±${fmt(value, 0)}%`,
      help:
        "Deviation mapped to the strongest heat color. The legend always shows the active range.",
    });

    this.opacitySection = this._makeSlider({
      key: "opacity",
      label: "Overlay opacity",
      min: 0.1,
      max: 1,
      step: 0.01,
      format: (value) => `${fmt(value * 100, 0)}%`,
    });

    this.fadeRow = label({ class: "checkbox-row" }, [
      fadeCheckbox,
      span({}, ["Fade low-confidence areas (junctions, serifs, hairlines)"]),
    ]);
    this.fadeHelp = div({ class: "help" }, []);

    const perElementCheckbox = input({
      type: "checkbox",
      id: "thickness-per-element",
      checked: this.model.perElement,
      onchange: (event) => {
        this.model.perElement = event.target.checked;
      },
    });
    this._controls.perElementCheckbox = perElementCheckbox;

    const elementFocusSelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.elementFocus = event.target.value;
        },
      },
      Object.entries(ELEMENT_FOCUS_LABELS).map(([value, labelText]) =>
        option(
          {
            value,
            selected: this.model.elementFocus === value,
          },
          [labelText]
        )
      )
    );
    elementFocusSelect.id = "thickness-element-focus";
    this._controls.elementFocusSelect = elementFocusSelect;

    const fadeOtherCheckbox = input({
      type: "checkbox",
      checked: this.model.fadeOtherElements,
      onchange: (event) => {
        this.model.fadeOtherElements = event.target.checked;
      },
    });
    this._controls.fadeOtherCheckbox = fadeOtherCheckbox;

    this.fadeOtherRow = label({ class: "checkbox-row" }, [
      fadeOtherCheckbox,
      span({}, ["Fade other elements"]),
    ]);
    this.elementStatus = div({ class: "status-line" }, []);

    const elementsSection = div({ class: "panel-section" }, [
      div({ class: "section-heading" }, ["Elements"]),
      label({ class: "checkbox-row" }, [
        perElementCheckbox,
        span({}, ["Measure each element separately"]),
      ]),
      div({ class: "help" }, [
        "Each contour and component is measured on its own. Overlapping shapes no longer share a junction; a letter built as one contour still does.",
      ]),
      div({ class: "field-row" }, [
        label({ for: "thickness-element-focus" }, ["Show"]),
        elementFocusSelect,
      ]),
      this.fadeOtherRow,
      this.elementStatus,
    ]);

    const useGuidesCheckbox = input({
      type: "checkbox",
      checked: this.model.useFlowGuides,
      onchange: (event) => {
        this.model.useFlowGuides = event.target.checked;
      },
    });
    this._controls.useGuidesCheckbox = useGuidesCheckbox;

    const showGuidesCheckbox = input({
      type: "checkbox",
      checked: this.model.showFlowGuides,
      onchange: (event) => {
        this.model.showFlowGuides = event.target.checked;
        this._requestGuideUpdate();
      },
    });
    this._controls.showGuidesCheckbox = showGuidesCheckbox;

    const guideModeSelect = select(
      {
        class: "select-input",
        onchange: (event) => {
          this.model.flowGuideMode = event.target.value;
        },
      },
      FLOW_GUIDE_MODES.map((mode) =>
        option(
          {
            value: mode,
            selected: this.model.flowGuideMode === mode,
          },
          [FLOW_GUIDE_MODE_LABELS[mode]]
        )
      )
    );
    guideModeSelect.id = "thickness-guide-mode";
    this._controls.guideModeSelect = guideModeSelect;

    const drawGuideButton = button(
      {
        type: "button",
        class: "guide-draw-button",
        title: "Draw a flow guide on the selected glyph",
        onclick: () => this._toggleGuideDrawing(),
      },
      ["Draw guides"]
    );
    this._controls.drawGuideButton = drawGuideButton;

    const undoGuideButton = button(
      {
        type: "button",
        title: "Remove the last flow guide on this glyph",
        onclick: () => this._undoLastGuide(),
      },
      ["Undo guide"]
    );
    this._controls.undoGuideButton = undoGuideButton;

    const clearGuideButton = button(
      {
        type: "button",
        title: "Remove all flow guides from this glyph",
        onclick: () => this._clearGuides(),
      },
      ["Clear glyph"]
    );
    this._controls.clearGuideButton = clearGuideButton;

    const guideStatus = div({ class: "guide-status" }, []);
    this.guideStatus = guideStatus;
    const guideHelp = div({ class: "help" }, []);
    this.guideHelp = guideHelp;

    const flowGuideSection = div({ class: "panel-section" }, [
      div({ class: "section-heading" }, ["Flow guides"]),
      div({ class: "help" }, [
        "Draw a line across a stroke (or along it) to tell the pen model which way the stroke flows. The blue line is not part of the glyph. Hold Shift for a straight guide.",
      ]),
      div({ class: "field-row" }, [
        label({ for: "thickness-guide-mode" }, ["Guide line"]),
        guideModeSelect,
      ]),
      guideHelp,
      label({ class: "checkbox-row" }, [
        useGuidesCheckbox,
        span({}, ["Use guides in measurement"]),
      ]),
      label({ class: "checkbox-row" }, [
        showGuidesCheckbox,
        span({}, ["Show guides"]),
      ]),
      div({ class: "inline-buttons" }, [
        drawGuideButton,
        undoGuideButton,
        clearGuideButton,
      ]),
      guideStatus,
    ]);

    const displaySection = div({ class: "panel-section" }, [
      div({ class: "section-heading" }, ["Display"]),
      div({ class: "field-row" }, [
        label({ for: "thickness-display" }, ["Show"]),
        displaySelect,
      ]),
      div({ class: "field-row" }, [
        label({ for: "thickness-palette" }, ["Deviation colors"]),
        paletteSelect,
      ]),
      this.scaleSection,
      this.toleranceSection,
      this.opacitySection,
      div({ class: "field-row" }, [
        label({ for: "thickness-quality" }, ["Analysis detail"]),
        qualitySelect,
      ]),
      this.fadeRow,
      this.fadeHelp,
      label({ class: "checkbox-row" }, [
        carefulCheckbox,
        span({}, ["Careful curve & junction measurement (slower)"]),
      ]),
      div({ class: "help" }, [
        "Careful mode traces each stroke from both sides and rejects chords across curves and junctions. Turn it off for faster redraws.",
      ]),
    ]);
    displaySelect.id = "thickness-display";
    paletteSelect.id = "thickness-palette";
    qualitySelect.id = "thickness-quality";

    this.legendTitle = div({ class: "legend-title" }, [
      span({}, ["Legend"]),
      span({}, [""]),
    ]);
    this.legendBar = div({ class: "legend-bar" }, []);
    this.legendTolerance = div({ class: "legend-tolerance" }, []);
    this.legendBar.appendChild(this.legendTolerance);
    this.legendLabels = div({ class: "legend-labels" }, [
      span({}, [""]),
      span({}, [""]),
      span({}, [""]),
    ]);
    this.legendNote = div({ class: "help" }, []);
    const legendSection = div({ class: "panel-section legend" }, [
      div({ class: "section-heading" }, ["Reading the map"]),
      this.legendTitle,
      this.legendBar,
      this.legendLabels,
      this.legendNote,
    ]);

    this.statsElement = div({ class: "stats-grid" }, []);
    const statsSection = div({ class: "panel-section" }, [
      div({ class: "section-heading" }, ["Glyph summary"]),
      this.statsElement,
    ]);

    this.statusLine = div({ class: "status-line" }, []);

    const resetButton = button(
      {
        type: "button",
        title: "Restore the default heatmap settings",
        onclick: () => this._resetSettings(),
      },
      ["Reset settings"]
    );

    const notes = details({}, [
      summary({}, ["How to read this map"]),
      div({}, [
        "Cool colors mean thinner than the model; warm colors mean thicker. " +
          "The tolerance band keeps small optical corrections faint and neutral. " +
          "In deviation and outliers views, uncertain junction/serif areas fade back.",
        "Measured and model target views are absolute readouts: every inked pixel shows " +
          "the nearest reliable measurement, even where careful mode rejected the local " +
          "chord. Low-confidence fading is off in those views.",
        "Careful mode checks each stroke from both sides, which rejects chords across " +
          "curves and junctions. It is slower; turn it off when you only need a quick read.",
        "Per-element mode measures every contour and component as its own shape. " +
          "Overlapping shapes do not share a junction, and a selected or hovered element " +
          "can be shown over faded neighbours. A letter built as a single contour still " +
          "has its junctions measured together.",
        "This is a lens, not a judge. A bowl that is deliberately lighter than a stem, " +
          "an S spine that is deliberately heavier, or the thin right side of a V is expected " +
          "to show as a deviation. Read the pattern, not individual pixels.",
      ]),
    ]);

    const panel = div({ class: "heatmap-panel" }, [
      div({}, [div({ style: "display:none" }, [icon]), title, subtitle]),
      enabledSection,
      modelSection,
      displaySection,
      elementsSection,
      flowGuideSection,
      legendSection,
      statsSection,
      this.statusLine,
      div({ class: "inline-buttons" }, [resetButton]),
      notes,
    ]);

    this.controller.addListener(() => {
      this._syncControls();
      this._updateLegend();
      this.editorController.canvasController.requestUpdate();
    });

    this._setupGuideDrawing();
    requestAnimationFrame(() => {
      this._syncControls();
      this._updateGuideStatus();
    });

    return panel;
  }

  _makeSlider({ key, label: labelText, min, max, step, format, help }) {
    const valueLabel = span({ class: "range-value" }, [
      format(this.model[key]),
    ]);
    const range = input({
      type: "range",
      min,
      max,
      step,
      value: this.model[key],
      oninput: (event) => {
        this.model[key] = Number(event.target.value);
        valueLabel.textContent = format(Number(event.target.value));
      },
    });

    this._sliders[key] = { range, valueLabel, format };

    return div({ class: "controls-group" }, [
      div({ class: "range-row" }, [
        label({ class: "range-label" }, [labelText]),
        valueLabel,
      ]),
      range,
      help ? div({ class: "help" }, [help]) : null,
    ]);
  }

  _syncControls() {
    if (!this._sliders) {
      return;
    }
    const settings = normalizeSettings(this.model);
    const absoluteMode =
      settings.displayMode === "target" || settings.displayMode === "measured";

    if (this._controls.enabledCheckbox) {
      this._controls.enabledCheckbox.checked = settings.enabled;
    }
    if (this._controls.perElementCheckbox) {
      this._controls.perElementCheckbox.checked = settings.perElement;
    }
    if (this._controls.elementFocusSelect) {
      this._controls.elementFocusSelect.value = settings.elementFocus;
      this._controls.elementFocusSelect.disabled = !settings.perElement;
    }
    if (this._controls.fadeOtherCheckbox) {
      this._controls.fadeOtherCheckbox.checked = settings.fadeOtherElements;
      this._controls.fadeOtherCheckbox.disabled =
        !settings.perElement || settings.elementFocus === "all";
    }
    if (this.fadeOtherRow) {
      this.fadeOtherRow.style.display =
        settings.perElement && settings.elementFocus !== "all"
          ? "flex"
          : "none";
    }

    for (const [key, slider] of Object.entries(this._sliders)) {
      slider.range.value = settings[key];
      slider.valueLabel.textContent = slider.format(settings[key]);
    }

    if (this._controls.modelSelect) {
      this._controls.modelSelect.value = settings.modelType;
    }
    if (this._controls.displaySelect) {
      this._controls.displaySelect.value = settings.displayMode;
    }
    if (this._controls.paletteSelect) {
      this._controls.paletteSelect.value = settings.palette;
      this._controls.paletteSelect.disabled = absoluteMode;
    }
    if (this._controls.qualitySelect) {
      this._controls.qualitySelect.value = settings.quality;
    }
    if (this._controls.baseInput) {
      if (document.activeElement !== this._controls.baseInput) {
        this._controls.baseInput.value = fmt(settings.baseThickness, 2).replace(
          /\.?0+$/,
          ""
        );
      }
    }
    if (this._controls.horizontalInput) {
      if (document.activeElement !== this._controls.horizontalInput) {
        this._controls.horizontalInput.value = fmt(
          settings.expansionHorizontal,
          2
        ).replace(/\.?0+$/, "");
      }
    }
    if (this.expansionContrast) {
      const ratio = (100 * settings.expansionHorizontal) / Math.max(
        settings.baseThickness,
        0.001
      );
      this.expansionContrast.textContent =
        `Horizontal is ${fmt(ratio, 0)}% of the vertical target. ` +
        `Set them equal for a monoline-like contrast.`;
    }
    if (this._controls.fadeCheckbox) {
      this._controls.fadeCheckbox.checked = settings.fadeLowConfidence;
      this._controls.fadeCheckbox.disabled = absoluteMode;
    }
    if (this.fadeRow) {
      this.fadeRow.classList.toggle("disabled", absoluteMode);
    }
    if (this.fadeHelp) {
      this.fadeHelp.textContent = absoluteMode
        ? "Not used here: measured and target modes show the nearest reliable measurement in every inked pixel."
        : "Low-confidence junctions, serifs, caps and hairlines fade back in deviation and outliers modes.";
    }
    if (this._controls.carefulCheckbox) {
      this._controls.carefulCheckbox.checked = settings.carefulMeasurement;
    }
    if (this._controls.penEdgeRange) {
      // The slider intentionally caps at 100%; the number input remains the
      // exact value and can go higher.
      this._controls.penEdgeRange.value = Math.min(settings.translationMin, 1);
    }
    if (
      this._controls.penEdgeInput &&
      document.activeElement !== this._controls.penEdgeInput
    ) {
      this._controls.penEdgeInput.value = fmt(
        settings.translationMin * 100,
        1
      ).replace(/\.?0+$/, "");
    }
    if (this.penEdgeEstimate) {
      const thinnest = settings.baseThickness * settings.translationMin;
      this.penEdgeEstimate.textContent =
        `Thinnest stroke ≈ ${fmt(thinnest, 1)} units at the pen angle ` +
        `(${fmt(settings.translationMin * 100, 0)}% of ${fmt(
          settings.baseThickness,
          1
        )}).` +
        (settings.translationMin > 1
          ? " Pen edge is above the vertical target, so the contrast is inverted."
          : "");
    }

    if (this.translationSection) {
      this.translationSection.style.display =
        settings.modelType === "translation" ? "flex" : "none";
    }
    if (this.expansionSection) {
      this.expansionSection.style.display =
        settings.modelType === "expansion" ? "flex" : "none";
    }
    if (this.monolineSection) {
      this.monolineSection.style.display =
        settings.modelType === "monoline" ? "block" : "none";
    }
    if (this.modelHelp) {
      this.modelHelp.textContent =
        settings.modelType === "translation"
          ? "A broad nib held at a fixed angle: thickness changes with stroke direction, not pressure."
          : settings.modelType === "expansion"
            ? "Set the vertical and horizontal targets directly; diagonal strokes blend between them."
            : "A single target width at every angle. Useful for checking optical weight.";
    }

    const deviationMode =
      settings.displayMode === "deviation" || settings.displayMode === "outliers";
    if (this.scaleSection) {
      this.scaleSection.style.display = deviationMode ? "flex" : "none";
    }
    if (this.toleranceSection) {
      // Tolerance is a deviation concept; target and measured modes show
      // absolute thickness and have no neutral band.
      this.toleranceSection.style.display = deviationMode ? "flex" : "none";
    }
    if (this._controls.paletteSelect?.closest(".field-row")) {
      this._controls.paletteSelect.closest(".field-row").style.display =
        deviationMode ? "grid" : "none";
    }

    if (!settings.enabled && this._guideDrawing) {
      this._stopGuideDrawing();
    }
    if (this._controls.guideModeSelect) {
      this._controls.guideModeSelect.value = settings.flowGuideMode;
      this._controls.guideModeSelect.disabled =
        !settings.useFlowGuides || !settings.enabled;
    }
    if (this._controls.useGuidesCheckbox) {
      this._controls.useGuidesCheckbox.checked = settings.useFlowGuides;
    }
    if (this._controls.showGuidesCheckbox) {
      this._controls.showGuidesCheckbox.checked = settings.showFlowGuides;
    }
    if (this.guideHelp) {
      this.guideHelp.textContent =
        settings.flowGuideMode === "along"
          ? "Draw down the middle of a stroke. The line’s own direction becomes the stroke flow."
          : "Draw across a stroke. The ink span along the line becomes a manual thickness reading, and the perpendicular becomes the stroke flow.";
    }
    if (this._controls.drawGuideButton) {
      this._controls.drawGuideButton.disabled =
        !settings.enabled || !this._selectedGlyphName();
    }

    this._applyLayerEnabled(settings.enabled);
    this._updateElementStatus(thicknessEngine.lastAnalysis);
    this._updateGuideStatus();
  }

  _applyLayerEnabled(enabled) {
    const value = enabled !== false;
    const layers = this.editorController?.visualizationLayers;
    const settingsModel =
      this.editorController?.visualizationLayersSettings?.model;

    // Fontra listens to its visualization-layer settings model and toggles the
    // layer from there. Update both that model and the visible set, so a layer
    // left visible by a hot reload is also switched off.
    if (settingsModel && settingsModel[LAYER_ID] !== value) {
      settingsModel[LAYER_ID] = value;
    }
    const visible = layers?.visibleLayerIds;
    if (visible) {
      const isVisible = visible.has(LAYER_ID);
      if (isVisible !== value) {
        const next = new Set(visible);
        if (value) {
          next.add(LAYER_ID);
        } else {
          next.delete(LAYER_ID);
        }
        layers.visibleLayerIds = next;
      }
    }

    if (this._appliedEnabled !== value) {
      this._appliedEnabled = value;
      layers?.requestUpdate?.();
      this.editorController?.canvasController?.requestUpdate();
    }
  }

  _updateLegend() {
    if (!this.legendBar) {
      return;
    }
    const settings = normalizeSettings(this.model);
    const analysis = thicknessEngine.lastAnalysis;
    const legend = analysis
      ? legendModel(analysis, settings)
      : {
          kind: "diverging",
          min: -settings.scaleRange,
          max: settings.scaleRange,
          title: "Deviation",
          units: "%",
          tolerance: settings.tolerance,
        };

    const [left, middle, right] = this.legendLabels.children;
    if (legend.kind === "sequential") {
      this.legendBar.style.background = sequentialGradientCSS("viridis");
      this.legendTolerance.style.display = "none";
      this.legendTitle.children[0].textContent = legend.title;
      this.legendTitle.children[1].textContent = "units";
      left.textContent = fmt(legend.min, 0);
      middle.textContent = fmt((legend.min + legend.max) / 2, 0);
      right.textContent = fmt(legend.max, 0);
      this.legendNote.textContent =
        settings.displayMode === "measured"
          ? "Measured caliper width, independent of the pen model. Tolerance applies only in deviation modes."
          : "Thickness predicted by the current pen model. Tolerance applies only in deviation modes.";
    } else {
      this.legendBar.style.background = deviationGradientCSS(settings.palette);
      const tolerance = legend.tolerance ?? settings.tolerance;
      const bandWidth = Math.min(
        100,
        (2 * tolerance) / Math.max(settings.scaleRange, 1e-6) * 100
      );
      this.legendTolerance.style.display = bandWidth > 0.2 ? "block" : "none";
      this.legendTolerance.style.left = `${50 - bandWidth / 2}%`;
      this.legendTolerance.style.width = `${bandWidth}%`;
      this.legendTitle.children[0].textContent = legend.title;
      this.legendTitle.children[1].textContent = "deviation";
      left.textContent = `${signed(legend.min, 0)}%`;
      middle.textContent = "0%";
      right.textContent = `${signed(legend.max, 0)}%`;
      this.legendNote.textContent =
        settings.displayMode === "outliers"
          ? "Only deviations beyond the tolerance band are shown strongly; the neutral band and low-confidence areas fade back."
          : settings.palette === "accessible"
            ? "Cool = thinner than model; warm = thicker. The tolerance band is kept faint and neutral, and low-confidence areas fade back."
            : "Blue = thinner than model; red = thicker. The tolerance band is kept faint and neutral, and low-confidence areas fade back.";
    }
  }

  _updateStats(analysis) {
    if (!this.statsElement) {
      return;
    }
    if (!analysis || !analysis.stats?.count) {
      this.statsElement.replaceChildren(
        div({ class: "empty-stats" }, [
          "Select an editing glyph with ink to see measurements.",
        ])
      );
      return;
    }

    const stats = analysis.stats;
    const rows = [
      ["Measured median", `${fmt(stats.actualMedian, 1)} units`],
      ["Model target", `${fmt(stats.targetMedian, 1)} units`],
      ["Median deviation", `${signed(stats.deviationMedian, 1)}%`],
      [
        "Deviation range",
        `${signed(stats.deviationP10, 0)} … ${signed(stats.deviationP90, 0)}%`,
      ],
      ["Within tolerance", `${fmt(stats.withinPercent, 0)}%`],
      [
        "Thicker / thinner",
        `${fmt(stats.thickPercent, 0)}% / ${fmt(stats.thinPercent, 0)}%`,
      ],
      ["Contour samples", stats.count.toLocaleString()],
    ];

    if (analysis.elements?.length) {
      rows.push(["Elements measured", analysis.elements.length.toLocaleString()]);
    }

    this.statsElement.replaceChildren(
      ...rows.flatMap(([labelText, value]) => [
        div({ class: "stat-label" }, [labelText]),
        div({ class: "stat-value" }, [value]),
      ])
    );

  }

  _updateElementStatus(analysis) {
    if (!this.elementStatus) {
      return;
    }
    const settings = normalizeSettings(this.model);
    if (!settings.perElement) {
      this.elementStatus.textContent =
        "Whole-glyph measurement. Turn this on to measure each contour and component separately.";
      return;
    }
    if (!analysis?.elements?.length) {
      this.elementStatus.textContent = "No elements with ink to measure.";
      return;
    }
    const count = analysis.elements.length;
    const noun = count === 1 ? "element" : "elements";
    const hint =
      settings.elementFocus === "selected"
        ? " Select points or a component in the glyph to focus it."
        : settings.elementFocus === "hovered"
          ? " Hover an element in the glyph to focus it."
          : " All elements are shown.";
    this.elementStatus.textContent = `${count} ${noun} measured independently.${hint}`;
  }

  _selectedGlyphName() {
    const sceneController = this.editorController?.sceneController;
    const selectedGlyph = sceneController?.sceneSettings?.selectedGlyph;
    if (selectedGlyph && !selectedGlyph.isEditing) {
      return null;
    }
    return (
      sceneController?.getSelectedGlyphName?.() ??
      sceneController?.sceneModel?.getSelectedGlyphName?.() ??
      sceneController?.sceneSettings?.selectedGlyphName ??
      null
    );
  }

  getFlowGuidesForGlyphName(glyphName) {
    if (!this._guideStore) {
      return [];
    }
    return this._guideStore.get(glyphName || this._selectedGlyphName());
  }

  _guidePixelUnit() {
    return this.editorController?.canvasController?.onePixelUnit || 1;
  }

  _requestGuideUpdate() {
    this.editorController?.canvasController?.requestUpdate?.();
    this.editorController?.visualizationLayers?.requestUpdate?.();
  }

  _setupGuideDrawing() {
    const canvas = this.editorController?.canvasController?.canvas;
    if (!canvas || canvas[GUIDE_CANVAS_BOUND]) {
      return;
    }
    canvas[GUIDE_CANVAS_BOUND] = true;
    this._guideCanvas = canvas;
    this._boundGuideMouseDown = (event) => this._handleGuideMouseDown(event);
    this._boundGuideMouseMove = (event) => this._handleGuideMouseMove(event);
    this._boundGuideMouseUp = (event) => this._handleGuideMouseUp(event);
    this._boundGuideKeyDown = (event) => this._handleGuideKeyDown(event);
    this._boundGuideWindowBlur = () => {
      if (!this._guideDraft) {
        return;
      }
      this._guideDraft = null;
      this._guideDraftGlyphName = null;
      this._requestGuideUpdate();
      this._updateGuideStatus();
    };

    // Capture-phase listeners keep Fontra's own tools from seeing the drag.
    canvas.addEventListener("mousedown", this._boundGuideMouseDown, true);
    window.addEventListener("mousemove", this._boundGuideMouseMove, true);
    window.addEventListener("mouseup", this._boundGuideMouseUp, true);
    window.addEventListener("keydown", this._boundGuideKeyDown, true);
    window.addEventListener("blur", this._boundGuideWindowBlur, true);
  }

  _glyphPointFromEvent(event) {
    const sceneController = this.editorController?.sceneController;
    const point = sceneController?.selectedGlyphPoint?.(event);
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      return null;
    }
    return { x: point.x, y: point.y };
  }

  _handleGuideMouseDown(event) {
    if (!this._guideDrawing || event.button !== 0) {
      return;
    }
    const glyphName = this._selectedGlyphName();
    const point = this._glyphPointFromEvent(event);
    if (!glyphName || !point) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this._guideDraftGlyphName = glyphName;
    this._guideDraft = [point];
    this._requestGuideUpdate();
  }

  _handleGuideMouseMove(event) {
    if (!this._guideDrawing || !this._guideDraft) {
      return;
    }
    const point = this._glyphPointFromEvent(event);
    if (!point) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();

    const start = this._guideDraft[0];
    if (event.shiftKey) {
      // Shift gives a clean straight cross-section, which is usually what a
      // manual caliper wants.
      this._guideDraft = [start, point];
    } else {
      const last = this._guideDraft[this._guideDraft.length - 1];
      const minimumStep = this._guidePixelUnit() * 1.2;
      if (Math.hypot(point.x - last.x, point.y - last.y) >= minimumStep) {
        this._guideDraft.push(point);
      }
    }
    this._requestGuideUpdate();
  }

  _handleGuideMouseUp(event) {
    if (!this._guideDrawing || !this._guideDraft) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    this._finishGuideDraft();
  }

  _handleGuideKeyDown(event) {
    if (!this._guideDrawing || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (this._guideDraft) {
      this._guideDraft = null;
      this._guideDraftGlyphName = null;
      this._requestGuideUpdate();
      this._updateGuideStatus();
    } else {
      this._stopGuideDrawing();
    }
  }

  _finishGuideDraft() {
    const rawPoints = this._guideDraft || [];
    const glyphName =
      this._guideDraftGlyphName || this._selectedGlyphName() || null;
    this._guideDraft = null;
    this._guideDraftGlyphName = null;

    const pixelUnit = this._guidePixelUnit();
    const points = simplifyFlowGuide(rawPoints, pixelUnit * 1.25);
    if (
      !glyphName ||
      points.length < 2 ||
      flowGuideLength(points) < pixelUnit * 6
    ) {
      this._requestGuideUpdate();
      this._updateGuideStatus();
      if (this.guideStatus) {
        this.guideStatus.textContent =
          "Guide was too short. Drag across a stroke, or hold Shift for a straight line.";
      }
      return;
    }

    this._guideStore.add(glyphName, points);
    this.statusLine.textContent = `Added a flow guide to “${glyphName}”.`;
    this._requestGuideUpdate();
    this._updateGuideStatus();
  }

  _toggleGuideDrawing() {
    if (this._guideDrawing) {
      this._stopGuideDrawing();
    } else {
      this._startGuideDrawing();
    }
  }

  _startGuideDrawing() {
    if (this.model.enabled === false) {
      this.statusLine.textContent = "Turn the heatmap on before drawing guides.";
      return;
    }
    if (!this._selectedGlyphName()) {
      this.statusLine.textContent = "Select an editing glyph first.";
      return;
    }
    this._guideDrawing = true;
    if (this._guideCanvas) {
      this._previousGuideCursor = this._guideCanvas.style.cursor;
      this._guideCanvas.style.cursor = "crosshair";
    }
    this._requestGuideUpdate();
    this._updateGuideStatus();
  }

  _stopGuideDrawing() {
    this._guideDrawing = false;
    this._guideDraft = null;
    this._guideDraftGlyphName = null;
    if (this._guideCanvas) {
      this._guideCanvas.style.cursor = this._previousGuideCursor || "";
    }
    this._requestGuideUpdate();
    this._updateGuideStatus();
  }

  _undoLastGuide() {
    const glyphName = this._selectedGlyphName();
    if (!glyphName) {
      return;
    }
    this._guideStore.undoLast(glyphName);
    this._requestGuideUpdate();
    this._updateGuideStatus();
  }

  _clearGuides() {
    const glyphName = this._selectedGlyphName();
    if (!glyphName) {
      return;
    }
    this._guideStore.clear(glyphName);
    this._requestGuideUpdate();
    this._updateGuideStatus();
  }

  _updateGuideStatus() {
    if (!this.guideStatus || !this._guideStore) {
      return;
    }
    const glyphName = this._selectedGlyphName();
    const guides = glyphName ? this._guideStore.get(glyphName) : [];
    const count = guides.length;
    const noun = count === 1 ? "guide" : "guides";

    if (!glyphName) {
      this.guideStatus.textContent = "Select an editing glyph to draw guides.";
    } else if (this._guideDrawing) {
      this.guideStatus.textContent = count
        ? `${count} ${noun} on “${glyphName}”. Drag to add another; Esc finishes.`
        : `Drag across the stroke on “${glyphName}”. Hold Shift for a straight line; Esc finishes.`;
    } else if (count) {
      this.guideStatus.textContent = `${count} ${noun} on “${glyphName}”.`;
    } else {
      this.guideStatus.textContent = `No flow guides on “${glyphName}”.`;
    }

    if (this._controls.drawGuideButton) {
      const drawButton = this._controls.drawGuideButton;
      drawButton.textContent = this._guideDrawing ? "Done drawing" : "Draw guides";
      drawButton.classList.toggle("active", this._guideDrawing);
      drawButton.disabled = !glyphName || this.model.enabled === false;
    }
    if (this._controls.undoGuideButton) {
      this._controls.undoGuideButton.disabled = !count;
    }
    if (this._controls.clearGuideButton) {
      this._controls.clearGuideButton.disabled = !count;
    }
  }

  drawFlowGuides(context, positionedGlyph, glyphName) {
    if (!context) {
      return;
    }
    const name = glyphName || this._selectedGlyphName();
    if (!name) {
      return;
    }
    const showGuides = this.model.showFlowGuides !== false;
    const draft =
      this._guideDraft && this._guideDraftGlyphName === name
        ? this._guideDraft
        : null;
    const guides = showGuides ? this._guideStore.get(name) : [];
    const allGuides = draft && draft.length >= 2
      ? [...guides, draft]
      : guides;
    if (!allGuides.length) {
      return;
    }

    const pixelUnit = this._guidePixelUnit();
    // The visualization layer has already translated the context to this
    // positioned glyph, so guide points are used directly in glyph coordinates.
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";

    const traceGuide = (points) => {
      context.beginPath();
      context.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        context.lineTo(points[i].x, points[i].y);
      }
      context.stroke();
    };

    // A light halo keeps the blue guides readable over both warm and cool
    // heatmap colors.
    context.strokeStyle = "rgba(255, 255, 255, 0.88)";
    context.lineWidth = GUIDE_HALO_WIDTH * pixelUnit;
    for (const points of allGuides) {
      traceGuide(points);
    }

    context.strokeStyle = "#0a84ff";
    context.lineWidth = GUIDE_LINE_WIDTH * pixelUnit;
    for (const points of guides) {
      traceGuide(points);
    }
    if (draft && draft.length >= 2) {
      context.setLineDash([5 * pixelUnit, 4 * pixelUnit]);
      traceGuide(draft);
      context.setLineDash([]);
    }

    context.lineWidth = Math.max(1, 1.4 * pixelUnit);
    for (const points of allGuides) {
      for (const point of [points[0], points[points.length - 1]]) {
        context.beginPath();
        context.arc(
          point.x,
          point.y,
          GUIDE_HANDLE_RADIUS * pixelUnit,
          0,
          Math.PI * 2
        );
        context.fillStyle = "#fff";
        context.fill();
        context.strokeStyle = "#0a84ff";
        context.stroke();
      }
    }

    context.restore();
  }

  _fitThicknesses() {
    const positionedGlyph =
      this.editorController.sceneController?.sceneModel?.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      this.statusLine.textContent = "Select an editing glyph first.";
      return;
    }
    const glyphName =
      positionedGlyph?.glyph?.name ?? this._selectedGlyphName();
    const estimate = thicknessEngine.fitThicknesses(
      positionedGlyph,
      this.model,
      { flowGuides: this.getFlowGuidesForGlyphName(glyphName) }
    );
    if (!estimate?.vertical) {
      this.statusLine.textContent =
        "Could not find a reliable near-vertical stroke; adjust the thickness manually.";
      return;
    }
    const vertical = Math.max(0.1, Math.round(estimate.vertical * 10) / 10);
    this.model.baseThickness = vertical;
    if (this._controls.baseInput) {
      this._controls.baseInput.value = vertical;
    }

    let message = `Vertical thickness set to ${vertical} units`;
    if (estimate.horizontal) {
      const horizontal = Math.max(
        0.1,
        Math.round(estimate.horizontal * 10) / 10
      );
      // Keep the horizontal estimate ready for the expansion model, but don't
      // claim to have changed a control the current model doesn't use.
      this.model.expansionHorizontal = horizontal;
      if (this._controls.horizontalInput) {
        this._controls.horizontalInput.value = horizontal;
      }
      if (this.model.modelType === "expansion") {
        message += `; horizontal set to ${horizontal} units`;
      }
    }
    this.statusLine.textContent = `${message}.`;
    this.editorController.canvasController.requestUpdate();
  }

  _resetSettings() {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      this.model[key] = value;
    }
    this._syncControls();
    this.editorController.canvasController.requestUpdate();
  }
}
