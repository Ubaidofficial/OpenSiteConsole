/**
 * The privacy policy and terms pages. They describe what this software actually does (see README); the operator of an installation fills in
 * who they are with LEGAL_ENTITY, LEGAL_CONTACT_EMAIL and LEGAL_GOVERNING_LAW. They are a starting point, not legal advice: the operator should
 * have them reviewed before relying on them, above all for Google's OAuth verification and for any customers they serve.
 */
export interface LegalContext { entity: string; contact: string | null; law: string | null; updated: string }
export interface LegalSection { title: string; paras: string[]; items?: string[] }

const who = (c: LegalContext) => c.entity;
const reach = (c: LegalContext) => (c.contact ? `by email at ${c.contact}` : 'through the contact details the operator publishes for this service');

export const GOOGLE_LIMITED_USE = "SEOConsole's use and transfer to any other app of information received from Google APIs will adhere to the Google API Services User Data Policy, including the Limited Use requirements.";

export function privacySections(c: LegalContext): LegalSection[] {
	return [
		{
			title: 'Who this policy is from',
			paras: [
				`SEOConsole is software that ${who(c)} (“we”, “us”) runs to bring together search and site data for the websites its users own or manage. This policy explains what data the service handles, why, who sees it and how to have it removed. SEOConsole is open-source software that anyone can run on their own server: this page describes this installation, run by ${who(c)}.`,
				`Questions about this policy can be sent ${reach(c)}.`
			]
		},
		{
			title: 'What we collect',
			paras: ['Only what you connect, and only what the service needs to show it to you:'],
			items: [
				'Google account sign-in: your Google account’s email address and a token that lets the service call Google’s APIs for you. We ask for the permissions listed in the next section.',
				'Search Console data for the properties you choose: queries, pages, clicks, impressions, average position, countries and devices, your submitted sitemaps, and URL Inspection results (whether Google has indexed a page and why not).',
				'If you connect them: Google Analytics 4 sessions, landing pages and key events (read-only); the published contents of a Google Tag Manager container (read-only); Bing Webmaster Tools data; Microsoft Clarity data; Chrome UX Report data; and a linked OpenSEO project.',
				'What you do in the service: the sites you hide or label, notes you write, tests you set up, URLs you submit for indexing and what each search engine answered, the settings you choose, and an audit log of changes made through the service (including through API keys).',
				'Technical data: a sign-in session cookie (see Cookies) and standard server logs kept by whoever hosts the service. We do not use advertising or analytics trackers.'
			]
		},
		{
			title: 'Google user data and the permissions we ask for',
			paras: [
				GOOGLE_LIMITED_USE,
				'The one place Google data reaches an AI service is the Ask chat described under “Who we share it with”: it is sent only to answer the question you asked, we do not use it to train AI models, and we send it for no other purpose.',
				'In plain terms: we use the data Google gives us only to show it to you inside this service and to carry out the actions you ask for. We do not sell it, we do not use it for advertising, we do not use it to train generalised AI or machine-learning models, and no person reads it except where you ask for support and agree, where it is needed for security or to follow the law, or where it has been anonymised and aggregated.',
				'The permissions we may request, each only when the feature that needs it is switched on:'
			],
			items: [
				'Search Console (read and write, or read-only if the operator runs the service in read-only mode): to read your search performance and, when you ask, to submit or remove sitemaps and add or remove properties.',
				'Google Analytics (read-only) and Tag Manager (read-only): to show organic sessions next to Search Console and to check your tracking set-up. We never change your analytics or tags.',
				'Google Indexing API (optional): to tell Google about job-posting and livestream pages you ask us to send. It is not used for other pages.',
				'Google Site Verification (optional): to prove ownership of a site you ask us to add, using a token you place on your site or in your DNS.'
			]
		},
		{
			title: 'How we use it',
			paras: ['To provide the features you see: dashboards and reports, the ranked list of things to fix, the weekly digest and alerts, SEO tests, indexing monitoring and submission, and the MCP server. We do not make decisions about you with it and we do not profile you.']
		},
		{
			title: 'Who we share it with',
			paras: ['We do not sell your data. It goes only to the services you connect, to do what you ask, and to the people you choose:'],
			items: [
				'Google and Microsoft, when the service calls their APIs for you (and receives the answers).',
				'Search engines that take part in IndexNow, and Bing’s URL submission, when you ask us to submit URLs: they receive those public URLs.',
				'A chat or webhook address (such as Slack or Discord) if the operator sets one for the weekly digest.',
				'An AI assistant you connect through the MCP server: it receives whatever its tools return, under that assistant’s own terms. Connect only assistants you trust, and prefer a key limited to the sites it needs.',
				'An AI model provider, only if the operator has switched on the Ask chat: when you ask a question there, your question and the data the service looks up to answer it (for example queries, pages, clicks, positions and the to-do list for the sites you choose) are sent to Anthropic, the company behind Claude, using the operator’s own API key, to write the answer. Nothing is sent unless someone uses Ask. Anthropic handles it under its own terms and privacy policy.',
				'AI answer providers, only if the operator has switched on AI answer tracking: the questions you write to track are sent to the AI services that answer them (OpenAI, Anthropic and Perplexity, or DataForSEO, which runs some of them for the service) to see whether your brand or site is mentioned. This is not data from Google.',
				'The company that hosts the server and its backups, as our service provider.',
				'Authorities, if the law requires it.'
			]
		},
		{
			title: 'Where it is stored and how it is protected',
			paras: [
				'Data is kept in a database on the server where this installation runs. Google sign-in tokens and the keys and tokens for other connected services are encrypted at rest. Access to the service needs the operator’s password, and API keys can be limited to some sites and, by default, are read-only. No system is perfectly secure: if we learn of a breach that affects you, we will tell you as the law requires.'
			]
		},
		{
			title: 'How long we keep it',
			paras: [
				'Search and analytics data is kept for as long as the connection exists, so that history can be shown beyond the 16 months Google keeps. When an account is removed in the service, its tokens and all the data stored for its sites are deleted from the service. Backups made by the host expire on the host’s schedule. The audit log is kept so that changes can be traced.'
			]
		},
		{
			title: 'Your choices and rights',
			paras: [
				'You can disconnect at any time: remove the account inside the service, and/or revoke the service’s access in your Google account at https://myaccount.google.com/permissions. Removing it inside the service deletes the stored data as described above; revoking in Google stops any further access.',
				`You can ask ${reach(c)} to see, correct or delete data we hold about you. Depending on where you live you may have further rights (for example under the GDPR or the CCPA), including to complain to a data-protection authority; we will respect them.`
			]
		},
		{
			title: 'Cookies and local storage',
			paras: [
				'The service sets one cookie, a sign-in session cookie (httpOnly, valid for up to 14 days, ended when you sign out or the password changes). Your browser also keeps a local setting for the “privacy eye” that blurs names on screen. There are no advertising or analytics cookies.'
			]
		},
		{
			title: 'Children',
			paras: ['The service is for people who manage websites and is not directed at children under 16, and we do not knowingly collect their data.']
		},
		{
			title: 'Changes',
			paras: [`If we change this policy we will post the new version here and update the date below. Last updated: ${c.updated}.`]
		}
	];
}

