import { readFileSync, statSync } from 'node:fs';
import { defineMcpConnection, type McpConnectionDefinition, useMcpConnection } from '@flue/runtime';

// MCP servers for the agents, configured in ./mcp.json:
//
//   {
//     "servers": {
//       "linear": {
//         "url": "https://mcp.linear.app/mcp",
//         "auth": "${LINEAR_API_KEY}",          // ${VAR} is read from the environment (.env)
//         "agents": ["assistant"],              // optional; default: every agent
//         "tools": ["search_issues"],           // optional allowlist
//         "transport": "sse",                   // optional; default streamable-http
//         "headers": { "x-team": "core" },      // optional static headers
//         "optional": false                     // optional; default true (see below)
//       }
//     }
//   }
//
// Flue connects to remote (HTTP/SSE) MCP servers only; local stdio servers aren't supported.
// The file is re-read when it changes, and new servers apply from each agent's next message.
// Servers default to `optional: true`, so one being down leaves the agent running without
// its tools rather than failing every message.

const CONFIG_PATH = './mcp.json';

interface ServerConfig {
	url: string;
	auth?: string;
	agents?: string[];
	tools?: string[];
	transport?: 'streamable-http' | 'sse';
	headers?: Record<string, string>;
	optional?: boolean;
	timeoutMs?: number;
}

interface LoadedServer {
	agents?: string[];
	connection: McpConnectionDefinition;
}

let cache: { mtimeMs: number; servers: LoadedServer[] } | undefined;

// Resolved lazily at connect time, so a key added to .env doesn't need a config edit.
function interpolate(value: string, where: string): string {
	return value.replace(/\$\{(\w+)\}/g, (_, name: string) => {
		const v = process.env[name];
		if (v === undefined) throw new Error(`mcp.json: ${where} references $${name}, which is not set`);
		return v;
	});
}

function load(): LoadedServer[] {
	let mtimeMs: number;
	try {
		mtimeMs = statSync(CONFIG_PATH).mtimeMs;
	} catch {
		return []; // no mcp.json: no servers
	}
	if (cache?.mtimeMs === mtimeMs) return cache.servers;

	// A bad file or server entry is logged and skipped rather than failing every agent.
	let raw: { servers?: Record<string, ServerConfig> };
	try {
		raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
	} catch (e) {
		console.error(`[mcp] ${CONFIG_PATH} is not valid JSON: ${(e as Error).message}`);
		return cache?.servers ?? [];
	}
	const servers = Object.entries(raw.servers ?? {}).flatMap(([name, s]): LoadedServer[] => {
		const auth = s.auth;
		try {
			return [
				{
					agents: s.agents,
					connection: defineMcpConnection({
						name,
						url: s.url,
						...(s.transport && { transport: s.transport }),
						...(auth && { auth: () => interpolate(auth, `servers.${name}.auth`) }),
						...(s.headers && {
							headers: Object.fromEntries(
								Object.entries(s.headers).map(([k, v]) => [k, interpolate(v, `servers.${name}.headers.${k}`)]),
							),
						}),
						...(s.tools && { tools: s.tools }),
						...(s.timeoutMs && { timeoutMs: s.timeoutMs }),
						optional: s.optional ?? true,
					}),
				},
			];
		} catch (e) {
			console.error(`[mcp] skipping server "${name}": ${(e as Error).message}`);
			return [];
		}
	});
	cache = { mtimeMs, servers };
	return servers;
}

/** The MCP server names configured for an agent (by registry mount name). */
export function mcpServersFor(agent: string): string[] {
	return load()
		.filter((s) => !s.agents || s.agents.includes(agent))
		.map((s) => s.connection.name);
}

/** One server's connection from mcp.json by name, regardless of its agents list. */
export function mcpConnection(name: string) {
	return load().find((s) => s.connection.name === name)?.connection;
}

/** Mounts every server in mcp.json that applies to this agent (by registry mount name). */
export function useMcpServers(agent: string) {
	for (const server of load()) {
		if (!server.agents || server.agents.includes(agent)) useMcpConnection(server.connection);
	}
}
