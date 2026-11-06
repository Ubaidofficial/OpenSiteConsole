/**
 * The async `Db` interface that would replace `db()` (better-sqlite3, synchronous) across src/lib/server.
 *
 *   today:  db().prepare('SELECT ... WHERE id = ?').get(id)
 *   after:  await db.get('SELECT ... WHERE id = ?', id)
 *
 *   today:  d.transaction(() => { del.run(...); for (const r of rows) ins.run(...) })()
 *   after:  await db.batch([q('DELETE ...', ...), ...rows.map((r) => q('INSERT ...', ...))])
 *
 * Two implementations exist: D1Db (Workers) and, Node-side only, SqliteDb in test/sqlite-db.ts (better-sqlite3 behind the
 * same async surface, so the same ported code can be run against both engines).
 */

export type Param = string | number | null;
export interface Stmt {
	sql: string;
	args: Param[];
}
export const q = (sql: string, ...args: Param[]): Stmt => ({ sql, args });

export interface RunInfo {
	/** rows changed by the statement */
	changes: number;
	/** better-sqlite3's `lastInsertRowid`, from D1's `meta.last_row_id` (only meaningful for rowid tables) */
	lastInsertRowid: number;
	rows: unknown[];
}

export interface Db {
	get<T = Record<string, unknown>>(sql: string, ...args: Param[]): Promise<T | undefined>;
	all<T = Record<string, unknown>>(sql: string, ...args: Param[]): Promise<T[]>;
	run(sql: string, ...args: Param[]): Promise<RunInfo>;
	/**
	 * Run statements in order inside ONE transaction: all commit or none do (D1: "Batched statements are SQL transactions").
	 * One round trip, and one "query" against the per-invocation query limit, however many statements it holds.
	 * Reads may be included; their rows come back in `rows`. No statement can see JS state computed from an earlier one.
	 */
	batch(stmts: Stmt[]): Promise<RunInfo[]>;
	/** Instrumentation, so the proof can show what a page load / sync step costs in D1 round trips. */
	readonly stats: { roundTrips: number; statements: number };
}

// Minimal structural types so this file needs no @cloudflare/workers-types.
interface D1Result {
	results?: unknown[];
	meta: { changes?: number; last_row_id?: number };
}
interface D1PreparedStatement {
	bind(...args: unknown[]): D1PreparedStatement;
	all(): Promise<D1Result>;
	first<T>(): Promise<T | null>;
	run(): Promise<D1Result>;
}
export interface D1DatabaseLike {
	prepare(sql: string): D1PreparedStatement;
	batch(stmts: D1PreparedStatement[]): Promise<D1Result[]>;
}

const info = (r: D1Result): RunInfo => ({ changes: r.meta.changes ?? 0, lastInsertRowid: r.meta.last_row_id ?? 0, rows: r.results ?? [] });

export class D1Db implements Db {
	readonly stats = { roundTrips: 0, statements: 0 };
	constructor(private d1: D1DatabaseLike) {}

	private stmt(s: Stmt) {
		return this.d1.prepare(s.sql).bind(...s.args);
	}
	async get<T>(sql: string, ...args: Param[]): Promise<T | undefined> {
		this.stats.roundTrips++;
		this.stats.statements++;
		return (await this.d1.prepare(sql).bind(...args).first<T>()) ?? undefined;
	}
	async all<T>(sql: string, ...args: Param[]): Promise<T[]> {
		this.stats.roundTrips++;
		this.stats.statements++;
		return ((await this.d1.prepare(sql).bind(...args).all()).results ?? []) as T[];
	}
	async run(sql: string, ...args: Param[]): Promise<RunInfo> {
		this.stats.roundTrips++;
		this.stats.statements++;
		return info(await this.d1.prepare(sql).bind(...args).run());
	}
	async batch(stmts: Stmt[]): Promise<RunInfo[]> {
		if (!stmts.length) return [];
		this.stats.roundTrips++;
		this.stats.statements += stmts.length;
		return (await this.d1.batch(stmts.map((s) => this.stmt(s)))).map(info);
	}
}
