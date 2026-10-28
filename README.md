# Fontra thickness heatmap

A [Fontra](https://fontra.xyz) plugin that turns stroke-weight variation into a
readable heatmap. It compares the **actual outline thickness** of the glyph you
are editing with a **Noordzij-style pen model**, and shows where the drawing is
lighter, heavier, or close to the model.

The point is not to “correct” optical work. Bowls, spines, junctions, and
terminals are often deliberately off-model. The heatmap is a lens for seeing
the pattern, not a linter.

![The standalone demo shows the deviation map and legend](demo/preview.png)

## Install

In Fontra’s plugin manager, add this GitHub repository as a plugin:

```
Reponja/Fontra-thickness-heatmap
```

Then confirm the installation. A **Thickness heatmap** panel appears in the
right sidebar, and a visualization layer with the same name is enabled for the
glyph being edited. The overlay can also be switched off from Fontra’s
appearance menu without closing the panel.

To run the plugin from a local server instead, serve this repository at a URL
(such as `http://localhost:8000`) and add that URL in the plugin manager.

The plugin is self-contained: it does not import Fontra’s internal modules.
Fontra’s built client ships webpack bundles, so paths such as
`/editor/visualization-layer-definitions.js` do not exist on the server. A
plugin that imports `fontra/...` gets a 404 that the browser reports as a
disallowed MIME type (`text/plain`). This plugin talks to the editor through
the controller API instead, so it works with bundled Fontra builds, including
Fontra Pak.

If Fontra still runs an older copy after an update, the CDN is serving a cached
commit. Reinstall the plugin in the plugin manager, or wait for the jsDelivr
cache to expire.

## How to read the map

- **Cool / blue** — the drawing is thinner than the model at that point.
- **Warm / orange or red** — the drawing is thicker than the model.
- **Neutral / faded** — the deviation is inside the tolerance band, or the
  measurement is low-confidence.
- **Low-confidence areas** — stroke ends, sharp corners, junctions, serifs, and
  hairlines. These are faded rather than treated as evidence of a mistake.

The default **tolerance band is ±5%**. Raise it if intentional optical
corrections are dominating the map. The **glyph summary** reports the median
measured thickness, model target, deviation range, and how much of the contour
falls inside the tolerance.

## Pen models

All three models use the vertical stem as the reference thickness. For
translation and monoline, the **Vertical thickness** value is the target for a
vertical stem and every other direction is predicted relative to it. Expansion
also has an explicit **Horizontal thickness**, because expansion is about how
thick your vertical and horizontal strokes are, not about a pen angle.

### Translation (broad nib)

A broad nib held at a fixed angle. The nib angle selects the thin direction;
the stroke gets thicker as it turns toward the nib’s broad axis.

```
f(τ) = m + (1 − m) · |sin(θ − τ)| / |sin(θ − 90°)|
```

- `θ` is the **pen angle**.
- `m` is the **pen-edge thickness** as a fraction of the vertical target.
- `τ` is the local stroke direction, taken from the outline tangent.

The pen edge is defined the way a designer thinks about it: with a 100-unit
vertical target and a 20% pen edge, the thinnest stroke is 20 units. The slider
stops at 100% (a square nib, which gives a monoline result), but the numeric
field accepts higher values. Above 100% the contrast reverses: the direction
parallel to the nib edge becomes thicker than the vertical stem.

With a sharp nib (`m = 0`), a 30° pen angle predicts horizontal strokes at
about 58% of the vertical stem thickness. The default 8% pen edge raises that
to about 61%.

### Expansion (pointed pen)

A pointed pen changes width through pressure rather than a fixed nib angle.
The model therefore takes the two thicknesses a designer actually decides on:
how thick vertical strokes are, and how thick horizontal strokes are.

```
T(τ) = H + (V − H)·sin²τ
f(τ) = T(τ) / V
```

- `V` is the **Vertical thickness** — the target for vertical stems.
- `H` is the **Horizontal thickness** — the target for horizontal strokes.
- `τ` is the local stroke direction; 90° is vertical, 0° is horizontal.

The `sin²` blend keeps the transition smooth and reaches both targets exactly.
With `V = 100` and `H = 25`, a horizontal stroke is predicted at 25 units and a
45° diagonal at 62.5 units. `H` may be larger than `V` if the design has
reverse contrast.

### Monoline

Uses the same target in every direction. Useful for checking whether optical
weight changes are consistent, or as a neutral reference.

## Measurement method

The plugin rasterizes the glyph’s live `flattenedPath2d` at the selected
analysis detail, so components, overlaps, and counters are handled by the
ordinary fill rule.

1. Build a binary ink mask with a small margin, then blur it into a coverage
   field.
2. Find the boundary and compute an exact Euclidean distance transform.
3. At each boundary pixel, derive the inward normal from the coverage-field
   gradient and march inward until the opposite edge.
4. Treat the two opposite edges as a caliper measurement. The local stroke
   direction is the tangent perpendicular to that caliper. Validate the caliper
   with the normal at the opposite edge and with the distance to the medial
   axis; rays that run along a stroke end rather than across it are marked
   low-confidence.
5. In **careful mode**, trace the same stroke back from the opposite edge. A
   real caliper returns to its starting point with a similar width; a chord
   across a curve or a junction does not. The two widths are averaged to get
   the middle ground between the left and right sides of the stroke. Mismatched
   traces are faded instead of becoming false hot spots.
6. Smooth boundary samples spatially and fade sharp turns, which are usually
   junctions, terminals, or corners. Careful mode uses a wider corner window so
   a junction is recognized even when its normals turn gradually over a few
   pixels.
7. Propagate widths from the nearest **confident** boundary sample, so an
   ambiguous junction cannot paint a fan of wrong values into the stroke
   interior. Low-confidence samples still drive the fade field.
8. Smooth the width field, and smooth stroke direction as a doubled-angle
   vector field. The model target is derived from that smoothed direction, so
   the target and deviation fields vary continuously across curves.
9. Render the selected display mode.

A cached analysis keyed by the path and model settings keeps normal editing
interactive. Cosmetic changes such as overlay opacity or display mode reuse the
same analysis.

## Controls

- **Model** — translation, expansion, or monoline.
- **Vertical thickness** — target for vertical stems, in font units.
- **Horizontal thickness** — target for horizontal strokes in the expansion
  model. Diagonal targets blend smoothly between the two.
- **Pen edge thickness** — thinnest stroke as a percentage of the vertical
  target. The slider stops at 100%; type a higher number for inverted contrast.
  The panel shows the computed thinnest thickness in font units.
- **Fit to glyph** — estimates vertical and horizontal targets from the current
  outline using medians, so one odd terminal does not decide the result.
- **Show** — deviation, model target, measured thickness, or outliers only.
- **Deviation colors** — blue/orange (colorblind-friendly) or classic blue/red.
- **Color scale** — the deviation mapped to the strongest color.
- **Tolerance band** — deviations inside this band remain faint and neutral in
  the deviation and outliers views. It has no effect on the absolute target and
  measured views, so the control is hidden there.
- **Overlay opacity** — how strongly the heatmap covers the glyph.
- **Analysis detail** — raster resolution: fast, balanced, or fine.
- **Fade low-confidence areas** — fades junctions, serifs, caps, and hairlines.
- **Careful curve & junction measurement** — traces strokes from both sides and
  rejects chords across curves and junctions. Slower; turn it off for a quick
  read.

## Scope and limitations

- The heatmap analyzes the **currently editing glyph** only. A font-wide audit
  is not part of this version.
- Variable fonts are measured at the current instance location.
- Thickness is measured perpendicular to the outline. Very sharp terminals,
  overlapping strokes, and hairline details can produce ambiguous local
  measurements; the confidence fade is there to keep those from driving the
  statistics. Careful mode reduces false chords at curves and junctions, but it
  cannot make an intentionally off-model stroke look on-model.
- Contrast letters such as **V** often have a deliberately thinner right side.
  That will still show as a deviation from a symmetric pen model; it is a
  property of the design, not a measurement failure.
- There is no automatic outline correction and no recommendation engine. The
  map is diagnostic.
- Latin-style outlines are the initial focus; CJK and highly complex
  calligraphic structures may need tuning of the detail level and confidence
  threshold.

## Development

The core measurement and model code is plain JavaScript with no browser
dependencies, so it can be tested with Node:

```sh
npm test
```

To preview the rendering pipeline without Fontra, serve the repository and open
the standalone demo:

```sh
python -m http.server 8000
# then open http://localhost:8000/demo/
```

The demo rasterizes browser text and runs the same pure analysis and color
mapping code as the plugin. It is intended for quick visual checks and for
developing the color maps.

### Files

- `start.js` — registers the sidebar panel and visualization layer.
- `src/core.js` — model math, masks, distance transforms, caliper measurement,
  confidence, and statistics.
- `src/colormap.js` — diverging/sequential color maps, legends, and RGBA output.
- `src/engine.js` — browser rasterization, caching, and Fontra-facing analysis.
- `src/panel.js` — the sidebar controls, legend, and glyph summary.
- `src/ui.js` — self-contained UI primitives (panel base, DOM helpers, and
  settings persistence) so the plugin does not depend on Fontra’s internal
  module paths.
- `demo/` — standalone browser preview.
- `test/` — Node tests for model math and synthetic masks.

## License

See [LICENSE](LICENSE).