export function termsSections(c: LegalContext): LegalSection[] {
	return [
		{
			title: 'Agreement',
			paras: [
				`These terms govern your use of this installation of SEOConsole, run by ${who(c)}. By signing in or connecting an account you agree to them. If you do not agree, do not use the service. Please also read the privacy policy.`
			]
		},
		{
			title: 'What the service does',
			paras: ['SEOConsole brings together Search Console, Analytics, Bing and other site data, ranks what to fix, tests changes, monitors indexing, and can send URLs and sitemaps to search engines. Its figures and estimates come from your own data and from models; they are aids to judgement, not promises of rankings, traffic or indexing.']
		},
		{
			title: 'Your account and what you connect',
			items: [
				'You may connect only sites and accounts that you own or are authorised to manage, and you are responsible for everything done with your sign-in, API keys and connected accounts.',
				'Keep the admin password and API keys secret. A key with the “submit” permission can send URLs and sitemaps to search engines on your behalf: give it only to tools you trust, and remove it when it is no longer needed.',
				'You must comply with the terms of the services you connect, including Google’s and Microsoft’s API terms and policies.'
			],
			paras: []
		},
		{
			title: 'Acceptable use',
			paras: ['You agree not to:'],
			items: [
				'submit URLs you do not control, or use the indexing features to spam search engines (for example to flood IndexNow or Bing, or to send ordinary pages to Google’s Indexing API, which Google documents only for job-posting and livestream pages);',
				'use several accounts or projects to get around a search engine’s quotas;',
				'try to break, overload or gain unauthorised access to the service or to anyone else’s data;',
				'use the service to break the law or someone else’s rights, or to publish or promote deceptive or harmful content.'
			]
		},
		{
			title: 'AI features',
			paras: ['The Ask chat and AI answer tracking use outside AI services. Their answers can be wrong or out of date: check them before you act, and do not rely on them as legal, financial or other professional advice. Anything the Ask chat proposes to change, such as submitting URLs, waits for your click.']
		},
		{
			title: 'Third-party services',
			paras: ['The service depends on Google, Microsoft, IndexNow engines and other third parties. They can change or stop their APIs, quotas and rules at any time, and what they return is outside our control. “Accepted” by a search engine means it received a request, not that a page will be indexed or ranked.']
		},
		{
			title: 'Software licence',
			paras: ['SEOConsole is open-source software released under the GNU Affero General Public License v3.0 (AGPL-3.0-only). These terms govern the service run by us; the licence governs the code, and nothing here limits your rights under it.']
		},
		{
			title: 'Availability and changes',
			paras: ['We try to keep the service running but do not promise it will always be available, error-free or that data will never be lost. We may change or discontinue features, and we may suspend access that breaks these terms or puts the service or others at risk.']
		},
		{
			title: 'No warranty',
			paras: ['The service is provided “as is” and “as available”, without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement, to the extent the law allows.']
		},
		{
			title: 'Limit of liability',
			paras: ['To the extent the law allows, we are not liable for indirect, incidental or consequential losses, or for lost profits, traffic, rankings or data, arising from your use of the service. Nothing here limits liability that cannot be limited by law.']
		},
		{
			title: 'Ending your use',
			paras: ['You can stop at any time by removing your accounts and keys in the service. See the privacy policy for what happens to your data. Sections that by their nature should survive (such as the limits on liability) survive.']
		},
		{
			title: 'Governing law and changes to these terms',
			paras: [
				c.law ? `These terms are governed by the laws of ${c.law}, and the courts there have jurisdiction, without affecting any mandatory consumer rights you have where you live.` : 'The law that governs these terms is the one the operator states for this service, without affecting any mandatory consumer rights you have where you live.',
				`We may update these terms; the new version applies from when it is posted here. Last updated: ${c.updated}. Contact: ${reach(c)}.`
			]
		}
	];
}
