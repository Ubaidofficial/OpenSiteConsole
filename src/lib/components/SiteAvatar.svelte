<script lang="ts">
	/** Letter avatar with a hue derived from the name. Deliberately not a favicon: nothing leaves this machine. */
	let { name, class: className = '' }: { name: string; class?: string } = $props();
	const hue = $derived([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7));
	const letter = $derived((name.replace(/^(www\.|https?:\/\/)/, '')[0] ?? '?').toUpperCase());
</script>

<span class="avatar grid size-10 shrink-0 place-items-center rounded-xl text-base font-semibold {className}" style="--h:{hue}" aria-hidden="true">{letter}</span>
