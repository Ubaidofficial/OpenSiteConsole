<script lang="ts" module>
	import { tv, type VariantProps } from 'tailwind-variants';

	/** shadcn-svelte Button variants (hand-written to the same API). */
	export const buttonVariants = tv({
		base: "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-[13px] font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
		variants: {
			variant: {
				default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
				destructive: 'bg-destructive text-white shadow-xs hover:bg-destructive/90',
				outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
				secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
				ghost: 'hover:bg-accent hover:text-accent-foreground',
				link: 'text-link underline-offset-4 hover:underline'
			},
			size: {
				default: 'h-9 px-4 py-2',
				sm: 'h-8 gap-1.5 rounded-md px-3',
				icon: 'size-9'
			}
		},
		defaultVariants: { variant: 'default', size: 'default' }
	});

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';

	type Props = (HTMLButtonAttributes & HTMLAnchorAttributes) & { variant?: ButtonVariant; size?: ButtonSize; href?: string };
	let { class: className, variant = 'default', size = 'default', href, children, ...rest }: Props = $props();
</script>

{#if href}
	<a {href} class={cn(buttonVariants({ variant, size }), className)} {...rest as HTMLAnchorAttributes}>{@render children?.()}</a>
{:else}
	<button class={cn(buttonVariants({ variant, size }), className)} {...rest as HTMLButtonAttributes}>{@render children?.()}</button>
{/if}
