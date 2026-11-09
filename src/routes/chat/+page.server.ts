import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { chatDailyLimit, chatModel, chatReady, deleteThread, displayItems, getThread, listThreads, pendingOf, sentToday, threadMessages } from '$lib/server/chat';
import { STARTERS } from '$lib/chat';

export const load: PageServerLoad = ({ locals, url }) => {
	const user = locals.user!;
	const id = Number(url.searchParams.get('t'));
	const thread = Number.isInteger(id) && id > 0 ? getThread(user, id) : null;
	const pending = thread ? pendingOf(thread) : null;
	const waiting = new Set(pending?.awaiting.map((a) => a.id) ?? []);
	return {
		ready: chatReady(),
		model: chatModel(),
		role: user.role,
		threads: listThreads(user),
		thread: thread ? { id: thread.id, title: thread.title } : null,
		// tool calls waiting for approval are shown as the approval card, not as a running step
		items: thread ? displayItems(threadMessages(thread.id), user).filter((i) => !(i.kind === 'tool' && waiting.has(i.tool.id))) : [],
		approvals: pending?.awaiting ?? [],
		starters: STARTERS,
		q: url.searchParams.get('q')?.slice(0, 2000) ?? '',
		usage: { sent: sentToday(user), limit: chatDailyLimit() }
	};
};

export const actions: Actions = {
	delete: async ({ request, locals, url }) => {
		const id = Number((await request.formData()).get('id'));
		if (!deleteThread(locals.user!, id)) return fail(404, { error: 'That conversation was not found.' });
		if (Number(url.searchParams.get('t')) === id) redirect(303, '/chat');
		return { ok: 'Conversation deleted' };
	}
};
