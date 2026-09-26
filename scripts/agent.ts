// Create or remove agents: writes src/agents/<name>.ts and updates src/agents/registry.ts
// (and mcp.json on removal). Used by `npm run agent` and the TUI's /agent command.
//
//   npm run agent -- create writer "You write crisp release notes."
//   npm run agent -- create scout researcher
//   npm run agent -- create shopper browser "You compare prices on retail sites."
//   npm run agent -- remove writer                (file moves to .removed-agents/)
//   npm run agent -- restore writer
//   npm run agent -- types
//   npm run agent -- mcp                           (list servers and who has them)
//   npm run agent -- mcp grant tabfleet shopper
//   npm run agent -- mcp add linear https://mcp.linear.app/mcp --auth LINEAR_API_KEY --agents assistant
//   npm run agent -- mcp remove linear
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const REGISTRY = resolve(root, 'src/agents/registry.ts');
const MCP = resolve(root, 'mcp.json');
const agentFile = (name: string) => resolve(root, `src/agents/${name}.ts`);
// Removed agents' files are parked here (outside src/, so Flue no longer loads them).
const REMOVED = resolve(root, '.removed-agents');
const removedFile = (name: string) => resolve(REMOVED, `${name}.ts`);

function archive(name: string) {
	mkdirSync(REMOVED, { recursive: true });
	renameSync(agentFile(name), removedFile(name));
}

/** Names of removed agents that /agent restore can bring back. */
export function listRemoved(): string[] {
	return existsSync(REMOVED)
		? readdirSync(REMOVED)
				.filter((f) => f.endsWith('.ts'))
				.map((f) => f.slice(0, -3))
		: [];
}

// Adds an agent module to the registry: import after the last import, entry at the end of the map.
function register(name: string) {
	const source = readFileSync(REGISTRY, 'utf8');
	const fn = /export function (\w+)/.exec(readFileSync(agentFile(name), 'utf8'))?.[1];
	if (!fn) throw new Error(`src/agents/${name}.ts exports no agent function`);
	const lastImport = [...source.matchAll(/^import .*;$/gm)].at(-1);
	if (!lastImport) throw new Error('registry.ts has no imports to extend');
	const at = lastImport.index! + lastImport[0].length;
	let next = `${source.slice(0, at)}\nimport { ${fn} } from './${name}.ts';${source.slice(at)}`;
	next = next.replace(/(export const agents = \{[\s\S]*?)(\n\};)/, `$1\n\t${registryKey(name)}: ${fn},$2`);
	writeFileSync(REGISTRY, next);
}

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const pascal = (name: string) => name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());
const registryKey = (name: string) => (name.includes('-') ? `'${name}'` : name);

function registryNames(source: string): string[] {
	const body = /export const agents = \{([\s\S]*?)\};/.exec(source)?.[1] ?? '';
	return [...body.matchAll(/^\s*'?([a-z][a-z0-9-]*)'?:/gm)].map((m) => m[1]);
}

/** Registered agent names (registry keys, e.g. 'assistant'). */
export function listAgents(): string[] {
	return registryNames(readFileSync(REGISTRY, 'utf8'));
}

/** Starting points for new agents. Every type gets messaging and its mcp.json servers. */
export const AGENT_TYPES = {
	chat: {
		description: 'general-purpose chat agent',
		instructions: (name: string) => `You are ${name}, a helpful agent. Keep replies short.`,
	},
	researcher: {
		description: 'answers questions with web search and cited sources',
		instructions: (name: string) =>
			`You are ${name}, a researcher. Answer thoroughly but concisely: key facts first, then caveats.
Use \`search_web\` for anything current, specific, or uncertain; to look at a particular site,
put its URL in the query. End every answer with the source URLs it returned, copied exactly.`,
	},
	browser: {
		description: 'operates websites with the Tabfleet cloud browser',
		instructions: (name: string) =>
			`You are ${name}, a browser operator. You complete tasks on websites: navigating, reading,
filling forms and clicking through flows. Report what you did and what you found, step by step,
and stop to ask before submitting anything irreversible (purchases, sign-ups, messages).`,
	},
} as const;

export type AgentType = keyof typeof AGENT_TYPES;
const isType = (t: string | undefined): t is AgentType => !!t && t in AGENT_TYPES;

