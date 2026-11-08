import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm, connectClarity } from '../src/lib/server/connect';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { queueDepth } from '../src/lib/server/jobs';
import { getSite } from '../src/lib/server/clients';
import { trackingHealth } from '../src/lib/server/tracking';
import { actionsFor } from '../src/lib/server/actions';
import { summarizeVersion } from '../src/lib/server/gtm';
import { buildAuthUrl } from '../src/lib/server/google';
import { safeReturn } from '../src/lib/server/guard';
import { clarityInstallFor, homeUrl, runClarityScan } from '../src/lib/server/clarityscan';
import { ALL_PAGES_TRIGGER, clarityTagBody, GTM_WRITE_SCOPES, hasGtmWrite, installClarityViaGtm, planClarityInstall, type GtmWriter } from '../src/lib/server/gtmwrite';
import { DEMO_CLARITY_ID, demoInstalled } from '../src/lib/server/demo-channels';
import { clarityInstall, claritySnippet, parseClarityId, scanHtml, type ClarityInstallInput } from '../src/lib/clarityinstall';

const BING_SNIPPET = `<!-- Clarity tracking code for https://6figjobs.com/ -->
<script>
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i+"?ref=bwt";
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "zagoogkx9a");
</script>`;

describe('scanHtml', () => {
	it('reads the project ID from the snippet Clarity and Bing hand out', () => {
		expect(scanHtml(BING_SNIPPET)).toEqual({ clarityIds: ['zagoogkx9a'], clarityLoader: true, gtmIds: [] });
	});
	it('reads it inside a framework payload, where the quotes are escaped (a Next.js <Script> in the RSC stream)', () => {
		const rsc = `self.__next_f.push([1,"(window, document, \\"clarity\\", \\"script\\", \\"abc123xyz9\\");"])`;
		expect(scanHtml(rsc).clarityIds).toEqual(['abc123xyz9']);
	});
	it('reads a direct tag URL, and notices the loader even when the ID is not literal', () => {
		expect(scanHtml('<script async src="https://www.clarity.ms/tag/k2j3h4g5f6"></script>').clarityIds).toEqual(['k2j3h4g5f6']);
		expect(scanHtml('t.src="https://www.clarity.ms/tag/"+window.CID').clarityLoader).toBe(true);
		expect(scanHtml('t.src="https://www.clarity.ms/tag/"+window.CID').clarityIds).toEqual([]);
	});
	it('finds Tag Manager containers from both the snippet and a gtm.js URL, and nothing on a bare page', () => {
		const html = `<script>(function(w,d,s,l,i){})(window,document,'script','dataLayer','GTM-ABC1234');</script><script src="https://www.googletagmanager.com/gtm.js?id=GTM-XYZ9876"></script>`;
		expect(scanHtml(html).gtmIds.sort()).toEqual(['GTM-ABC1234', 'GTM-XYZ9876']);
		expect(scanHtml('<html><head><title>x</title></head></html>')).toEqual({ clarityIds: [], clarityLoader: false, gtmIds: [] });
	});
});

describe('parseClarityId and claritySnippet', () => {
	it('takes a bare ID or the whole pasted code, and refuses anything else', () => {
		expect(parseClarityId(' ZAGOOGKX9A ')).toBe('zagoogkx9a');
		expect(parseClarityId(BING_SNIPPET)).toBe('zagoogkx9a');
		expect(parseClarityId('hello world')).toBeNull();
		expect(parseClarityId('')).toBeNull();
	});
	it('builds Clarity’s own code, which the scanner reads back, and cannot be used to inject markup', () => {
		expect(scanHtml(claritySnippet('zagoogkx9a')).clarityIds).toEqual(['zagoogkx9a']);
		expect(claritySnippet('a"</script><script>x')).not.toContain('</script><script>');
	});
});

