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

- `assets/main.js` drives everything that moves: the hero product tilts flat as you scroll (a `--p` value from 0 to 1), sections fade in, the six-step story swaps its screenshot as each step reaches the middle of the screen, and the agent terminal types itself once. Motion is switched off for visitors who ask their system for reduced motion, and the page is complete with JavaScript off.
- The agent conversation uses real output from the app's MCP tools on the demo data (`get_action_queue`, `get_opportunities`). The assistant's wording is an example, and the page says so.
- Nothing is loaded from another site: the font is self-hosted and there are no analytics, so the strict policy in `security-headers.conf` (default-src 'self') holds.

## Refreshing the screenshots

They are static WebP files in `assets/shots/` (two sizes each), made by a script so they can be redone the same way when the app's look changes:

1. Start the app with `DEMO_MODE=1` and a fresh database (`pnpm serve`, on `http://localhost:5173`).
2. `node site/tools/capture-shots.cjs`: connects the demo Bing, GA4, Tag Manager, Clarity and Web Vitals sources, seeds one SEO test, two indexing checks and a weekly digest (so no screen shows an empty state), then captures each view.
3. `python3 site/tools/to-webp.py` (needs Pillow): writes the large and 1080 px files into `assets/shots/`.

Each capture hides the app's own header and tab bar and is clipped to whole rows and tables, so nothing is cut off at the edge. The six story frames are 16:10 and shown whole (no zoom). If a capture changes size, update the `width`/`height` on its `<img>` tags. `tests/site.test.ts` checks the story frames stay 16:10.

The hidden-win cards quote example rows from the demo data. Demo data is generated relative to today's date, so these rows can drift; re-check them against the app when you refresh the screenshots.

## What the page does not claim

No customer counts, testimonials or ratings, because there are none. The hosted plan is shown as planned, not available. The logo and the name have not been checked against existing trademarks.

## The pixel art

Every illustration on the page (the dig site in the hero, the eight "hidden win" scenes, the many-sites and agent pictures, the landscape behind the dashboard) is drawn by [`art/make_art.py`](art/make_art.py) with a fixed palette and seed, and written to `assets/art/`. Run `python3 site/art/make_art.py` (needs Pillow) to regenerate them. Several are sprite sheets: the stylesheet steps through their frames with `steps()`, only while they are on screen, and shows the first frame for people who ask for less motion. `tests/site.test.ts` checks that each sprite's width is a whole number of its frames and that no image goes unused.
