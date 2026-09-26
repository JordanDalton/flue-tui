import { dispatch, init, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { agents } from '../agents/registry.ts';
import { mcpServersFor } from '../mcp.ts';
import {
	createWorker,
	getWorker,
	listWorkers,
	MAX_ACTIVE_WORKERS,
	retireWorker,
	WORKER_CAPABILITIES,
} from '../workers.ts';
import { agentMessage, useIncomingHops } from './agent-messaging.ts';

// The Chief of Staff's team management: see who's available, spawn workers for roles, and
// retire them. Delegating work itself goes through message_agent. Adding or removing
// registered agents is a developer task (/agent, npm run agent), not something agents do.

// Agents that aren't team members the chief delegates to.
const NOT_SPECIALISTS = new Set(['chief', 'worker']);

const slug = (text: string) =>
	text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 24) || 'worker';

/** Mounts list_team, spawn_worker and retire_worker for the chief's conversation. */
export function useTeamTools(chiefThread: string) {
	const hops = useIncomingHops();

	useTool({
		name: 'list_team',
		description:
			'List your team: the specialist agents you can delegate to with message_agent, and the workers you have spawned (active and retired).',
		async run() {
			const specialists = Object.keys(agents)
				.filter((name) => !NOT_SPECIALISTS.has(name))
				.map((name) => {
					const mcp = mcpServersFor(name);
					return `- ${name}${mcp.length ? ` (MCP: ${mcp.join(', ')})` : ''}`;
				});
			const workers = listWorkers();
			const active = workers.filter((w) => w.status === 'active');
			const retired = workers.length - active.length;
			return [
				// Registered agents besides the chief and workers, if a developer has added any.
				...(specialists.length ? ['Specialists (message_agent with `to` set to the name):', ...specialists, ''] : []),
				`Active workers (${active.length}/${MAX_ACTIVE_WORKERS}; message_agent with to: "worker" and thread: <id>):`,
				...(active.length
					? active.map((w) => `- ${w.id}: ${w.role} [${w.capabilities.join(', ') || 'no tools'}]`)
					: ['- none']),
				...(retired ? [`(${retired} retired)`] : []),
			].join('\n');
		},
	});

	useTool({
		name: 'spawn_worker',
		description:
			'Create a new worker agent for a role and hand it its first task. It works in its own conversation and ' +
			'reports back to you as an <agent_message>. Use for dedicated or parallel work that no specialist covers.',
		input: v.object({
			role: v.pipe(v.string(), v.minLength(2), v.maxLength(60)),
			instructions: v.pipe(v.string(), v.minLength(10), v.description('How the worker should approach its role.')),
			capabilities: v.pipe(
				v.array(v.picklist(WORKER_CAPABILITIES)),
				v.description('search: web search. browser: a Tabfleet cloud browser. Empty for thinking/writing only.'),
			),
			task: v.pipe(v.string(), v.minLength(5), v.description('The first assignment, complete and self-contained.')),
		}),
		durable: true,
		async run({ data, step, toolCallId }) {
			const active = listWorkers('active');
			if (active.length >= MAX_ACTIVE_WORKERS) {
				return `Not spawned: ${active.length} workers are already active (limit ${MAX_ACTIVE_WORKERS}). Retire one first.`;
			}
			// Derived from the tool call, so a recovered call can't create a second worker.
			const id = `w-${slug(data.role)}-${toolCallId
				.replace(/[^a-z0-9]/gi, '')
				.slice(-6)
				.toLowerCase()}`;
			if (!getWorker(id)) {
				createWorker({
					id,
					role: data.role,
					instructions: data.instructions,
					capabilities: data.capabilities,
					createdBy: chiefThread,
				});
			}
			await step.do('assign', () =>
				dispatch(agents.worker, { id, message: agentMessage('chief', chiefThread, data.task, hops + 1) }),
			);
			return {
				output: `Spawned worker ${id} (${data.role}) and sent its first task. Its report will arrive as a new message.`,
				terminate: true, // like message_agent: wait for the real report
			};
		},
	});

	useTool({
		name: 'retire_worker',
		description: 'Retire a worker when its role is finished: stops its current work and takes it off the team.',
		input: v.object({ id: v.string() }),
		async run({ data }) {
			const worker = getWorker(data.id);
			if (!worker) return `No worker ${data.id}.`;
			if (worker.status === 'retired') return `${worker.id} (${worker.role}) is already retired.`;
			retireWorker(worker.id);
			await init(agents.worker, { id: worker.id })
				.abort()
				.catch(() => {});
			return `Retired ${worker.id} (${worker.role}).`;
		},
	});
}