describe('clarityInstall', () => {
	const page = (o: Partial<ClarityInstallInput['scan'] extends infer S ? S extends { pages: (infer P)[] } ? P : never : never> = {}) => ({ url: 'https://ex.com/', ok: true, clarityIds: [], clarityLoader: false, gtmIds: [], ...o });
	const base: ClarityInstallInput = { connected: true, sessions: 0, scan: { checkedAt: 1, pages: [page(), page({ url: 'https://ex.com/a' })] }, gtm: null };
	const ids = (i: ClarityInstallInput) => clarityInstall(i).findings.map((f) => f.id);

	it('connected, but no script anywhere: a warning that says the token alone records nothing', () => {
		const r = clarityInstall(base);
		expect(r.state).toBe('missing');
		expect(r.findings[0]).toMatchObject({ id: 'clarity-script-missing', severity: 'warning' });
		expect(r.findings[0].detail).toContain('0 sessions');
	});
	it('the script on the page: installed, nothing to say', () => {
		const r = clarityInstall({ ...base, scan: { checkedAt: 1, pages: [page({ clarityIds: ['abc123xyz9'], clarityLoader: true })] } });
		expect(r.state).toBe('on-page');
		expect(r.ids).toEqual(['abc123xyz9']);
		expect(r.findings).toEqual([]);
	});
	it('a live, firing Clarity tag in the linked container counts as installed; a container missing from the pages is noted', () => {
		const gtm = { publicId: 'GTM-AAA1111', published: true, clarityTags: [{ name: 'Clarity', paused: false, firing: ['All Pages'], clarityId: 'abc123xyz9' }] };
		expect(clarityInstall({ ...base, gtm, scan: { checkedAt: 1, pages: [page({ gtmIds: ['GTM-AAA1111'] })] } })).toMatchObject({ state: 'via-gtm', containerOnPage: true, findings: [] });
		expect(ids({ ...base, gtm })).toEqual(['clarity-container-not-seen']);
	});
	it('a Clarity tag that never fires (no trigger, paused, or container unpublished) is its own warning', () => {
		const tag = { name: 'Heatmap script', paused: false, firing: [] as string[], clarityId: null };
		expect(clarityInstall({ ...base, gtm: { publicId: 'GTM-A', published: true, clarityTags: [tag] } }).findings[0]).toMatchObject({ id: 'clarity-gtm-not-firing' });
		expect(clarityInstall({ ...base, gtm: { publicId: 'GTM-A', published: true, clarityTags: [{ ...tag, firing: ['All Pages'], paused: true }] } }).findings[0].detail).toContain('paused');
		expect(clarityInstall({ ...base, gtm: { publicId: 'GTM-A', published: false, clarityTags: [{ ...tag, firing: ['All Pages'] }] } }).findings[0].detail).toContain('never been published');
	});
	it('installed but no token: a nudge (info), and not connected and not installed: silence', () => {
		const onPage = { checkedAt: 1, pages: [page({ clarityIds: ['abc123xyz9'], clarityLoader: true })] };
		expect(clarityInstall({ ...base, connected: false, sessions: null, scan: onPage }).findings).toMatchObject([{ id: 'clarity-not-connected', severity: 'info' }]);
		expect(ids({ ...base, connected: false, sessions: null })).toEqual([]);
	});
	it('pages that could not be read: unknown, never "missing"', () => {
		const r = clarityInstall({ ...base, scan: { checkedAt: 1, pages: [page({ ok: false, error: 'The page answered 403.' })] } });
		expect(r.state).toBe('unknown');
		expect(r.findings.map((f) => f.id)).toEqual(['clarity-check-failed']);
		expect(clarityInstall({ ...base, scan: null }).findings).toEqual([]);
	});
	it('no script in the HTML but Clarity is recording: "unseen" (added by JavaScript), an info, never the missing warning', () => {
		const r = clarityInstall({ ...base, sessions: 420 });
		expect(r.state).toBe('unseen');
		expect(r.findings).toMatchObject([{ id: 'clarity-script-unseen', severity: 'info' }]);
		expect(r.findings[0].detail).toContain('420 sessions');
	});
	it('two different projects on the pages is a warning', () => {
		expect(ids({ ...base, scan: { checkedAt: 1, pages: [page({ clarityIds: ['aaaaaaaaa1'], clarityLoader: true }), page({ clarityIds: ['bbbbbbbbb2'], clarityLoader: true })] } })).toEqual(['clarity-two-projects']);
	});
});

