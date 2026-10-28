import {
  glyphSelector,
  registerVisualizationLayerDefinition,
  visualizationLayerDefinitions,
} from "fontra/editor/visualization-layer-definitions.js";

import { LAYER_ID, PANEL_IDENTIFIER } from "./src/constants.js";
import { thicknessEngine } from "./src/engine.js";
import ThicknessHeatmapPanel from "./src/panel.js";

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

  if (!visualizationLayerDefinitions.some((layer) => layer.identifier === LAYER_ID)) {
    registerVisualizationLayerDefinition({
      identifier: LAYER_ID,
      name: "Thickness heatmap",
      selectionFunc: glyphSelector("editing"),
      userSwitchable: true,
      defaultOn: true,
      zIndex: 300,
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
    });
  }

  // The visualization-layers object was created before this plugin registered
  // its layer, so make sure the new layer is both visible and included in the
  // next layer build.
  const layers = editorController.visualizationLayers;
  if (layers) {
    layers.visibleLayerIds = new Set([...layers.visibleLayerIds, LAYER_ID]);
  }
  editorController.visualizationLayersSettings.model[LAYER_ID] = true;
  editorController.canvasController.requestUpdate();
}
