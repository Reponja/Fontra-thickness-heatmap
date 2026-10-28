import { LAYER_ID, PANEL_IDENTIFIER } from "./src/constants.js";
import { thicknessEngine } from "./src/engine.js";
import ThicknessHeatmapPanel from "./src/panel.js";

const LAYER_Z_INDEX = 300;

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

  if (!definitions.some((layer) => layer.identifier === LAYER_ID)) {
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
        const analysis = thicknessEngine.getAnalysis(positionedGlyph, settings);
        if (!analysis) {
          return;
        }
        const image = thicknessEngine.getImage(analysis, settings);
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

  // The visualization-layers object was created before this plugin registered
  // its layer, so make sure the new layer is both visible and included in the
  // next layer build.
  if (layers.visibleLayerIds) {
    layers.visibleLayerIds = new Set([...layers.visibleLayerIds, LAYER_ID]);
  }
  const settingsModel = editorController.visualizationLayersSettings?.model;
  if (settingsModel) {
    settingsModel[LAYER_ID] = true;
  }
  layers.requestUpdate?.();
  editorController.canvasController?.requestUpdate();
}
