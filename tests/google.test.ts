import { describe, expect, it, vi } from 'vitest';
import { GoogleApiError, googleJson, RealClient, buildAuthUrl, SCOPE_WRITE } from '../src/lib/server/google';

const res = (status: number, body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers });

describe('googleJson', () => {
	const token = async () => 'tok';
	it('retries 429/5xx with backoff and honours Retry-After, then succeeds', async () => {
		const f = vi.fn().mockResolvedValueOnce(res(429, {}, { 'retry-after': '2' })).mockResolvedValueOnce(res(503, {})).mockResolvedValueOnce(res(200, { ok: 1 }));
		const sleeps: number[] = [];
		const out = await googleJson<{ ok: number }>(token, 'https://x', {}, { fetchImpl: f as never, sleepImpl: async (ms) => void sleeps.push(ms) });
		expect(out.ok).toBe(1);
		expect(f).toHaveBeenCalledTimes(3);
		expect(sleeps[0]).toBe(2000);
		expect(sleeps[1]).toBeGreaterThanOrEqual(1600);
	});
	it('gives up after the retry budget', async () => {
		const f = vi.fn().mockResolvedValue(res(500, { error: { message: 'boom' } }));
		await expect(googleJson(token, 'https://x', {}, { fetchImpl: f as never, sleepImpl: async () => {}, retries: 2 })).rejects.toThrow('boom');
		expect(f).toHaveBeenCalledTimes(3);
	});
	it('does not retry client errors and surfaces the Google message', async () => {
		const f = vi.fn().mockResolvedValue(res(403, { error: { message: 'User does not have sufficient permission', status: 'PERMISSION_DENIED' } }));
		const e = (await googleJson(token, 'https://x', {}, { fetchImpl: f as never }).catch((x) => x)) as GoogleApiError;
		expect(e).toBeInstanceOf(GoogleApiError);
		expect(e.status).toBe(403);
		expect(f).toHaveBeenCalledTimes(1);
	});
	it('sends the bearer token', async () => {
		const f = vi.fn().mockResolvedValue(res(200, {}));
		await googleJson(token, 'https://x', { method: 'POST', body: '{}' }, { fetchImpl: f as never });
		expect((f.mock.calls[0][1].headers as Record<string, string>).authorization).toBe('Bearer tok');
	});
});

describe('RealClient URL building', () => {
	it('percent-encodes site URLs (including sc-domain:) and sitemap paths', async () => {
		const f = vi.fn().mockImplementation(async () => res(200, {}));
		const c = new RealClient(1, { fetchImpl: f as never });
		// accessToken() reads the DB; bypass by stubbing the private caller's token source
		(c as never as { call: unknown }).call = (url: string, init?: RequestInit) => googleJson(async () => 't', url, init, { fetchImpl: f as never });
		await c.query('sc-domain:example.com', { startDate: '2026-01-01', endDate: '2026-01-02' });
		await c.submitSitemap('https://example.com/', 'https://example.com/sitemap.xml');
		const urls = f.mock.calls.map((x) => x[0] as string);
		expect(urls[0]).toBe('https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query');
		expect(urls[1]).toBe('https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fexample.com%2F/sitemaps/https%3A%2F%2Fexample.com%2Fsitemap.xml');
		expect(f.mock.calls[1][1].method).toBe('PUT');
	});
});

describe('OAuth URL', () => {
	it('asks for offline access and the write scope', () => {
		process.env.GOOGLE_CLIENT_ID = 'cid';
		const u = new URL(buildAuthUrl('state123'));
		expect(u.searchParams.get('access_type')).toBe('offline');
		expect(u.searchParams.get('scope')).toContain(SCOPE_WRITE);
		expect(u.searchParams.get('state')).toBe('state123');
		expect(u.searchParams.get('redirect_uri')).toMatch(/\/auth\/callback$/);
	});
});
