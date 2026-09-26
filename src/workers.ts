import { DatabaseSync } from 'node:sqlite';

// Workers: conversations of the generic Worker agent, each given a role by the Chief of
// Staff. Their definitions live in the app's own small database (data/workers.db), apart
// from Flue's tables. Retiring a worker only marks it; its conversation is kept.

export const WORKER_CAPABILITIES = ['search', 'browser'] as const;
export type WorkerCapability = (typeof WORKER_CAPABILITIES)[number];

/** Most workers active at once; the chief retires one before spawning past this. */
export const MAX_ACTIVE_WORKERS = 5;

export interface Worker {
	/** The Worker agent's conversation id. */
	id: string;
	role: string;
	instructions: string;
	capabilities: WorkerCapability[];
	/** Thread of the agent that spawned it, where its reports go. */
	createdBy: string;
	createdAt: number;
	status: 'active' | 'retired';
}

let db: DatabaseSync | undefined;
function open() {
	if (!db) {
		db = new DatabaseSync(new URL('../data/workers.db', import.meta.url).pathname);
		db.exec(`CREATE TABLE IF NOT EXISTS workers (
			id TEXT PRIMARY KEY,
			role TEXT NOT NULL,
			instructions TEXT NOT NULL,
			capabilities TEXT NOT NULL,
			created_by TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			status TEXT NOT NULL
		)`);
	}
	return db;
}

type Row = {
	id: string;
	role: string;
	instructions: string;
	capabilities: string;
	created_by: string;
	created_at: number;
	status: Worker['status'];
};
const toWorker = (r: Row): Worker => ({
	id: r.id,
	role: r.role,
	instructions: r.instructions,
	capabilities: JSON.parse(r.capabilities),
	createdBy: r.created_by,
	createdAt: r.created_at,
	status: r.status,
});

export function getWorker(id: string): Worker | undefined {
	const row = open().prepare('SELECT * FROM workers WHERE id = ?').get(id) as Row | undefined;
	return row && toWorker(row);
}

export function listWorkers(status?: Worker['status']): Worker[] {
	const rows = (
		status
			? open().prepare('SELECT * FROM workers WHERE status = ? ORDER BY created_at DESC').all(status)
			: open().prepare('SELECT * FROM workers ORDER BY created_at DESC').all()
	) as Row[];
	return rows.map(toWorker);
}

export function createWorker(worker: Omit<Worker, 'createdAt' | 'status'>): Worker {
	const created: Worker = { ...worker, createdAt: Date.now(), status: 'active' };
	open()
		.prepare('INSERT INTO workers VALUES (?, ?, ?, ?, ?, ?, ?)')
		.run(
			created.id,
			created.role,
			created.instructions,
			JSON.stringify(created.capabilities),
			created.createdBy,
			created.createdAt,
			created.status,
		);
	return created;
}

export function retireWorker(id: string) {
	open().prepare("UPDATE workers SET status = 'retired' WHERE id = ?").run(id);
}
