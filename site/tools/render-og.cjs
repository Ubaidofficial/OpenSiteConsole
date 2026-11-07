/* Renders site/tools/og.html to site/assets/og.png (1200 x 630), the image link previews show. Run from the repository root. */
const { chromium } = require('playwright');
const { resolve } = require('node:path');
(async () => {
	const b = await chromium.launch();
	const p = await b.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
	await p.goto('file://' + resolve('site/tools/og.html'), { waitUntil: 'networkidle' });
	await p.evaluate(() => document.fonts.ready);
	await p.screenshot({ path: 'site/assets/og.png' });
	await b.close();
})();
