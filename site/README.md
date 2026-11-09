# seoconsole.app: the marketing site

A one-page static site (HTML, CSS and a little JavaScript, no framework, no build step, no third-party requests). The screenshots are the real app running on its built-in demo data.

## Preview

```bash
cd site && python3 -m http.server 4300
```

Then open http://localhost:4300.

## Deploy

Any static host works: upload the folder as it is. To run it on your own server, build the Docker image from this folder (nginx, non-root, strict security headers, port 8080):

```bash
docker build -t seoconsole-site site/
docker run --rm -p 8080:8080 seoconsole-site
```

**On Coolify:** add a resource from the same repository with the *Dockerfile* build pack, base directory `/site`, exposed port `8080`, and your domain. **The Docker build has not been run in the environment this was written in** (no Docker there), so check the first build.

## The domain

`seoconsole.app` currently serves the dashboard itself. The page's canonical address, Open Graph tags, `robots.txt` and `sitemap.xml` all assume the **site lives at `https://seoconsole.app/`**. If you put the site elsewhere (for example `www.`), change those four places. Putting the site on the bare domain means moving the dashboard to another name such as `app.seoconsole.app`, which also changes the MCP connector address and the Google redirect address.

## How it works

- `assets/main.js` drives everything that moves: the dashboard screenshot tilts flat as you scroll (a `--p` value from 0 to 1), sections fade in, charts draw and numbers count up, the six-step story is a short list to click through on wide screens (it moves on by itself every 7 seconds while on screen, pauses while the pointer is over it, stops for good once you pick a step, and never moves for visitors who ask for less motion; on phones each step shows its own screenshot), and the agent terminal types itself once. It also runs the few controls: the toolkit's four tabs (Analyse, Fix and index, AI search, Report and connect; arrow keys move between them), the comparison's *Show all 20 rows* (the ten rows that decide most choices show first), and the menu, which marks the section on screen. Without JavaScript every toolkit group is shown under its own heading and the whole table is open. Motion is switched off for visitors who ask their system for reduced motion, and the page is complete with JavaScript off.
- The agent conversation uses real output from the app's MCP tools on the demo data (`get_action_queue`, `get_opportunities`). The assistant's wording is an example, and the page says so.
- Nothing is loaded from another site: the font is self-hosted and there are no analytics, so the strict policy in `security-headers.conf` (default-src 'self') holds.

## Caching

`index.html` is never cached (`no-cache`); everything under `assets/` is cached for a day. The stylesheet and script are linked as `styles.css?v=…` and `main.js?v=…`, where the value is the first 10 hex characters of the file's SHA-256, so visitors get a changed file as soon as the new page is deployed. After editing either file, update its `?v=` (`tests/site.test.ts` fails and prints the new value).

## Refreshing the screenshots

They are static WebP files in `assets/shots/` (two sizes each), made by a script so they can be redone the same way when the app's look changes:

1. Start the app with `DEMO_MODE=1` and a fresh database (`pnpm serve`, on `http://localhost:5173`).
2. `node site/tools/capture-shots.cjs`: connects the demo Bing, GA4, Tag Manager, Clarity and Web Vitals sources, seeds one SEO test, two indexing checks and a weekly digest (so no screen shows an empty state), then captures each view.
3. `python3 site/tools/to-webp.py` (needs Pillow): writes the large and 1080 px files into `assets/shots/`.

Each capture hides the app's own header and tab bar and is clipped to whole rows and tables, so nothing is cut off at the edge. The six story frames are 16:10 and shown whole (no zoom). If a capture changes size, update the `width`/`height` on its `<img>` tags. `tests/site.test.ts` checks the story frames stay 16:10.

The hidden-win cards quote example rows from the demo data. Demo data is generated relative to today's date, so these rows can drift; re-check them against the app when you refresh the screenshots.

## What the page does not claim

No customer counts, testimonials or ratings, because there are none. The hosted plan is shown as planned, not available. The logo and the name have not been checked against existing trademarks.

