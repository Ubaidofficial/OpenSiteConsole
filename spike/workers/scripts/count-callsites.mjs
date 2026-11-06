#!/usr/bin/env node
/**
 * Counts, with the TypeScript type checker (not regexes), every better-sqlite3 call in src/ that is
 * synchronous today and would need `await` under D1, plus how far that colouring spreads through the call graph.
 *
 *   node spike/workers/scripts/count-callsites.mjs            # human table
 *   node spike/workers/scripts/count-callsites.mjs --json     # machine readable
 *
 * Needs `pnpm exec svelte-kit sync` to have run once (it generates .svelte-kit/tsconfig.json with the $lib alias).
 *
 * Definitions
 *  - direct site:       a call expression whose receiver type is better-sqlite3 Statement (.get/.all/.run/.iterate/.pluck/...)
 *                       or Database (.exec/.pragma/.transaction/.prepare). Statements held in a variable (`ins.run(...)`) count.
 *  - await-needed site: .get / .all / .run / .iterate on a Statement, plus .exec / .pragma on a Database.
 *                       (.prepare is free under D1 (it only builds a statement), so it is counted separately.)
 *  - sync-only pattern: constructs with no direct D1 equivalent (see the spike report).
 *  - transitive:        a function that (transitively) contains a direct site must become async; every call to such a
 *                       function must then be awaited. Resolved with the checker's symbol table. Methods and arrow
 *                       functions assigned to variables are handled; calls through function-typed values, dynamic
 *                       dispatch and callbacks are NOT followed, so the transitive numbers are a LOWER bound.
 */
import ts from 'typescript';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const asJson = process.argv.includes('--json');

const cfgPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
const cfg = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); } });
const files = cfg.fileNames.filter((f) => f.startsWith(path.join(root, 'src') + path.sep) && /\.ts$/.test(f) && !f.endsWith('.d.ts'));
const program = ts.createProgram(files, cfg.options);
const checker = program.getTypeChecker();

const rel = (f) => path.relative(root, f);
const typeName = (t) => (t.symbol?.escapedName ?? t.aliasSymbol?.escapedName ?? '').toString();
const isStatement = (t) => typeName(t) === 'Statement';
const isDatabase = (t) => typeName(t) === 'Database';

const STMT_AWAIT = new Set(['get', 'all', 'run', 'iterate']);
const DB_AWAIT = new Set(['exec', 'pragma']);

/** @type {Map<string, any>} */
const perFile = new Map();
const fileStats = (f) => {
	const k = rel(f);
	if (!perFile.has(k)) perFile.set(k, { file: k, prepare: 0, get: 0, all: 0, run: 0, iterate: 0, exec: 0, pragma: 0, transaction: 0, lastInsertRowid: 0, changes: 0, insertOrReplace: 0, inLoopOrCallback: 0, awaitNeeded: 0, asyncFns: 0, transitiveCalls: 0, syncToAsync: 0, getters: 0, newAwaits: 0, transitiveInCallback: 0 });
	return perFile.get(k);
};

/** funcNode -> {name, file} for functions that directly contain a DB call */
const funcKey = (n) => `${n.getSourceFile().fileName}:${n.pos}`;
const directFuncs = new Map();
const enclosingFunction = (n) => {
	for (let p = n.parent; p; p = p.parent) if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p) || ts.isArrowFunction(p) || ts.isFunctionExpression(p) || ts.isGetAccessor(p)) return p;
	return null;
};
/** Is the node inside a callback that is passed to Array.prototype.map/filter/forEach/etc (cannot just add `await`)? */
const ARRAY_CB = new Set(['map', 'filter', 'forEach', 'reduce', 'sort', 'some', 'every', 'flatMap', 'find']);
const inArrayCallback = (n) => {
	for (let p = n.parent; p; p = p.parent) {
		if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && ARRAY_CB.has(p.parent.expression.name.text)) return true;
		if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return false;
	}
	return false;
};
const inTransactionCallback = (n) => {
	for (let p = n.parent; p; p = p.parent) {
		if ((ts.isArrowFunction(p) || ts.isFunctionExpression(p)) && p.parent && ts.isCallExpression(p.parent) && ts.isPropertyAccessExpression(p.parent.expression) && p.parent.expression.name.text === 'transaction') return true;
	}
	return false;
};

