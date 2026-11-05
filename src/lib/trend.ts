export type Trend = 'up' | 'down' | 'flat';

/**
 * Direction of a daily series from its own shape: compare the first and last half. Tiny or flat series
 * count as "flat" so a handful of clicks never paints a card red or green.
 */
export function seriesTrend(values: number[], minTotal = 4, minChange = 0.15): Trend {
	const n = values.length;
	if (n < 4) return 'flat';
	const h = Math.floor(n / 2);
	const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
	const first = sum(values.slice(0, h));
	const last = sum(values.slice(n - h));
	if (first + last < minTotal) return 'flat';
	const change = (last - first) / Math.max(first, last);
	return change >= minChange ? 'up' : change <= -minChange ? 'down' : 'flat';
}

/**
 * Card colour: follow the period-over-period change when there is a reliable one (so the line and the
 * percentage beside it always agree); otherwise fall back to the series' own shape.
 */
export function trendOf(delta: number | null, values: number[]): Trend {
	// Same ±0.5% cutoff as the percentage text next to the chart, so the line and the number never disagree.
	if (delta != null) return delta >= 0.005 ? 'up' : delta <= -0.005 ? 'down' : 'flat';
	return seriesTrend(values);
}