function template(name: string, type: AgentType, instructions: string) {
	// The instructions land in a template literal; keep backticks and ${ literal.
	const text = instructions.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
	const search = type === 'researcher';
	const runtime = search ? 'type AgentProps, useModel, useTool' : 'type AgentProps, useModel';
	return `'use agent';
import { ${runtime} } from '@flue/runtime';
import { useMcpServers } from '../mcp.ts';
import { AGENT_MESSAGING_INSTRUCTIONS, useAgentMessaging } from '../tools/agent-messaging.ts';
import { browserInstructions } from '../tools/browser.ts';
${search ? "import { webSearch } from '../tools/web-search.ts';\n" : ''}
// Created with \`npm run agent -- create ${name} ${type}\`.
export function ${pascal(name)}({ id }: AgentProps) {
	useModel('anthropic/claude-haiku-4-5');
${search ? '\tuseTool(webSearch);\n' : ''}	useMcpServers('${name}');
	useAgentMessaging('${name}', id);
	return [
		\`${text}\`,
		browserInstructions('${name}'),
		AGENT_MESSAGING_INSTRUCTIONS,
	]
		.filter(Boolean)
		.join('\\n\\n');
}
`;
}

/**
 * Creates an agent from `[type] [instructions]` (type defaults to chat). Returns a
 * one-line summary; throws on invalid input.
 */
export function createAgent(name: string, spec = ''): string {
	if (!NAME.test(name)) throw new Error('agent names are lowercase letters, digits and dashes, starting with a letter');
	const source = readFileSync(REGISTRY, 'utf8');
	if (registryNames(source).includes(name)) throw new Error(`agent "${name}" already exists`);

	// An unregistered file left in src/agents (older removals kept it there): with nothing
	// specified, register it as it is; otherwise set it aside and start fresh.
	const notes: string[] = [];
	if (existsSync(agentFile(name))) {
		if (!spec.trim()) {
			register(name);
			return `re-registered existing src/agents/${name}.ts at /agents/${name}`;
		}
		archive(name);
		notes.push(`previous file moved to .removed-agents/${name}.ts`);
	}

	const [first, ...rest] = spec.trim().split(/\s+/);
	const type: AgentType = isType(first) ? first : 'chat';
	const instructions = (isType(first) ? rest.join(' ') : spec).trim() || AGENT_TYPES[type].instructions(name);

	if (type === 'browser') {
		notes.push(
			readMcp().servers?.tabfleet ? 'granted tabfleet' : 'no tabfleet server in mcp.json, so it has no browser yet',
		);
	}

	writeFileSync(agentFile(name), template(name, type, instructions));
	register(name);
	if (type === 'browser' && readMcp().servers?.tabfleet) grantMcp('tabfleet', name);
	return [`created ${type} agent ${name} at /agents/${name}`, ...notes].join('; ');
}

type McpConfig = {
	servers?: Record<string, { url?: string; auth?: string; transport?: string; agents?: string[] }>;
};
const readMcp = (): McpConfig => (existsSync(MCP) ? JSON.parse(readFileSync(MCP, 'utf8')) : {});
const writeMcp = (mcp: McpConfig) => writeFileSync(MCP, `${JSON.stringify(mcp, null, '\t')}\n`);

const SERVER_NAME = /^[a-z][a-z0-9_-]{0,39}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export interface McpAddOptions {
	/** Environment variable holding the bearer token; stored as "${VAR}", never the value. */
	auth?: string;
	/** Agents that get it; omitted means every agent. */
	agents?: string[];
	transport?: 'streamable-http' | 'sse';
}

/** Parses `<name> <url> [--auth VAR] [--agents a,b] [--sse]`. */
export function parseMcpAdd(args: string[]): { name: string; url: string } & McpAddOptions {
	const [name, url, ...flags] = args;
	if (!name || !url) throw new Error('usage: mcp add <name> <url> [--auth ENV_VAR] [--agents a,b] [--sse]');
	const options: McpAddOptions = {};
	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		if (flag === '--auth') options.auth = flags[++i];
		else if (flag === '--agents') options.agents = (flags[++i] ?? '').split(',').filter(Boolean);
		else if (flag === '--sse') options.transport = 'sse';
		else throw new Error(`unknown option ${flag}`);
	}
	return { name, url, ...options };
}

