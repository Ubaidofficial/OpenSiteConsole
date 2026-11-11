/**
 * The Tag Manager install code for a container: the two pieces Google asks you to paste on every page of the site.
 * Shared by the server and the browser (the Connect page shows it with a copy button). SEOConsole cannot put this on your
 * site; only you (or your developer, theme or plugin) can.
 *
 * Written from Google's standard snippet as I know it; it was not re-read from Google's page while this was written (the
 * page that carries it did not load), so compare it with Tag Manager's own "Install Google Tag Manager" dialog for the container.
 */
export const GTM_ID = /^GTM-[A-Z0-9]{4,12}$/;

export interface GtmSnippet {
	/** As high as possible in the page's <head>. */
	head: string;
	/** Straight after the opening <body> tag. */
	body: string;
}

/** The snippet for a public container ID like GTM-ABC1234, or null when the ID is not one (the ID goes into markup, so nothing else is let through). */
export function gtmSnippet(publicId: string): GtmSnippet | null {
	const id = publicId.trim().toUpperCase();
	if (!GTM_ID.test(id)) return null;
	return {
		head: `<!-- Google Tag Manager -->
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${id}');</script>
<!-- End Google Tag Manager -->`,
		body: `<!-- Google Tag Manager (noscript) -->
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${id}"
height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
<!-- End Google Tag Manager (noscript) -->`
	};
}
