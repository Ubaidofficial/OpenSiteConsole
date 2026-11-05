/** Core Web Vitals thresholds as published by Google (web.dev/vitals). Times are milliseconds; CLS is unitless. */
export type VitalKey = 'lcp' | 'inp' | 'cls' | 'fcp' | 'ttfb';
export type Rating = 'good' | 'needs-improvement' | 'poor';

export const VITALS: { key: VitalKey; name: string; long: string; unit: 'ms' | '' ; good: number; poor: number; core: boolean }[] = [
	{ key: 'lcp', name: 'LCP', long: 'Largest Contentful Paint', unit: 'ms', good: 2500, poor: 4000, core: true },
	{ key: 'inp', name: 'INP', long: 'Interaction to Next Paint', unit: 'ms', good: 200, poor: 500, core: true },
	{ key: 'cls', name: 'CLS', long: 'Cumulative Layout Shift', unit: '', good: 0.1, poor: 0.25, core: true },
	{ key: 'fcp', name: 'FCP', long: 'First Contentful Paint', unit: 'ms', good: 1800, poor: 3000, core: false },
	{ key: 'ttfb', name: 'TTFB', long: 'Time to First Byte', unit: 'ms', good: 800, poor: 1800, core: false }
];

export function rate(key: VitalKey, value: number | null | undefined): Rating | null {
	if (value == null || !Number.isFinite(value)) return null;
	const v = VITALS.find((x) => x.key === key)!;
	return value <= v.good ? 'good' : value > v.poor ? 'poor' : 'needs-improvement';
}

export function fmtVital(key: VitalKey, value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return '–';
	if (key === 'cls') return value.toFixed(2);
	return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}