/** Adds a remote MCP server to mcp.json. Agents pick it up from their next message. */
export function addMcp(name: string, url: string, options: McpAddOptions = {}): string {
	if (!SERVER_NAME.test(name)) throw new Error('server names are lowercase letters, digits, - and _');
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`not a URL: ${url}`);
	}
	if (!/^https?:$/.test(parsed.protocol))
		throw new Error('MCP servers must be http(s) URLs (local stdio servers are not supported)');
	if (options.auth && !ENV_NAME.test(options.auth)) {
		throw new Error('--auth takes an environment variable name (e.g. LINEAR_API_KEY), not the key itself');
	}
	const agents = listAgents();
	const unknown = options.agents?.filter((a) => !agents.includes(a)) ?? [];
	if (unknown.length) throw new Error(`no agent ${unknown.join(', ')} — agents: ${agents.join(', ')}`);

	const mcp = readMcp();
	mcp.servers ??= {};
	if (mcp.servers[name]) throw new Error(`server "${name}" already exists — /mcp remove ${name} first`);
	mcp.servers[name] = {
		url,
		...(options.auth && { auth: `\${${options.auth}}` }),
		...(options.transport && { transport: options.transport }),
		...(options.agents && { agents: options.agents }),
	};
	writeMcp(mcp);

	const who = options.agents ? options.agents.join(', ') || 'no agents' : 'every agent';
	const missing = options.auth && !process.env[options.auth] ? `; set ${options.auth} in .env` : '';
	return `added ${name} for ${who}; applies from each agent's next message${missing}`;
}

export function removeMcp(name: string): string {
	const mcp = readMcp();
	if (!mcp.servers?.[name]) throw new Error(`no server "${name}" in mcp.json`);
	delete mcp.servers[name];
	writeMcp(mcp);
	return `removed ${name}; agents drop its tools from their next message`;
}

/** Connects once and lists the server's tools, to confirm the URL and credentials work. */
export async function probeMcp(name: string): Promise<string> {
	const entry = readMcp().servers?.[name];
	if (!entry?.url) throw new Error(`no server "${name}" in mcp.json`);
	const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
	const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
	const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
	const token = entry.auth?.replace(/\$\{(\w+)\}/g, (_, v: string) => process.env[v] ?? '');
	const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
	const url = new URL(entry.url);
	const client = new Client({ name: 'flue-mcp-probe', version: '1.0.0' });
	try {
		await client.connect(
			entry.transport === 'sse'
				? new SSEClientTransport(url, { requestInit: { headers } })
				: new StreamableHTTPClientTransport(url, { requestInit: { headers } }),
		);
		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		return `${name}: connected, ${names.length} tools (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''})`;
	} finally {
		await client.close().catch(() => {});
	}
}

/** MCP servers in mcp.json and the agents each is granted to ('all' without an allowlist). */
export function listMcp(): { server: string; agents: string[] | 'all' }[] {
	return Object.entries(readMcp().servers ?? {}).map(([server, s]) => ({ server, agents: s.agents ?? 'all' }));
}

/** Gives an agent an MCP server from mcp.json. */
export function grantMcp(server: string, agent: string): string {
	const mcp = readMcp();
	const entry = mcp.servers?.[server];
	if (!entry)
		throw new Error(
			`no server "${server}" in mcp.json — servers: ${
				listMcp()
					.map((s) => s.server)
					.join(', ') || 'none'
			}`,
		);
	if (!listAgents().includes(agent)) throw new Error(`no agent "${agent}"`);
	if (!entry.agents) return `${agent} already has ${server} (it applies to every agent)`;
	if (entry.agents.includes(agent)) return `${agent} already has ${server}`;
	entry.agents.push(agent);
	writeMcp(mcp);
	return `granted ${server} to ${agent}; applies from its next message`;
}

/** Takes an MCP server away from an agent. */
export function revokeMcp(server: string, agent: string): string {
	const mcp = readMcp();
	const entry = mcp.servers?.[server];
	if (!entry) throw new Error(`no server "${server}" in mcp.json`);
	// No allowlist means every agent; spell that out so one can be removed.
	const current = entry.agents ?? listAgents();
	if (!current.includes(agent)) return `${agent} doesn't have ${server}`;
	entry.agents = current.filter((a) => a !== agent);
	writeMcp(mcp);
	return `revoked ${server} from ${agent}`;
}

