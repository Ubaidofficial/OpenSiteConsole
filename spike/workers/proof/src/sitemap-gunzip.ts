/**
 * Port of `sitemapText` from src/lib/server/sitemapcov.ts: node:zlib gunzipSync -> DecompressionStream.
 *
 * Differences worth knowing:
 *  - gunzipSync(buf, { maxOutputLength }) throws when the output would exceed the cap. DecompressionStream has no such
 *    option, so the cap is enforced here while reading chunks (and the stream is cancelled), keeping the zip-bomb guard.
 *  - it is async (stream based) instead of sync, so `sitemapText` and its callers become async.
 */
export const UNZIPPED_CAP = 40_000_000;

export async function sitemapText(buf: Uint8Array, cap = UNZIPPED_CAP): Promise<string> {
	if (!(buf[0] === 0x1f && buf[1] === 0x8b)) return new TextDecoder().decode(buf);
	const reader = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.length;
		if (total > cap) {
			await reader.cancel();
			throw new Error('decompressed sitemap exceeds cap');
		}
		chunks.push(value);
	}
	const out = new Uint8Array(total);
	let o = 0;
	for (const c of chunks) (out.set(c, o), (o += c.length));
	return new TextDecoder().decode(out);
}
