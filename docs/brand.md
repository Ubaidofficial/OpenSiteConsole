# Brand

The logo and icon files.

[Back to the README](../README.md)

## Brand

The logo is a magnifier holding three rising bars, in graphite chrome on a white tile (a dark twin exists). Files in `static/brand/`:

| File | Use |
|---|---|
| `logo-light.svg`, `logo-dark.svg` | The full icon with its tile, for sizes of about 64 px and up: README, docs, slides, social images, the login page. |
| `mark-light.svg`, `mark-dark.svg` | The simplified icon (lens and bars only, thicker), for 16 to 48 px: the favicon and tiny tiles. The sparkle disappears at those sizes, so it is left out. |
| `mark-glyph.svg` | The glyph with no tile, for the app header on a light page. |
| `banner.png` | The README banner (rendered with the Inter font). |

The browser-tab icons, the Apple touch icon and the home-screen icons in `static/` (`favicon.svg`, `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`) were rendered from these SVGs; the Apple and maskable ones are full-bleed squares because iOS and Android round the corners themselves. A test checks that every file exists, is the right size and is referenced. **The logo has not been checked against existing logos or trademarks.**