/** Unregisters an agent. Its source file and conversation history are kept. */
export function removeAgent(name: string): string {
	const source = readFileSync(REGISTRY, 'utf8');
	const names = registryNames(source);
	if (!names.includes(name)) throw new Error(`no agent "${name}" — agents: ${names.join(', ')}`);
	if (names.length === 1) throw new Error('cannot remove the last agent');
	if (name === 'chief' || name === 'worker')
		throw new Error(`"${name}" is a core agent (the Chief of Staff's team depends on it)`);

	const entry = new RegExp(`^\\s*'?${name}'?:\\s*(\\w+),?\\s*\\n`, 'm').exec(source);
	if (!entry) throw new Error(`could not find ${name} in registry.ts`);
	const fn = entry[1];
	const next = source.replace(entry[0], '').replace(new RegExp(`^import \\{ ${fn} \\} from '[^']+';\\n`, 'm'), '');
	writeFileSync(REGISTRY, next);

	// Drop it from mcp.json allowlists. An emptied list stays [] (no agents), not
	// removed, which would mean "every agent".
	if (existsSync(MCP)) {
		const mcp = JSON.parse(readFileSync(MCP, 'utf8')) as { servers?: Record<string, { agents?: string[] }> };
		let changed = false;
		for (const server of Object.values(mcp.servers ?? {})) {
			if (server.agents?.includes(name)) {
				server.agents = server.agents.filter((a) => a !== name);
				changed = true;
			}
		}
		if (changed) writeFileSync(MCP, `${JSON.stringify(mcp, null, '\t')}\n`);
	}
	if (existsSync(agentFile(name))) archive(name);
	return `removed ${name} (file moved to .removed-agents/${name}.ts; /agent restore ${name} brings it back; its threads are kept)`;
}

/** Brings back an agent removed with removeAgent, with its code as it was. */
export function restoreAgent(name: string): string {
	if (listAgents().includes(name)) throw new Error(`agent "${name}" already exists`);
	if (!existsSync(removedFile(name))) {
		throw new Error(`no removed agent "${name}" — removed: ${listRemoved().join(', ') || 'none'}`);
	}
	if (existsSync(agentFile(name))) throw new Error(`src/agents/${name}.ts already exists`);
	renameSync(removedFile(name), agentFile(name));
	register(name);
	return `restored ${name} at /agents/${name} (re-grant MCP servers with /mcp grant if needed)`;
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
	try {
		process.loadEnvFile('.env');
	} catch {
		// no .env
	}
	const [command, name, ...rest] = process.argv.slice(2);
	try {
		if (command === 'create' && name) console.log(createAgent(name, rest.join(' ')));
		else if (command === 'remove' && name) console.log(removeAgent(name));
		else if (command === 'restore' && name) console.log(restoreAgent(name));
		else if (command === 'list') console.log(listAgents().join('\n'));
		else if (command === 'mcp') {
			const [sub, server, agent] = [name, ...rest];
			if (sub === 'add') {
				const { name: server, url, ...options } = parseMcpAdd(rest);
				console.log(addMcp(server, url, options));
				console.log(await probeMcp(server).catch((e) => `${server}: could not connect yet: ${e.message}`));
			} else if (sub === 'remove' && server) console.log(removeMcp(server));
			else if (sub === 'grant' && server && agent) console.log(grantMcp(server, agent));
			else if (sub === 'revoke' && server && agent) console.log(revokeMcp(server, agent));
			else
				console.log(
					listMcp()
						.map((m) => `${m.server.padEnd(14)}${m.agents === 'all' ? 'all agents' : m.agents.join(', ') || '(none)'}`)
						.join('\n'),
				);
		} else if (command === 'types')
			console.log(
				Object.entries(AGENT_TYPES)
					.map(([t, d]) => `${t.padEnd(12)}${d.description}`)
					.join('\n'),
			);
		else {
			console.error(
				'usage: npm run agent -- create <name> [type] ["instructions"] | remove <name> | restore <name> | list | types | mcp [add <name> <url> [--auth VAR] [--agents a,b] [--sse] | remove <name> | grant|revoke <server> <agent>]',
			);
			process.exit(1);
		}
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}
