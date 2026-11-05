/** Privacy mode: blurs anything marked .pii. Persisted per browser; applied via <html data-privacy>. */
class Privacy {
	on = $state(false);

	init() {
		try {
			this.on = localStorage.getItem('osc_privacy') === '1';
		} catch {
			/* storage blocked: stay off */
		}
		this.apply();
	}

	toggle() {
		this.on = !this.on;
		try {
			localStorage.setItem('osc_privacy', this.on ? '1' : '0');
		} catch {
			/* ignore */
		}
		this.apply();
	}

	private apply() {
		if (this.on) document.documentElement.dataset.privacy = 'on';
		else delete document.documentElement.dataset.privacy;
	}
}

export const privacy = new Privacy();
