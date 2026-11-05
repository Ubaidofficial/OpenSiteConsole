import { PERIODS } from '../periods';

export function daysParam(url: URL): number {
	const n = Number(url.searchParams.get('days'));
	return (PERIODS as readonly number[]).includes(n) ? n : 28;
}

export function intParam(v: FormDataEntryValue | string | null | undefined): number {
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0) throw new Error('Invalid id');
	return n;
}
