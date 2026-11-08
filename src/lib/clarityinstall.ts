/**
 * Is Microsoft Clarity's script actually on the site? The Clarity API token only reads data out; the script is what records it.
 * Pure functions (no I/O) so the rules are unit-tested: scanning a page's HTML for the Clarity and Tag Manager snippets, reading a
 * Clarity project ID from a pasted snippet, and turning what was found into findings.
 */
import type { Finding } from './tracking';

export interface ScriptScan {
	/** Clarity project IDs named on the page. */
	clarityIds: string[];
	/** The page loads Clarity's tag script, whether or not the ID could be read. */
	clarityLoader: boolean;
	/** Tag Manager containers the page loads (GTM-XXXXXXX). */
	gtmIds: string[];
}

// Quotes may be escaped once (\") or more (\\\", a string inside a string) when the snippet sits inside a framework's payload,
// e.g. a Next.js <Script> in the RSC stream, as on a live Next.js site.
const Q = String.raw`\\*["']`;
const SNIPPET_ID = new RegExp(`${Q}clarity${Q}\\s*,\\s*${Q}script${Q}\\s*,\\s*${Q}([a-z0-9]{6,16})${Q}`, 'gi');
const TAG_URL_ID = /clarity\.ms\/tag\/([a-z0-9]{6,16})(?![a-z0-9])/gi;
const LOADER = /clarity\.ms\/tag\//i;
const GTM_URL = /googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]{4,12})/gi;
const GTM_SNIPPET = new RegExp(`${Q}dataLayer${Q}\\s*,\\s*${Q}(GTM-[A-Z0-9]{4,12})${Q}`, 'gi');

const all = (re: RegExp, s: string, up = false) => [...s.matchAll(re)].map((m) => (up ? m[1].toUpperCase() : m[1].toLowerCase()));

export function scanHtml(html: string): ScriptScan {
	const clarityIds = [...new Set([...all(SNIPPET_ID, html), ...all(TAG_URL_ID, html)])];
	return { clarityIds, clarityLoader: clarityIds.length > 0 || LOADER.test(html), gtmIds: [...new Set([...all(GTM_URL, html, true), ...all(GTM_SNIPPET, html, true)])] };
}

/** A Clarity project ID typed on its own, or read from the whole pasted tracking code. */
export function parseClarityId(input: string): string | null {
	const s = input.trim();
	if (/^[a-z0-9]{6,16}$/i.test(s)) return s.toLowerCase();
	return scanHtml(s).clarityIds[0] ?? null;
}

/** Clarity's standard tracking code for a project, as Clarity's own setup page shows it (with the ID made safe to embed). */
export function claritySnippet(projectId: string): string {
	const id = projectId.replace(/[^a-z0-9]/gi, '').toLowerCase();
	return `<script type="text/javascript">
    (function(c,l,a,r,i,t,y){
        c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
        t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
        y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
    })(window, document, "clarity", "script", "${id}");
</script>`;
}

export interface ScannedPage { url: string; ok: boolean; error?: string; clarityIds: string[]; clarityLoader: boolean; gtmIds: string[] }
export interface ClarityGtmTag { name: string; paused: boolean; firing: string[]; clarityId: string | null }

export interface ClarityInstallInput {
	/** A Clarity API token is linked for this site. */
	connected: boolean;
	/** Sessions in the newest stored Clarity snapshot; null when there is none. */
	sessions: number | null;
	/** The newest page check; null when none has run. */
	scan: { checkedAt: number; pages: ScannedPage[] } | null;
	/** The linked Tag Manager container's live version; null when none is linked or synced. */
	gtm: { publicId: string; published: boolean; clarityTags: ClarityGtmTag[] } | null;
}

/** unseen: no script in the HTML, yet Clarity is recording, so something (usually the site's own JavaScript) adds it. */
export type ClarityState = 'on-page' | 'via-gtm' | 'unseen' | 'gtm-not-firing' | 'missing' | 'unknown';

