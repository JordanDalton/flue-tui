import type { TuiActivity, TuiAgent } from '../src/tui-index.ts';

export type { TuiActivity, TuiAgent, TuiThread } from '../src/tui-index.ts';

export interface Connection {
	baseUrl: string;
	token?: string;
}

// Fetches the sidebar index served by src/tui-index.ts. Returns undefined when the
// app doesn't expose it (older app, production without FLUE_TUI_TOKEN), so the
// TUI can fall back to single-agent mode.
export async function fetchIndex(conn: Connection): Promise<TuiAgent[] | undefined> {
	const res = await fetch(`${conn.baseUrl}/_tui/agents`, {
		headers: conn.token ? { authorization: `Bearer ${conn.token}` } : {},
		signal: AbortSignal.timeout(5000),
	});
	if (res.status === 404 || res.status === 401) return undefined;
	if (!res.ok) throw new Error(`index request failed: ${res.status}`);
	const body = (await res.json()) as { agents: TuiAgent[] };
	return body.agents;
}

export async function fetchActivity(conn: Connection): Promise<TuiActivity[]> {
	const res = await fetch(`${conn.baseUrl}/_tui/agents/activity`, {
		headers: conn.token ? { authorization: `Bearer ${conn.token}` } : {},
		signal: AbortSignal.timeout(5000),
	});
	if (!res.ok) throw new Error(`activity request failed: ${res.status}`);
	return ((await res.json()) as { activity: TuiActivity[] }).activity;
}

export function newThreadId() {
	return `tui-${Date.now().toString(36)}`;
}

export function ago(ms: number) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

/** 'ChiefOfStaff' → 'Chief of Staff'. */
export function displayName(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/ (Of|And|The|For|To|A) /g, (m) => m.toLowerCase());
}
