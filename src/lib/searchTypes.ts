/** Search Console search types. Web is the default and lives in site_daily; the rest have their own totals. */
export const SEARCH_TYPES = ['image', 'video', 'news', 'discover', 'googleNews'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];
export type AnyType = 'web' | SearchType;
export const ALL_TYPES: AnyType[] = ['web', ...SEARCH_TYPES];

export const TYPE_LABEL: Record<AnyType, string> = {
	web: 'Web',
	image: 'Image',
	video: 'Video',
	news: 'News',
	discover: 'Discover',
	googleNews: 'Google News'
};

export const TYPE_HINT: Record<AnyType, string> = {
	web: 'Regular Google web results',
	image: 'Google Images',
	video: 'Video results and the Videos tab',
	news: 'The News tab on Google Search',
	discover: 'The Discover feed in Google and Chrome',
	googleNews: 'The Google News app and news.google.com'
};

/** Search appearance values arrive as codes such as RICH_RESULT; show them readably without assuming a fixed list. */
export function appearanceLabel(code: string): string {
	return code
		.toLowerCase()
		.split('_')
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(' ');
}
