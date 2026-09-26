import type { TuiAgent } from './api.ts';

// Slash commands typed into the chat input. The chat pane runs the ones about the open
// thread (`scope: 'chat'`); the rest are handed to the app (`scope: 'app'`).

export interface CommandContext {
	agents: TuiAgent[];
	/** Section names, in sidebar order. */
	sections: string[];
	/** Agent keys hidden from the sidebar. */
	hidden: string[];
	/** MCP server names in mcp.json. */
	servers: string[];
	/** Removed agents that /agent restore can bring back. */
	removed: string[];
	/** Archived thread ids. */
	archived: string[];
}

export interface Command {
	name: string;
	/** Argument hint shown in suggestions, e.g. '<agent>'. */
	args?: string;
	/** Whether the argument can be left out. */
	optionalArgs?: boolean;
	description: string;
	scope: 'chat' | 'app';
	/** Completions for the argument typed so far. */
	complete?: (arg: string, ctx: CommandContext) => string[];
}

/** 'assistant' from '/agents/assistant' — the name commands use for an agent. */
export const agentKey = (agent: TuiAgent) => agent.mount.split('/').pop()!;

const completeAgent = (arg: string, ctx: CommandContext) =>
	ctx.agents.map(agentKey).filter((a) => a.startsWith(arg.toLowerCase()));

const completeThread = (arg: string, ctx: CommandContext) =>
	ctx.agents.flatMap((a) => a.threads.map((t) => `${agentKey(a)} ${t.id}`)).filter((t) => t.includes(arg));

const matching = (options: string[], arg: string) =>
	options.filter((o) => o.toLowerCase().startsWith(arg.toLowerCase()));

/** Completes '<subcommand> <name>': subcommands first, then names for the ones that take one. */
const subcommands =
	(subs: string[], names: (sub: string, ctx: CommandContext) => string[]) => (arg: string, ctx: CommandContext) => {
		const space = arg.indexOf(' ');
		if (space < 0) return matching(subs, arg);
		const sub = arg.slice(0, space);
		return matching(names(sub, ctx), arg.slice(space + 1)).map((n) => `${sub} ${n}`);
	};