describe('Tag Manager: spotting a Clarity tag', () => {
	it('a Custom HTML tag with Clarity’s code, with its ID; a template named after Clarity; other HTML tags are not Clarity', () => {
		const v = summarizeVersion({
			tag: [
				{ tagId: '1', name: 'Clarity', type: 'html', parameter: [{ key: 'html', value: BING_SNIPPET }], firingTriggerId: ['2147479553'] },
				{ tagId: '2', name: 'Microsoft Clarity - Official', type: 'cvt_123_45', parameter: [{ key: 'clarityId', value: 'tmplid1234' }] },
				{ tagId: '3', name: 'Cookie banner', type: 'html', parameter: [{ key: 'html', value: '<script>cookies()</script>' }] }
			]
		});
		expect(v.tags.map((t) => [t.clarity, t.clarityId])).toEqual([
			[true, 'zagoogkx9a'],
			[true, 'tmplid1234'],
			[false, null]
		]);
	});
});

describe('Tag Manager write access', () => {
	it('is never in the normal sign-in, only when asked for', () => {
		process.env.GOOGLE_CLIENT_ID = 'cid';
		const normal = new URL(buildAuthUrl('s')).searchParams.get('scope')!;
		expect(normal).not.toMatch(/tagmanager\.(edit|publish)/);
		const grant = new URL(buildAuthUrl('s', GTM_WRITE_SCOPES)).searchParams.get('scope')!.split(' ');
		for (const s of GTM_WRITE_SCOPES) expect(grant).toContain(s);
	});
	it('hasGtmWrite needs all three scopes (demo accounts always have them)', () => {
		expect(hasGtmWrite({ scopes: `openid ${GTM_WRITE_SCOPES.join(' ')}`, is_demo: 0 })).toBe(true);
		expect(hasGtmWrite({ scopes: `openid ${GTM_WRITE_SCOPES[0]}`, is_demo: 0 })).toBe(false);
		expect(hasGtmWrite({ scopes: '', is_demo: 1 })).toBe(true);
	});
	it('the tag is Custom HTML with Clarity’s code on the built-in All Pages trigger', () => {
		const t = clarityTagBody('zagoogkx9a');
		expect(t).toMatchObject({ type: 'html', firingTriggerId: [ALL_PAGES_TRIGGER] });
		expect(scanHtml(t.parameter[0].value).clarityIds).toEqual(['zagoogkx9a']);
	});
	it('the return address after Google is a path in this app, never another site', () => {
		expect(safeReturn('/sites/3/clarity')).toBe('/sites/3/clarity');
		for (const bad of ['//evil.example/x', '/\\evil.example', 'https://evil.example/', 'javascript:alert(1)', '', null]) expect(safeReturn(bad)).toBeNull();
	});
	it('homeUrl: https://domain/ for a domain property, the prefix itself otherwise', () => {
		expect(homeUrl('sc-domain:6figjobs.com')).toBe('https://6figjobs.com/');
		expect(homeUrl('https://www.ex.com/blog/')).toBe('https://www.ex.com/blog/');
	});
});

