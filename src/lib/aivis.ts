/**
 * AI visibility: what AI assistants say when asked the questions your customers ask. Pure functions, no I/O, unit-tested.
 *
 * For each answer it decides whether your brand or domain is MENTIONED in the text, whether one of your pages is CITED as a source,
 * where your domain ranks among the cited domains, and which of your competitors are mentioned or cited. Over many answers it gives
 * the mention and citation rates per assistant, share of voice against competitors, and the domains that get cited most.
 *
 * What it measures is one answer per run: assistants vary their answers between runs and by user, location and account, so a rate
 * over several runs is the signal, never a single answer.
 */

export const AI_ENGINES = ['claude', 'chatgpt', 'perplexity'] as const;
export type AiEngine = (typeof AI_ENGINES)[number];
export const ENGINE_LABEL: Record<AiEngine, string> = { claude: 'Claude', chatgpt: 'ChatGPT', perplexity: 'Perplexity' };

export interface AiAnswer {
	text: string;
	/** sources the answer cites (attached to sentences of the answer) */
	citations: { url: string; title?: string | null }[];
	/** every source the assistant looked at, cited or not (a superset of citations where the API reports it) */
	sources: { url: string; title?: string | null }[];
}

/** host without www., lower case; null for anything that is not an http(s) URL */
export function hostOf(url: string): string | null {
	try {
		const u = new URL(url);
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
		return u.hostname.toLowerCase().replace(/^www\./, '');
	} catch {
		return null;
	}
}

/** A domain as typed by someone ("https://www.Example.com/", "example.com") reduced to "example.com". */
export function normalizeDomain(d: string): string {
	const s = d.trim().toLowerCase();
	return (hostOf(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`) ?? s).replace(/\/.*$/, '');
}

/** Does `host` belong to `domain` (the domain itself or one of its subdomains)? */
export const onDomain = (host: string | null, domain: string) => !!host && (host === domain || host.endsWith('.' + domain));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whole-word, case-insensitive: "acme" is in "Acme's tools" but not in "acmeville". */
export function mentions(text: string, term: string): boolean {
	const t = term.trim();
	if (t.length < 2) return false;
	return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/**
 * The words that count as naming a brand: the domain itself ("greenleaf.example"), the brand terms set for the site, and, when none
 * are set, the domain's first label if it is distinctive enough ("greenleaf"; not a 3-letter label, which would match too much).
 */
export function brandWords(domain: string, brandTerms: string[] = []): string[] {
	const words = new Set<string>([domain, ...brandTerms.map((t) => t.trim()).filter((t) => t.length >= 2)]);
	if (!brandTerms.length) {
		const label = domain.split('.')[0];
		if (label.length >= 4) words.add(label);
	}
	return [...words];
}

export interface AnswerVerdict {
	mentioned: boolean;
	cited: boolean;
	/** your pages among the citations, in order */
	ourCitations: string[];
	/** distinct cited domains, in the order they first appear */
	citedDomains: string[];
	/** your domain's rank among cited domains (1 = first), or null when not cited */
	position: number | null;
	/** your domain was among the sources consulted, even if not cited */
	inSources: boolean;
	competitorsMentioned: string[];
	competitorsCited: string[];
}

export function analyzeAnswer(a: AiAnswer, o: { domain: string; brandTerms?: string[]; competitors?: string[] }): AnswerVerdict {
	const domain = normalizeDomain(o.domain);
	const citedHosts = a.citations.map((c) => hostOf(c.url));
	const citedDomains: string[] = [];
	for (const h of citedHosts) if (h && !citedDomains.includes(h)) citedDomains.push(h);
	const ourCitations = [...new Set(a.citations.filter((c) => onDomain(hostOf(c.url), domain)).map((c) => c.url))];
	const idx = citedDomains.findIndex((h) => onDomain(h, domain));
	const competitors = [...new Set((o.competitors ?? []).map(normalizeDomain).filter((c) => c && c !== domain))];
	return {
		mentioned: brandWords(domain, o.brandTerms).some((w) => mentions(a.text, w)) || a.text.toLowerCase().includes(domain),
		cited: ourCitations.length > 0,
		ourCitations,
		citedDomains,
		position: idx >= 0 ? idx + 1 : null,
		inSources: a.sources.some((s) => onDomain(hostOf(s.url), domain)) || ourCitations.length > 0,
		competitorsMentioned: competitors.filter((c) => brandWords(c).some((w) => mentions(a.text, w))),
		competitorsCited: competitors.filter((c) => citedHosts.some((h) => onDomain(h, c)))
	};
}

export interface RunLite { engine: AiEngine; promptId: number; verdict: AnswerVerdict }

export interface EngineSummary { engine: AiEngine; runs: number; mentionRate: number; citationRate: number; avgPosition: number | null }
export interface VoiceRow { domain: string; ours: boolean; mentionShare: number; citationShare: number }

/** Rates per assistant, share of voice (you against each competitor, on the same answers) and the domains cited most often. */
export function summarizeRuns(runs: RunLite[], o: { domain: string; competitors?: string[] }) {
	const domain = normalizeDomain(o.domain);
	const byEngine: EngineSummary[] = AI_ENGINES.map((engine) => {
		const rs = runs.filter((r) => r.engine === engine);
		const pos = rs.map((r) => r.verdict.position).filter((p): p is number => p != null);
		return { engine, runs: rs.length, mentionRate: rs.length ? rs.filter((r) => r.verdict.mentioned).length / rs.length : 0, citationRate: rs.length ? rs.filter((r) => r.verdict.cited).length / rs.length : 0, avgPosition: pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null };
	}).filter((e) => e.runs > 0);
	const competitors = [...new Set((o.competitors ?? []).map(normalizeDomain).filter((c) => c && c !== domain))];
	const n = runs.length || 1;
	const voice: VoiceRow[] = [
		{ domain, ours: true, mentionShare: runs.filter((r) => r.verdict.mentioned).length / n, citationShare: runs.filter((r) => r.verdict.cited).length / n },
		...competitors.map((c) => ({ domain: c, ours: false, mentionShare: runs.filter((r) => r.verdict.competitorsMentioned.includes(c)).length / n, citationShare: runs.filter((r) => r.verdict.competitorsCited.includes(c)).length / n }))
	].sort((a, b) => b.citationShare + b.mentionShare - (a.citationShare + a.mentionShare));
	const counts = new Map<string, number>();
	for (const r of runs) for (const d of r.verdict.citedDomains) counts.set(d, (counts.get(d) ?? 0) + 1);
	const topCited = [...counts.entries()].map(([d, c]) => ({ domain: d, answers: c, ours: onDomain(d, domain), competitor: competitors.some((x) => onDomain(d, x)) })).sort((a, b) => b.answers - a.answers || a.domain.localeCompare(b.domain)).slice(0, 15);
	return { runs: runs.length, byEngine, voice, topCited };
}
