/** Theme: light (the default) or a dim dark. Persisted per browser; applied as class="dark" on <html> (src/app.html does it before first paint). */
class Theme {
	dim = $state(false);

	init() {
		try {
			this.dim = localStorage.getItem('osc_theme') === 'dim';
		} catch {
			/* storage blocked: stay light */
		}
		this.apply();
	}

	toggle() {
		this.dim = !this.dim;
		try {
			localStorage.setItem('osc_theme', this.dim ? 'dim' : 'light');
		} catch {
			/* ignore: it still applies for this visit */
		}
		this.apply();
	}

	private apply() {
		const root = document.documentElement;
		root.classList.toggle('dark', this.dim);
		document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', this.dim ? 'dark' : 'light');
		// the same colours as --background in each theme, so a phone's address bar matches the page
		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.dim ? '#26282d' : '#fafaf9');
	}
}

export const theme = new Theme();