export interface ClarityInstall {
	state: ClarityState;
	/** Project IDs seen on the pages or in Tag Manager. */
	ids: string[];
	pagesChecked: number;
	pagesOk: number;
	/** The linked container was seen in the pages' HTML (null: not linked, or no page could be read). */
	containerOnPage: boolean | null;
	findings: Finding[];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const pathOf = (u: string) => {
	try {
		return new URL(u).pathname;
	} catch {
		return u;
	}
};

export function clarityInstall(input: ClarityInstallInput): ClarityInstall {
	const pages = input.scan?.pages ?? [];
	const ok = pages.filter((p) => p.ok);
	const pageIds = [...new Set(ok.flatMap((p) => p.clarityIds))];
	const onPage = ok.some((p) => p.clarityLoader);
	const gtm = input.gtm;
	const live = gtm?.published ? gtm.clarityTags.filter((t) => !t.paused && t.firing.length) : [];
	const idle = gtm ? gtm.clarityTags.filter((t) => !gtm.published || t.paused || !t.firing.length) : [];
	const gtmIds = [...new Set((gtm?.clarityTags ?? []).map((t) => t.clarityId).filter((x): x is string => !!x))];
	const containerOnPage = gtm && ok.length ? ok.some((p) => p.gtmIds.includes(gtm.publicId.toUpperCase())) : null;

	const recording = input.connected && (input.sessions ?? 0) > 0;
	const state: ClarityState = onPage ? 'on-page' : live.length ? 'via-gtm' : recording && ok.length ? 'unseen' : idle.length ? 'gtm-not-firing' : ok.length ? 'missing' : 'unknown';
	const ids = [...new Set([...pageIds, ...gtmIds])];
	const findings: Finding[] = [];
	const checked = ok.map((p) => pathOf(p.url)).join(', ');

	if (input.connected && state === 'missing') {
		findings.push({
			id: 'clarity-script-missing',
			severity: 'warning',
			title: 'Clarity is connected, but its script is not on your pages',
			detail: `Checked ${plural(ok.length, 'page')} (${checked}): none loads Clarity${gtm ? ` and the linked Tag Manager container ${gtm.publicId} has no Clarity tag` : ''}. The API token only reads data; without the script Clarity records nothing${input.sessions === 0 ? ', which matches the 0 sessions in the latest snapshot' : ''}. A script added later by the page's own JavaScript is not visible to this check.`
		});
	}
	if (state === 'unseen') {
		findings.push({ id: 'clarity-script-unseen', severity: 'info', title: 'Clarity is recording, but its script is not in the pages’ HTML', detail: `Checked ${plural(ok.length, 'page')} (${checked}). The latest snapshot has ${input.sessions!.toLocaleString('en-US')} sessions, so the script is probably added by the site's own JavaScript, which this check cannot see. Nothing to do unless some pages are missing from Clarity.${idle.length ? ` (The Clarity tag in ${gtm!.publicId}, ${idle.map((t) => `“${t.name}”`).join(', ')}, never runs; delete it if it is left over.)` : ''}` });
	}
	if (input.connected && state === 'gtm-not-firing') {
		const why = !gtm!.published ? 'the container has never been published' : idle.some((t) => t.paused) ? 'the tag is paused' : 'the tag has no firing trigger';
		findings.push({ id: 'clarity-gtm-not-firing', severity: 'warning', title: 'The Clarity tag in Tag Manager never runs', detail: `${idle.map((t) => `“${t.name}”`).join(', ')} is in ${gtm!.publicId}, but ${why}, and no page loads Clarity directly. Clarity records nothing until it runs.` });
	}
	if (state === 'via-gtm' && containerOnPage === false) {
		findings.push({ id: 'clarity-container-not-seen', severity: 'info', title: `Clarity loads through ${gtm!.publicId}, but that container was not seen on the pages`, detail: `The checked pages (${checked}) do not include the ${gtm!.publicId} snippet${ok.some((p) => p.gtmIds.length) ? ` (they load ${[...new Set(ok.flatMap((p) => p.gtmIds))].join(', ')})` : ''}. If the container is added by the site's own JavaScript this is fine; otherwise its Clarity tag never runs.` });
	}
	if (!input.connected && (state === 'on-page' || state === 'via-gtm')) {
		findings.push({ id: 'clarity-not-connected', severity: 'info', title: `Clarity is installed${ids.length ? ` (project ${ids.join(', ')})` : ''} but not connected here`, detail: 'Paste a Clarity API token on the Connect page to see rage clicks, dead clicks and scroll depth next to your search data.' });
	}
	if (input.connected && state === 'unknown' && pages.length) {
		findings.push({ id: 'clarity-check-failed', severity: 'info', title: 'Could not check whether Clarity is on the pages', detail: `No page could be read: ${pages[0].error ?? 'unknown error'}. Some sites block automated requests.` });
	}
	if (pageIds.length > 1) {
		findings.push({ id: 'clarity-two-projects', severity: 'warning', title: 'The pages load more than one Clarity project', detail: `Seen: ${pageIds.join(', ')}. Each visit is then recorded in several projects and the numbers split between them; keep one.` });
	}
	return { state, ids, pagesChecked: pages.length, pagesOk: ok.length, containerOnPage, findings };
}
