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
import { PANEL_IDENTIFIER } from "./constants.js";

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
    };
    thicknessEngine.addListener(this._analysisListener);
    this._updateStats(thicknessEngine.lastAnalysis);
    this._updateLegend();
    this._syncControls();
  }

  get model() {
    return this.controller.model;
  }

  getContentElement() {
    this.controller = new ObservableController({ ...DEFAULT_SETTINGS });
    this.controller.synchronizeWithLocalStorage("fontra.thickness-heatmap.");

    this._sliders = {};
    this._controls = {};

    const icon = span({ class: "panel-icon", "aria-hidden": "true" }, ["◒"]);
    const title = div({ class: "title" }, ["Thickness heatmap"]);
    const subtitle = div({ class: "subtitle" }, [
      "Compare the drawing with a Noordzij-style pen model.",
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
      label({ class: "checkbox-row" }, [
        fadeCheckbox,
        span({}, ["Fade low-confidence areas (junctions, serifs, hairlines)"]),
      ]),
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
          "The tolerance band keeps small optical corrections faint and neutral, and uncertain " +
          "junction/serif areas are faded or gray.",
        "Careful mode checks each stroke from both sides, which rejects chords across " +
          "curves and junctions. It is slower; turn it off when you only need a quick read.",
        "This is a lens, not a judge. A bowl that is deliberately lighter than a stem, " +
          "an S spine that is deliberately heavier, or the thin right side of a V is expected " +
          "to show as a deviation. Read the pattern, not individual pixels.",
      ]),
    ]);

    const panel = div({ class: "heatmap-panel" }, [
      div({}, [div({ style: "display:none" }, [icon]), title, subtitle]),
      modelSection,
      displaySection,
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

    requestAnimationFrame(() => this._syncControls());

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
      this._controls.paletteSelect.disabled =
        settings.displayMode === "target" || settings.displayMode === "measured";
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

    this.statsElement.replaceChildren(
      ...rows.flatMap(([labelText, value]) => [
        div({ class: "stat-label" }, [labelText]),
        div({ class: "stat-value" }, [value]),
      ])
    );

  }

  _fitThicknesses() {
    const positionedGlyph =
      this.editorController.sceneController?.sceneModel?.getSelectedPositionedGlyph();
    if (!positionedGlyph) {
      this.statusLine.textContent = "Select an editing glyph first.";
      return;
    }
    const estimate = thicknessEngine.fitThicknesses(positionedGlyph, this.model);
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
