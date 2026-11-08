# Colorblind Visualizer

A single-page tool for checking images against color vision deficiencies. Load an image and see it side by side under all eight common types of color blindness. You can spread the previews across several screens (or monitors) and inspect details with zoom that stays in sync across every view.

Everything runs in the browser. Images are never uploaded anywhere.

## Run it

Open `index.html` in a recent Chrome, Edge, Firefox or Safari. Opening the file straight from disk works, and so does any static host (for example GitHub Pages: *Settings → Pages → Deploy from branch*).

To serve it locally:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

There is no build step and no dependency. IBM Plex is loaded from Google Fonts when online, with a system-font fallback offline.

## What it does

| Area | Details |
| --- | --- |
| **Input** | *Open image*, drag and drop anywhere, or paste from the clipboard. PNG, JPEG, WebP, GIF, AVIF, BMP and SVG. Transparency is preserved. Images above 3840 × 2160 worth of pixels are simulated at that size. |
| **Views** | Original plus 8 simulations: Protanopia, Protanomaly, Deuteranopia, Deuteranomaly, Tritanopia, Tritanomaly, Achromatopsia, Achromatomaly. |
| **Screens** | Up to 9 screens (tabs), each with its own set of views and its own grid. The same view can appear on any number of screens. The original can too. |
| **Layout** | Columns and rows per screen, each *Auto* or 1–9. Previews always scale to fill the available space. *Auto* picks the grid that shows them largest. If a fixed grid is too small for the selected views, rows are added and the panel says so. |
| **Multiple monitors** | *Open in a new window* opens the current screen in its own window. Drag it to another monitor, press <kbd>F</kbd> for fullscreen and <kbd>H</kbd> to hide the interface. All windows opened this way stay in sync: image, screens, severity, display settings and zoom. |
| **Inspection** | Scroll to zoom and drag to pan. Pinch works on touch screens. Every preview follows the same zoom. Past 3× magnification, pixels are drawn sharp. Hold <kbd>Space</kbd> (or the half-circle button on a preview) to show the original in every view. |
| **Severity** | One slider (0–100 %, default 60 %) for the four partial types. At 100 % they match the complete forms. |
| **Display** | Labels on or off, spacing between previews, backdrop (theme, black, mid grey, white, checkerboard), and theme (system, light, dark). |
| **Export** | Download any single view as a full-resolution PNG, or the whole screen as one labelled PNG in its current grid. |

Settings and screens are saved in the browser (`localStorage`). The image is not saved.

## Keyboard

| Key | Action |
| --- | --- |
| <kbd>1</kbd>–<kbd>9</kbd>, <kbd>←</kbd> <kbd>→</kbd> | Switch screen |
| <kbd>Space</kbd> (hold) | Show the original in every view |
| <kbd>0</kbd> / <kbd>+</kbd> / <kbd>−</kbd> | Reset zoom / zoom in / zoom out |
| Double-click | Zoom to 4× at the cursor, or reset |
| <kbd>F</kbd> | Fullscreen |
| <kbd>H</kbd> | Previews only (hide the interface) |
| <kbd>S</kbd> | Settings panel |
| <kbd>O</kbd> | Open image |
| <kbd>Esc</kbd> | Leave the single-view focus or show the interface again |

## How the simulation works

Pixels are converted from sRGB to linear RGB, transformed, then converted back. All of this happens in a Web Worker, so the page stays responsive. A 4K frame takes roughly 150 ms per view.

| Type | Also called | Model |
| --- | --- | --- |
| Protanopia | Red-blind | Brettel, Viénot & Mollon (1997) |
| Deuteranopia | Green-blind | Brettel, Viénot & Mollon (1997) |
| Tritanopia | Blue-blind | Brettel, Viénot & Mollon (1997) |
| Protanomaly | Red-weak | Machado, Oliveira & Fernandes (2009), by severity |
| Deuteranomaly | Green-weak | Machado, Oliveira & Fernandes (2009), by severity |
| Tritanomaly | Blue-weak | Brettel tritanopia blended with the original by severity (Machado's tritan matrices are known to be inaccurate) |
| Achromatopsia | Monochromacy | Relative luminance, Rec. 709 coefficients |
| Achromatomaly | Partial monochromacy | Original blended toward luminance by severity |

The Brettel matrices use the Smith & Pokorny 1975 cone fundamentals with sRGB primaries and the usual 475/575 nm (protan, deutan) and 485/660 nm (tritan) anchors. They were precomputed for linear sRGB following the [DaltonLens](https://github.com/DaltonLens/DaltonLens-Python) reference implementation (MIT). The output matches it to within one 8-bit level.

References:

- H. Brettel, F. Viénot, J. D. Mollon. *Computerized simulation of color appearance for dichromats.* JOSA A, 1997.
- G. M. Machado, M. M. Oliveira, L. A. F. Fernandes. *A physiologically-based model for simulation of color vision deficiency.* IEEE TVCG, 2009.

## Project layout

```
index.html       Markup, icon sprite
css/style.css    Styles (design tokens at the top; light and dark themes)
js/cvd.js        Simulation core, type catalogue, worker bootstrap
js/app.js        Interface: screens, layout, zoom, window sync, export
```

`js/cvd.js` has no dependency on the interface. `CVD.createCore().simulate(rgbaPixels, 'deuteranomaly', 0.6)` returns the simulated pixels and can be reused elsewhere.
