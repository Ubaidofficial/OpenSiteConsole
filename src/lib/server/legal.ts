import { env } from './config';
import type { LegalContext } from '../legal';

/** Who the privacy policy and terms speak for, from the environment. `configured` is false until the operator names themselves and a contact. */
export function legalContext(): { context: LegalContext; configured: boolean } {
	const entity = env('LEGAL_ENTITY').trim();
	const contact = env('LEGAL_CONTACT_EMAIL').trim();
	const law = env('LEGAL_GOVERNING_LAW').trim();
	return {
		configured: !!entity && !!contact,
		context: { entity: entity || 'the operator of this SEOConsole installation', contact: contact || null, law: law || null, updated: env('LEGAL_UPDATED', '2026-11-14') }
	};
}
