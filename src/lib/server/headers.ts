/** Response headers every page gets. Pure so it can be tested. */
export function securityHeaders(o: { https: boolean; hasCacheControl: boolean }): Record<string, string> {
	const h: Record<string, string> = {
		'x-frame-options': 'DENY',
		'referrer-policy': 'same-origin',
		'x-content-type-options': 'nosniff',
		'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin'
	};
	// Behind HTTPS only (HSTS over plain http is ignored by browsers and misleading). No includeSubDomains/preload: those are the
	// site owner's decision, not this app's.
	if (o.https) h['strict-transport-security'] = 'max-age=15552000';
	// Everything dynamic here is private (an owner's data, a login), so shared caches and the back button must not keep it.
	// Static assets from /_app already carry their own cache headers.
	if (!o.hasCacheControl) h['cache-control'] = 'private, no-store';
	return h;
}
