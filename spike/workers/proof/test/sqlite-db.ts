/** Node-only: the async `Db` surface over better-sqlite3, so the PORTED code can also be run on the original engine. */
import type BetterSqlite3 from 'better-sqlite3';
import type { Db, Param, RunInfo, Stmt } from '../src/db';

export class SqliteDb implements Db {
	readonly stats = { roundTrips: 0, statements: 0 };
	constructor(private d: BetterSqlite3.Database) {}
	async get<T>(sql: string, ...args: Param[]) {
		this.stats.roundTrips++;
		this.stats.statements++;
		return this.d.prepare(sql).get(...args) as T | undefined;
	}
	async all<T>(sql: string, ...args: Param[]) {
		this.stats.roundTrips++;
		this.stats.statements++;
		return this.d.prepare(sql).all(...args) as T[];
	}
	private exec(s: Stmt): RunInfo {
		const st = this.d.prepare(s.sql);
		if (st.reader) return { changes: 0, lastInsertRowid: 0, rows: st.all(...s.args) };
		const r = st.run(...s.args);
		return { changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid), rows: [] };
	}
	async run(sql: string, ...args: Param[]) {
		this.stats.roundTrips++;
		this.stats.statements++;
		return this.exec({ sql, args });
	}
	async batch(stmts: Stmt[]) {
		if (!stmts.length) return [];
		this.stats.roundTrips++;
		this.stats.statements += stmts.length;
		return this.d.transaction(() => stmts.map((s) => this.exec(s)))();
	}
}