describe('demo: the check and the install end to end', () => {
	const drain = async () => {
		const end = Date.now() + 30_000;
		while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
	};
	const siteId = (host: string) => (db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id;

	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const [id, sub] of [[1, 'demo-a'], [2, 'demo-a'], [3, 'demo-a'], [4, 'demo-b'], [5, 'demo-b'], [6, 'demo-b']] as const) await syncSite(id, { client: new DemoClient(sub), mode: 'incremental' });
		await autoMatchGa4();
		await autoMatchGtm();
		await drain();
		for (const h of ['greenleaf', 'pixelforge', 'coffeelab', 'northwind']) {
			await connectClarity(siteId(h), 'demo');
			await runClarityScan(siteId(h));
		}
	}, 120_000);

	it('greenleaf has the script in its pages; pixelforge has only Tag Manager; coffeelab’s Clarity tag never fires; northwind has nothing', () => {
		expect(clarityInstallFor(siteId('greenleaf'))).toMatchObject({ state: 'on-page', ids: [DEMO_CLARITY_ID], findings: [] });
		expect(clarityInstallFor(siteId('pixelforge')).findings.map((f) => f.id)).toEqual(['clarity-script-missing']);
		// coffeelab records sessions although no script is in its HTML and its Clarity tag never fires: "unseen", not an alarm
		expect(clarityInstallFor(siteId('coffeelab'))).toMatchObject({ state: 'unseen', findings: [{ id: 'clarity-script-unseen', severity: 'info' }] });
		expect(clarityInstallFor(siteId('northwind')).state).toBe('missing');
	});

	it('the finding reaches the tracking audit and the action queue, pointing at the Clarity tab', () => {
		const site = getSite(siteId('pixelforge'))!;
		expect(trackingHealth(site, 28).findings.map((f) => f.id)).toContain('clarity-script-missing');
		const item = actionsFor(site).find((a) => a.key === 'tracking:clarity-script-missing');
		expect(item?.href).toBe(`/sites/${site.id}/clarity`);
		expect(item?.how).toMatch(/Tag Manager/);
	});

	it('plan shows the change without making it; a bad ID or a site without a container is refused', async () => {
		const id = siteId('pixelforge');
		const plan = await planClarityInstall(id, BING_SNIPPET);
		expect(plan).toMatchObject({ ok: true, projectId: 'zagoogkx9a', canPublish: true, existing: [] });
		expect(demoInstalled.size).toBe(0);
		expect((await planClarityInstall(id, 'nope')).ok).toBe(false);
		expect((await planClarityInstall(siteId('northwind'), 'zagoogkx9a')).error).toMatch(/Tag Manager container/);
		// coffeelab already has a (broken) Clarity tag: the preview says so
		expect((await planClarityInstall(siteId('coffeelab'), 'zagoogkx9a')).existing?.[0]).toMatchObject({ name: 'Heatmap script', firing: [] });
	});

	it('publishing is refused when the newest version is not the live one, so nobody else’s work goes live', async () => {
		const calls: string[] = [];
		const writer: GtmWriter = {
			latestVersionId: async () => '13', // the demo live version is 12
			createWorkspace: async () => (calls.push('ws'), { path: 'w', workspaceId: '1' }),
			createTag: async () => (calls.push('tag'), { tagId: '1' }),
			createVersion: async () => (calls.push('version'), { path: 'v', versionId: '14', compilerError: false }),
			publish: async () => (calls.push('publish'), { versionId: '14', compilerError: false })
		};
		const r = await installClarityViaGtm(siteId('pixelforge'), 'zagoogkx9a', 'publish', { writer });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/newer version/);
		expect(calls).toEqual([]);
		// preparing the tag in its own workspace is still allowed, and never versions or publishes
		expect((await installClarityViaGtm(siteId('pixelforge'), 'zagoogkx9a', 'workspace', { writer })).ok).toBe(true);
		expect(calls).toEqual(['ws', 'tag']);
		demoInstalled.clear();
	});

	it('install and publish in the demo: the container then has the tag, and the warning goes away after the next sync', async () => {
		const id = siteId('pixelforge');
		const r = await installClarityViaGtm(id, 'zagoogkx9a', 'publish');
		expect(r).toMatchObject({ ok: true, published: true, versionId: '13' });
		expect(r.reviewUrl).toMatch(/^https:\/\/tagmanager\.google\.com\//);
		const { syncGtm } = await import('../src/lib/server/channels');
		await syncGtm(id);
		expect(clarityInstallFor(id)).toMatchObject({ state: 'via-gtm', ids: ['zagoogkx9a'], findings: [] });
		expect((db().prepare("SELECT action FROM audit_log WHERE action LIKE 'gtm.clarity%' ORDER BY id DESC LIMIT 1").get() as { action: string }).action).toBe('gtm.clarity_published');
		demoInstalled.clear();
	});

	it('a read-only server never plans or makes a change', async () => {
		process.env.READ_ONLY = '1';
		try {
			expect((await planClarityInstall(siteId('pixelforge'), 'zagoogkx9a')).error).toMatch(/READ_ONLY/);
			expect((await installClarityViaGtm(siteId('pixelforge'), 'zagoogkx9a', 'publish')).ok).toBe(false);
		} finally {
			delete process.env.READ_ONLY;
		}
	});
});
