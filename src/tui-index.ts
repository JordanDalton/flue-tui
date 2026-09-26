import { DatabaseSync } from 'node:sqlite';
import { Hono } from 'hono';
import { mcpServersFor } from './mcp.ts';
import { listWorkers } from './workers.ts';

// Index of mounted agents and their recent conversations, for the Flue TUI sidebar.
//
// Flue has no public "list conversations" API, so this reads the runtime's internal
// `flue_agent_submissions` table directly. That table is not a stable contract —
// re-check this query after upgrading @flue/runtime.
//
// Access: open in `vite dev`; elsewhere it requires `authorization: Bearer $FLUE_TUI_TOKEN`
// and is disabled entirely when that variable is unset, since it exposes every
// conversation id (and mounted agents have no auth of their own).

type AgentFn = { name: string; agentName?: string };

export interface TuiThread {
	id: string;
	lastAt: number;
	messages: number;
	busy: boolean;
	preview: string;
	/** Display name instead of the id (a worker's role). */
	label?: string;
	/** A retired worker: shown with archived threads. */
	retired?: boolean;
}

export interface TuiAgent {
	name: string;
	mount: string;
	/** MCP servers from mcp.json that this agent connects to. */
	mcp: string[];
	threads: TuiThread[];
}

export interface TuiActivity {
	at: number;
	/** Sender and recipient are mount names (e.g. 'assistant'). */
	from: string;
	fromThread: string;
	to: string;
	thread: string;
	body: string;
	/** The recipient is still working on this message. */
	busy: boolean;
}

export function tuiIndex(dbPath: string, mounts: Record<string, AgentFn>) {
	const index = new Hono();
	let db: DatabaseSync | undefined;

	index.use('*', async (c, next) => {
		const token = process.env.FLUE_TUI_TOKEN;
		if (token) {
			if (c.req.header('authorization') !== `Bearer ${token}`) return c.json({ error: 'unauthorized' }, 401);
		} else if (!import.meta.env?.DEV) {
			return c.notFound();
		}
		await next();
	});

	index.get('/', (c) => {
		db ??= new DatabaseSync(dbPath, { readOnly: true });
		// SQLite returns the bare `payload` column from the row holding max(accepted_at),
		// so `preview` is the latest message in each conversation.
		const rows = db
			.prepare(
				`SELECT json_extract(payload, '$.agent') AS agent,
				        json_extract(payload, '$.id') AS id,
				        max(accepted_at) AS lastAt,
				        count(*) AS messages,
				        sum(status != 'settled') AS active,
				        json_extract(payload, '$.message.body') AS preview
				   FROM flue_agent_submissions
				  GROUP BY agent, id
				  ORDER BY lastAt DESC
				  LIMIT 500`,
			)
			.all() as {
			agent: string;
			id: string;
			lastAt: number;
			messages: number;
			active: number;
			preview: string | null;
		}[];

		const workers = new Map(listWorkers().map((w) => [w.id, w]));
		const agents: TuiAgent[] = Object.entries(mounts).map(([mount, fn]) => {
			const name = fn.agentName ?? fn.name;
			return {
				name,
				mount: `/agents/${mount}`,
				mcp: mcpServersFor(mount),
				threads: rows
					.filter((r) => r.agent === name)
					.map((r) => ({
						id: r.id,
						lastAt: r.lastAt,
						messages: r.messages,
						busy: r.active > 0,
						preview: (r.preview ?? '').replace(/\s+/g, ' ').slice(0, 80),
						...(workers.has(r.id) && {
							label: workers.get(r.id)!.role,
							retired: workers.get(r.id)!.status === 'retired',
						}),
					})),
			};
		});
		return c.json({ agents });
	});

	// Recent agent-to-agent messages (src/tools/agent-messaging.ts) across all threads.
	index.get('/activity', (c) => {
		db ??= new DatabaseSync(dbPath, { readOnly: true });
		const mountOf = new Map(Object.entries(mounts).map(([mount, fn]) => [fn.agentName ?? fn.name, mount]));
		const rows = db
			.prepare(
				`SELECT accepted_at AS at,
				        status,
				        json_extract(payload, '$.agent') AS agent,
				        json_extract(payload, '$.id') AS thread,
				        json_extract(payload, '$.message.attributes.from') AS "from",
				        json_extract(payload, '$.message.attributes.fromThread') AS fromThread,
				        json_extract(payload, '$.message.body') AS body
				   FROM flue_agent_submissions
				  WHERE json_extract(payload, '$.message.type') = 'agent.message'
				  ORDER BY sequence DESC
				  LIMIT 100`,
			)
			.all() as {
			at: number;
			status: string;
			agent: string;
			thread: string;
			from: string;
			fromThread: string;
			body: string;
		}[];

		const activity: TuiActivity[] = rows.map((r) => ({
			at: r.at,
			from: r.from,
			fromThread: r.fromThread,
			to: mountOf.get(r.agent) ?? r.agent,
			thread: r.thread,
			body: (r.body ?? '').replace(/\s+/g, ' ').slice(0, 200),
			busy: r.status !== 'settled',
		}));
		return c.json({ activity });
	});

	return index;
}
