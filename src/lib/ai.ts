/** Which AI assistant a GA4 session source belongs to. */

export const AI_ASSISTANTS = ['ChatGPT', 'Perplexity', 'Gemini', 'Claude', 'Copilot'] as const;
export type Assistant = (typeof AI_ASSISTANTS)[number];

const RULES: [Assistant, RegExp][] = [
	['ChatGPT', /chatgpt|openai/],
	['Perplexity', /perplexity/],
	['Gemini', /gemini|bard\.google/],
	['Claude', /claude\.ai|^claude(\b|$)/],
	['Copilot', /copilot/]
];

/**
 * GA4 records the referrer host as the session source (for example "chatgpt.com"). The names here are what I know
 * assistants have used; they change, and an assistant that sends no referrer shows up as Direct and cannot be found.
 * Anything not matched returns null, so it is never miscounted.
 */
export function assistantOf(source: string): Assistant | null {
	const s = source.trim().toLowerCase();
	return RULES.find(([, re]) => re.test(s))?.[0] ?? null;
}

/** RE2 pattern for GA4's PARTIAL_REGEXP filter, matching the same families as assistantOf. */
export const GA4_SOURCE_PATTERN = 'chatgpt|openai|perplexity|gemini|bard\\.google|claude\\.ai|copilot';