export const COMMANDS: Command[] = [
	{
		name: 'new',
		args: '[agent]',
		optionalArgs: true,
		description: 'start a new thread',
		scope: 'app',
		complete: completeAgent,
	},
	{ name: 'open', args: '[agent] <thread>', description: 'open a thread', scope: 'app', complete: completeThread },
	{ name: 'activity', description: 'show agent-to-agent activity', scope: 'app' },
	{
		name: 'section',
		args: 'add|remove|rename <name>',
		description: 'manage sidebar sections',
		scope: 'app',
		complete: subcommands(['add', 'remove', 'rename'], (sub, ctx) => (sub === 'add' ? [] : ctx.sections)),
	},
	{
		name: 'move',
		args: '<section|none>',
		description: 'move this thread into a section',
		scope: 'app',
		complete: (arg, ctx) => matching([...ctx.sections, 'none'], arg),
	},
	{ name: 'pin', description: 'pin or unpin this thread', scope: 'app' },
	{ name: 'archive', description: 'hide this thread from the sidebar (history is kept)', scope: 'app' },
	{
		name: 'unarchive',
		args: '[thread]',
		optionalArgs: true,
		description: 'bring an archived thread back',
		scope: 'app',
		complete: (arg, ctx) => matching(ctx.archived, arg),
	},
	{
		name: 'hide',
		args: '<agent>',
		description: 'hide an agent from the sidebar',
		scope: 'app',
		complete: (arg, ctx) =>
			matching(
				ctx.agents.map(agentKey).filter((a) => !ctx.hidden.includes(a)),
				arg,
			),
	},
	{
		name: 'show',
		args: '<agent>',
		description: 'show a hidden agent',
		scope: 'app',
		complete: (arg, ctx) => matching(ctx.hidden, arg),
	},
	{
		name: 'agent',
		args: 'create <name> [chat|researcher|browser] [instructions] | remove|restore <name>',
		description: 'create, remove or restore an agent',
		scope: 'app',
		complete: (arg, ctx) => {
			const create = /^create (\S+) (\S*)$/.exec(arg);
			if (create) return matching(['chat', 'researcher', 'browser'], create[2]).map((t) => `create ${create[1]} ${t}`);
			return subcommands(['create', 'remove', 'restore'], (sub, c) =>
				sub === 'remove' ? c.agents.map(agentKey) : sub === 'restore' ? c.removed : [],
			)(arg, ctx);
		},
	},
	{
		name: 'mcp',
		args: 'list | add <name> <url> [--auth VAR] [--agents a,b] | remove <name> | grant|revoke <server> <agent>',
		optionalArgs: true,
		description: 'add, remove, or grant MCP servers',
		scope: 'app',
		complete: (arg, ctx) => {
			const parts = arg.split(' ');
			if (parts.length === 1) return matching(['list', 'add', 'remove', 'grant', 'revoke'], arg);
			if (parts[0] === 'list' || parts[0] === 'add') return [];
			if (parts[0] === 'remove') {
				return parts.length === 2 ? matching(ctx.servers, parts[1]).map((s) => `remove ${s}`) : [];
			}
			if (parts.length === 2) return matching(ctx.servers, parts[1]).map((s) => `${parts[0]} ${s}`);
			return matching(ctx.agents.map(agentKey), parts[2]).map((a) => `${parts[0]} ${parts[1]} ${a}`);
		},
	},
	{ name: 'threads', description: 'focus the thread list', scope: 'app' },
	{ name: 'abort', description: 'stop the agent’s current work', scope: 'chat' },
	{ name: 'thinking', description: 'show or hide reasoning and runtime details (ctrl+o)', scope: 'chat' },
	{
		name: 'view',
		args: '[blocks]',
		optionalArgs: true,
		description: 'show or hide this thread’s browser',
		scope: 'chat',
		complete: (arg) => matching(['blocks'], arg),
	},
	{ name: 'info', description: 'show this thread’s details', scope: 'chat' },
	{ name: 'help', description: 'list commands', scope: 'chat' },
	{ name: 'logs', description: 'show the dev server’s recent output', scope: 'app' },
	{ name: 'quit', description: 'exit the TUI', scope: 'app' },
];

export interface Suggestion {
	/** The full input this suggestion completes to. */
	value: string;
	label: string;
	description: string;
}

/** Suggestions for the current input, or [] when it isn't a command. */
export function suggest(input: string, ctx: CommandContext): Suggestion[] {
	if (!input.startsWith('/') || input.startsWith('//')) return [];
	const space = input.indexOf(' ');
	if (space < 0) {
		const typed = input.slice(1).toLowerCase();
		return COMMANDS.filter((c) => c.name.startsWith(typed)).map((c) => ({
			// Commands that take an argument complete with a trailing space, ready for it.
			value: `/${c.name}${c.args ? ' ' : ''}`,
			label: `/${c.name}${c.args ? ` ${c.args}` : ''}`,
			description: c.description,
		}));
	}
	const command = COMMANDS.find((c) => c.name === input.slice(1, space));
	const arg = input.slice(space + 1);
	return (command?.complete?.(arg, ctx) ?? []).slice(0, 8).map((v) => ({
		value: `/${command!.name} ${v}`,
		label: v,
		description: '',
	}));
}

export type Parsed = { command: Command; arg: string } | { error: string };

/** Parses a submitted command line ('/open researcher tui-abc'). */
export function parse(line: string): Parsed {
	const [head, ...rest] = line.slice(1).trim().split(/\s+/);
	const command = COMMANDS.find((c) => c.name === head?.toLowerCase());
	if (!command) return { error: `unknown command /${head} — try /help` };
	const arg = rest.join(' ');
	if (command.args && !command.optionalArgs && !arg) return { error: `usage: /${command.name} ${command.args}` };
	return { command, arg };
}
