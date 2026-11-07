<script lang="ts">
	import { VERDICT_LABEL, type Cell } from '$lib/compare';
	let { cell }: { cell: Cell } = $props();
	// The word is always shown with the symbol, so the table does not depend on colour.
	const tone = { yes: 'text-good', partial: 'text-warn', no: 'text-bad', unknown: 'text-muted-foreground' } as const;
	const mark = { yes: '✓', partial: '◐', no: '✕', unknown: '?' } as const;
</script>

<div class="text-sm"><span class="font-medium {tone[cell.v]}"><span aria-hidden="true">{mark[cell.v]}</span> {VERDICT_LABEL[cell.v]}</span>{#if cell.note}<div class="mt-0.5 text-xs text-muted-foreground">{cell.note}</div>{/if}</div>
