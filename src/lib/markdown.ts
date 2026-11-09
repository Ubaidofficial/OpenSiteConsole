/**
 * A small Markdown renderer for chat answers: headings, paragraphs, bold, italics, inline code, code blocks, lists, tables and links.
 * Safe by construction: every character of the input is HTML-escaped first, and only the tags written below are ever produced, so text
 * from search queries or page titles that the model repeats cannot inject markup. Links must be http(s) and open in a new tab.
 * Pure, unit-tested.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Inline formatting on text that is already escaped. Code spans are cut out first so nothing inside them is formatted. */
function inline(escaped: string): string {
	const codes: string[] = [];
	let s = escaped.replace(/`([^`\n]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
	s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer nofollow">${t}</a>`);
	s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
	s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
	return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

export function renderMarkdown(src: string): string {
	const lines = esc(src.replace(/\r\n?/g, '\n')).split('\n');
	const out: string[] = [];
	let para: string[] = [];
	const flush = () => {
		if (para.length) out.push(`<p>${para.map(inline).join('<br>')}</p>`);
		para = [];
	};
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const fence = /^\s*```/.exec(line);
		if (fence) {
			flush();
			const body: string[] = [];
			while (++i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i]);
			out.push(`<pre tabindex="0"><code>${body.join('\n')}</code></pre>`);
			continue;
		}
		const h = /^(#{1,4})\s+(.+)$/.exec(line);
		if (h) {
			flush();
			const level = Math.min(h[1].length + 2, 6); // # becomes h3: a chat answer sits inside the page's own headings
			out.push(`<h${level}>${inline(h[2])}</h${level}>`);
			continue;
		}
		if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
			flush();
			const head = cells(line);
			const rows: string[][] = [];
			i++;
			while (i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].trim()) rows.push(cells(lines[++i]));
			const num = (c: string) => /^[-+]?[\d.,]+%?$/.test(c.replace(/[\s()]/g, ''));
			out.push(`<div class="md-table" tabindex="0"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => `<td${num(r[j] ?? '') ? ' class="num"' : ''}>${inline(r[j] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
			continue;
		}
		const li = /^\s*([-*]|\d+[.)])\s+(.+)$/.exec(line);
		if (li) {
			flush();
			const ordered = /\d/.test(li[1]);
			const items: string[] = [li[2]];
			while (i + 1 < lines.length) {
				const next = /^\s*([-*]|\d+[.)])\s+(.+)$/.exec(lines[i + 1]);
				if (next && /\d/.test(next[1]) === ordered) (items.push(next[2]), i++);
				else if (lines[i + 1].trim() && /^\s{2,}\S/.test(lines[i + 1])) (items[items.length - 1] += ' ' + lines[++i].trim());
				else break;
			}
			const tag = ordered ? 'ol' : 'ul';
			out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
			continue;
		}
		if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
			flush();
			out.push('<hr>');
			continue;
		}
		if (!line.trim()) flush();
		else para.push(line.trim());
	}
	flush();
	return out.join('');
}