/** transaction callbacks: classify by what is inside (loop-driven writes vs reads that feed later writes) */
const txns = [];
const pass1Calls = [];
for (const sf of program.getSourceFiles()) {
	if (!files.includes(sf.fileName)) continue;
	const visit = (n) => {
		if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
			const name = n.expression.name.text;
			const recvT = checker.getTypeAtLocation(n.expression.expression);
			const st = fileStats(sf.fileName);
			if (isStatement(recvT) && STMT_AWAIT.has(name)) {
				st[name]++; st.awaitNeeded++;
				if (inArrayCallback(n)) st.inLoopOrCallback++;
				const fn = enclosingFunction(n);
				if (fn) directFuncs.set(funcKey(fn), fn);
			} else if (isDatabase(recvT) && DB_AWAIT.has(name)) {
				st[name]++; st.awaitNeeded++;
				const fn = enclosingFunction(n);
				if (fn) directFuncs.set(funcKey(fn), fn);
			} else if (isDatabase(recvT) && name === 'prepare') {
				st.prepare++;
				const a = n.arguments[0];
				const txt = a ? a.getText(sf) : '';
				if (/INSERT\s+OR\s+REPLACE/i.test(txt)) st.insertOrReplace++;
			} else if (isDatabase(recvT) && name === 'transaction') {
				st.transaction++;
				const cb = n.arguments[0];
				let reads = 0, writes = 0, loops = 0, other = 0;
				const scan = (m) => {
					if (ts.isForStatement(m) || ts.isForOfStatement(m) || ts.isForInStatement(m) || ts.isWhileStatement(m)) loops++;
					if (ts.isCallExpression(m) && ts.isPropertyAccessExpression(m.expression)) {
						const nm = m.expression.name.text;
						const rt = checker.getTypeAtLocation(m.expression.expression);
						if (isStatement(rt) && (nm === 'get' || nm === 'all')) reads++;
						else if (isStatement(rt) && nm === 'run') writes++;
					}
					if (ts.isAwaitExpression(m)) other++;
					ts.forEachChild(m, scan);
				};
				if (cb) scan(cb);
				const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
				txns.push({ at: `${rel(sf.fileName)}:${line + 1}`, reads, writes, loops, awaitInside: other });
				const fn = enclosingFunction(n);
				if (fn) directFuncs.set(funcKey(fn), fn);
			}
		}
		if (ts.isPropertyAccessExpression(n)) {
			if (n.name.text === 'lastInsertRowid') fileStats(sf.fileName).lastInsertRowid++;
			if (n.name.text === 'changes') {
				const t = checker.getTypeAtLocation(n.expression);
				if (typeName(t) === 'RunResult') fileStats(sf.fileName).changes++;
			}
		}
		ts.forEachChild(n, visit);
	};
	visit(sf);
}

// Transitive closure: any function that calls a coloured function becomes coloured.
const coloured = new Map(directFuncs); // key -> node
const declOfCall = (call) => {
	let sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression);
	if (!sym) return [];
	if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
	return (sym.declarations ?? []).map((d) => {
		if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer;
		return d;
	});
};
let changed = true;
const callsToColoured = new Map(); // callsite key -> {file}
while (changed) {
	changed = false;
	callsToColoured.clear();
	for (const sf of program.getSourceFiles()) {
		if (!files.includes(sf.fileName)) continue;
		const visit = (n) => {
			if (ts.isCallExpression(n)) {
				const targets = declOfCall(n);
				if (targets.some((t) => coloured.has(funcKey(t)))) {
					callsToColoured.set(`${sf.fileName}:${n.pos}`, { file: sf.fileName, node: n });
					const fn = enclosingFunction(n);
					if (fn && !coloured.has(funcKey(fn))) { coloured.set(funcKey(fn), fn); changed = true; }
				}
			}
			ts.forEachChild(n, visit);
		};
		visit(sf);
	}
}
const isAsync = (fn) => !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
for (const fn of coloured.values()) {
	const st = fileStats(fn.getSourceFile().fileName);
	st.asyncFns++;
	if (!isAsync(fn)) st.syncToAsync++;
	if (ts.isGetAccessor(fn)) st.getters++;
}
for (const c of callsToColoured.values()) {
	const st = fileStats(c.file);
	st.transitiveCalls++;
	const awaited = ts.isAwaitExpression(c.node.parent) || (ts.isParenthesizedExpression(c.node.parent) && ts.isAwaitExpression(c.node.parent.parent));
	if (!awaited) st.newAwaits++;
	if (inArrayCallback(c.node)) st.transitiveInCallback++;
}

