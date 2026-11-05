export const fmtInt = (n: number | null | undefined) => (n == null ? '–' : Math.round(n).toLocaleString('en-US'));
export const fmtCompact = (n: number) => Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const fmtPct = (n: number | null | undefined, digits = 1) => (n == null || !Number.isFinite(n) ? '–' : `${(n * 100).toFixed(digits)}%`);
export const fmtPos = (n: number | null | undefined) => (n ? n.toFixed(1) : '–');
/** Signed percent. A change above +999% is shown as ">+999%": beyond that the exact figure is noise, not information. */
export const fmtSigned = (n: number | null, digits = 1) => {
	if (n == null || !Number.isFinite(n)) return '–';
	if (n > 9.99) return '>+999%';
	return `${n >= 0 ? '+' : '−'}${Math.abs(n * 100).toFixed(digits)}%`;
};
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '');
export function ago(ms: number | null): string {
	if (!ms) return 'never';
	const s = Math.round((Date.now() - ms) / 1000);
	if (s < 90) return 'just now';
	if (s < 5400) return `${Math.round(s / 60)} min ago`;
	if (s < 129600) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
}