## The visuals

There are no illustrations or stock images. The hero's ranked list, the eight "hidden win" charts, the portfolio table and the toolkit cards are plain HTML and inline SVG, drawn from numbers in the app's demo data (read through its MCP tools; the sparklines are the real daily click series). Each card says "Demo data" or "Illustration, not real data". Demo data is generated relative to today's date, so these numbers drift: when you refresh the screenshots, re-read them (`get_action_queue`, `get_portfolio`, `get_ai_traffic`, `get_web_vitals`, `get_sitemap_coverage`, `get_opportunities`) and update the page.

Motion: charts draw, bars grow and counters count up once, when they scroll into view. The starting states only exist with JavaScript on and before an element is revealed (`html.js … :not(.in)`, checked by `tests/site.test.ts`), so the page is complete without JavaScript, and with reduced motion everything is shown still and finished. The portfolio's privacy switch is a real button: it blurs the site names the way the app's privacy mode does, and shows itself once when the card first appears.

## Product logos

`assets/logos/` holds the logos of the products SEOConsole works with, saved locally because the page loads nothing from other sites. Each is shown at a small size next to the product's name, unchanged, only to say what SEOConsole connects to. The footer says the names and logos belong to their owners and that SEOConsole is not affiliated with or endorsed by them. **Check each brand's own guidelines before launch**; some brands restrict how their logos may be used.

| File | Source |
|---|---|
| `search-console.svg` | The 2025 Google Search Console logo (Wikimedia Commons, `Google_Search_Console_Logo_2025.svg`), cropped to the icon |
| `ga4.svg`, `tag-manager.svg` | Google's own icons (`gstatic.com/analytics-suite/header/suite/v2/ic_analytics.svg`, `ic_tag_manager.svg`) |
| `bing.svg`, `chrome.svg` | Wikimedia Commons (`Bing_Fluent_Logo.svg`, `Google_Chrome_icon_(February_2022).svg`) |
| `clarity.png` | Microsoft Clarity's own favicon (`claritystatic.azureedge.net/images/logo.ico`), resized to 64 px |
| `mcp.svg`, `claude.svg`, `claude-code.svg` | [Simple Icons](https://simpleicons.org) (CC0 for the drawings; the marks remain their owners' trademarks), in the brand colour Simple Icons lists |
| `openai.svg` (ChatGPT and Codex) | The 2025 OpenAI symbol (Wikimedia Commons, `OpenAI_logo_2025_(symbol).svg`) |
| `cursor.svg`, `windsurf.svg` | Simple Icons, as above |
| `perplexity.svg`, `gemini.svg`, `copilot.svg` (Microsoft Copilot), `google.svg` | [LobeHub Icons](https://github.com/lobehub/lobe-icons) (`@lobehub/icons-static-svg` 1.102.0, MIT for the drawings; the marks remain their owners' trademarks), the `-color` variants, with the inline `style` attribute removed so they pass the strict style policy |

The app shows the same AI-app marks on its MCP page from `static/logos/` (copies of these files). The black ones are inverted in dark mode.

IndexNow has no logo other than a text favicon that is unreadable at this size, and OpenSEO has no public logo, so both are named in text only.

The link-preview image `assets/og.png` is drawn from `tools/og.html`. Rebuild it with `node site/tools/render-og.cjs` after changing the screenshots or logos.

## Credits

Four motion patterns are adapted from [Shadcn Space](https://github.com/shadcnspace/shadcnspace): the animated beam (the "Works with" data-flow diagram), the blur-in text reveal (section headings), the animated list (the alerts in the digest card) and the shine border (the free plan). The originals are React components built on the `motion` library; here they are rebuilt in plain CSS and a few lines of `assets/main.js`, because the page loads no framework and nothing from another site. Like the rest of the page's motion, all four stop for visitors who ask their system for reduced motion, and the beam and the list only run while they are on screen.

Shadcn Space is published under the MIT License:

> MIT License
>
> Copyright (c) 2026 Shadcn Space
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