if (process.argv.includes('--txns')) {
	for (const t of txns) console.log(`${t.at}  writes=${t.writes} reads=${t.reads} loop=${t.loops ? 'yes' : 'no'}${t.reads ? '   <-- reads inside: not expressible as a plain batch()' : ''}`);
	process.exit(0);
}
if (process.argv.includes('--hazards')) {
	for (const c of callsToColoured.values()) if (inArrayCallback(c.node)) { const { line } = c.node.getSourceFile().getLineAndCharacterOfPosition(c.node.getStart()); console.log(`${rel(c.file)}:${line + 1}  ${c.node.getText().slice(0, 90).replace(/\s+/g, ' ')}`); }
	process.exit(0);
}
const rows = [...perFile.values()].filter((r) => r.awaitNeeded || r.prepare || r.transaction || r.asyncFns || r.transitiveCalls).sort((a, b) => b.awaitNeeded - a.awaitNeeded || a.file.localeCompare(b.file));
const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
const lib = rows.filter((r) => r.file.startsWith('src/lib/server/'));
const rts = rows.filter((r) => r.file.startsWith('src/routes/') || r.file.startsWith('src/hooks'));
const stmts = { prepare: sum('prepare'), awaitNeeded: sum('awaitNeeded'), get: sum('get'), all: sum('all'), run: sum('run'), iterate: sum('iterate'), exec: sum('exec'), pragma: sum('pragma'), transaction: sum('transaction'), lastInsertRowid: sum('lastInsertRowid'), changes: sum('changes'), insertOrReplace: sum('insertOrReplace'), inArrayCallback: sum('inLoopOrCallback'), functionsBecomingAsync: sum('asyncFns'), callsNeedingAwaitTransitively: sum('transitiveCalls'), syncFunctionsBecomingAsync: sum('syncToAsync'), gettersBecomingAsync: sum('getters'), callsMissingAwaitToday: sum('newAwaits'), transitiveCallsInArrayCallbacks: sum('transitiveInCallback') };

if (asJson) {
	console.log(JSON.stringify({ totals: stmts, files: rows }, null, 2));
} else {
	const pad = (s, n) => String(s).padStart(n);
	console.log('file'.padEnd(44) + ['prep', 'get', 'all', 'run', 'exec', 'prag', 'txn', 'rowid', 'AWAIT', 'asyncFn', 'callers'].map((h) => pad(h, 8)).join(''));
	for (const r of rows) console.log(r.file.padEnd(44) + [r.prepare, r.get, r.all, r.run, r.exec, r.pragma, r.transaction, r.lastInsertRowid, r.awaitNeeded, r.asyncFns, r.transitiveCalls].map((v) => pad(v, 8)).join(''));
	console.log('-'.repeat(44 + 88));
	console.log('TOTAL'.padEnd(44) + [stmts.prepare, stmts.get, stmts.all, stmts.run, stmts.exec, stmts.pragma, stmts.transaction, stmts.lastInsertRowid, stmts.awaitNeeded, stmts.functionsBecomingAsync, stmts.callsNeedingAwaitTransitively].map((v) => pad(v, 8)).join(''));
	console.log(`\nsrc/lib/server direct await-needed: ${lib.reduce((s, r) => s + r.awaitNeeded, 0)}   src/routes+hooks direct: ${rts.reduce((s, r) => s + r.awaitNeeded, 0)}`);
	console.log(`direct sites inside Array.map/filter/forEach/... callbacks (cannot simply be awaited): ${stmts.inArrayCallback}`);
	console.log(`functions (incl. arrow fns/route handlers) that must become async: ${stmts.functionsBecomingAsync}, of which currently sync: ${stmts.syncFunctionsBecomingAsync}; getters: ${stmts.gettersBecomingAsync}`);
	console.log(`calls to those functions: ${stmts.callsNeedingAwaitTransitively}, of which have no await today: ${stmts.callsMissingAwaitToday}; inside Array callbacks: ${stmts.transitiveCallsInArrayCallbacks}`);
	console.log(`INSERT OR REPLACE prepared statements: ${stmts.insertOrReplace}; RunResult.changes reads: ${stmts.changes}; .iterate: ${stmts.iterate}`);
}
