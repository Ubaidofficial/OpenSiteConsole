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

They are static WebP files in `assets/shots/` (two sizes each). When the app's look changes: run the app with `DEMO_MODE=1`, connect the demo Bing, GA4, Tag Manager, Clarity and Web Vitals sources on the Connect page (type `demo` as the key), screenshot the pages at 1440 x 900, and convert to WebP at 2160 and 1080 pixels wide.

## What the page does not claim

No customer counts, testimonials or ratings, because there are none. The hosted plan is shown as planned, not available. The logo and the name have not been checked against existing trademarks.
