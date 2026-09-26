#!/usr/bin/env node
// Flue TUI — sidebar of agents and threads, live chat pane.
// Usage: npm run tui -- [--url http://localhost:5173] [--agent <name>] [--id <thread>] [--no-server]
// Starts the dev server itself when nothing is running at a local --url.
import { Box, render, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseArgs } from 'node:util';
import { type Connection, displayName, fetchIndex, newThreadId, type TuiAgent } from './api.ts';
import { Activity } from './activity.tsx';
import { supportsKitty } from './browser.ts';
import { devLogTail, ensureDevServer } from './dev-server.ts';
import { Chat } from './chat.tsx';
import {
	addMcp,
	createAgent,
	grantMcp,
	listMcp,
	listRemoved,
	parseMcpAdd,
	probeMcp,
	removeAgent,
	removeMcp,
	restoreAgent,
	revokeMcp,
} from '../scripts/agent.ts';
import { agentKey } from './commands.ts';
import {
	addSection,
	type Layout,
	loadLayout,
	moveThread,
	orderedSections,
	removeSection,
	renameSection,
	saveLayout,
	setHidden,
	threadKey,
	toggleCollapsed,
	toggleArchived,
	togglePin,
} from './layout.ts';
import { Sidebar, toRows } from './sidebar.tsx';

// Project .env (e.g. TABFLEET_API_KEY for /view); variables already set in the shell win.
try {
	process.loadEnvFile(new URL('../.env', import.meta.url));
} catch {
	// no .env
}

const { values: args } = parseArgs({
	options: {
		url: { type: 'string', default: process.env.FLUE_URL ?? 'http://localhost:5173' },
		agent: { type: 'string' },
		id: { type: 'string' },
		token: { type: 'string', default: process.env.FLUE_TOKEN },
		// Don't start a dev server when none is running (e.g. you run `npm run dev` yourself).
		'no-server': { type: 'boolean', default: false },
	},
});

const conn: Connection = { baseUrl: args.url.replace(/\/$/, ''), token: args.token };
// /agent and /mcp edit this project's files, so they only make sense against a local server.
const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(conn.baseUrl);
// Where to start: --agent/--id, else the thread open last time, else a new thread with the
// first agent the server lists (resolved once the index loads).
const startLayout = loadLayout();
const [lastAgent, lastId] = startLayout.lastOpen?.split('/') ?? [];
const startAgent = args.agent ?? (args.id ? 'chief' : lastAgent) ?? 'chief';
const startId = args.id ?? (args.agent ? undefined : lastId);
// Used until (or instead of, when the app has no index route) the index loads.
const fallbackAgent: TuiAgent = { name: startAgent, mount: `/agents/${startAgent}`, mcp: [], threads: [] };

type Open = { mount: string; id: string };

const safe = <T,>(fn: () => T, fallback: T): T => {
	try {
		return fn();
	} catch {
		return fallback;
	}
};

function useTerminalRows() {
	const { stdout } = useStdout();
	const [rows, setRows] = useState(stdout.rows || 24);
	useEffect(() => {
		const onResize = () => setRows(stdout.rows);
		stdout.on('resize', onResize);
		return () => void stdout.off('resize', onResize);
	}, [stdout]);
	return rows;
}

function App() {
	const { exit } = useApp();
	const height = useTerminalRows();
	const [indexed, setIndexed] = useState<TuiAgent[]>();
	const [indexNotice, setIndexNotice] = useState<string>();
	// The agent a first `x` in the sidebar asked to remove; a second `x` on it confirms.
	const [armedRemoval, setArmedRemoval] = useState<string>();
	// Threads created here that the index hasn't reported yet (they appear on first send).
	const [drafts, setDrafts] = useState<Open[]>([]);
	const [open, setOpen] = useState<Open | 'activity'>({ mount: fallbackAgent.mount, id: startId ?? newThreadId() });
	const [focus, setFocus] = useState<'input' | 'sidebar'>('input');
	const [selected, setSelected] = useState(0);
	const [layout, setLayoutState] = useState<Layout>(startLayout);
	// Threads the open conversation delegated to. A hidden agent still lists these.
	const [delegated, setDelegated] = useState<{ agent: string; thread: string }[]>([]);
	// Delegations the user dismissed with x, so hiding an agent stays hidden.
	const [dismissedDelegations, setDismissedDelegations] = useState<ReadonlySet<string>>(new Set());
	const setLayout = (next: Layout) => {
		setLayoutState(next);
		saveLayout(next);
	};
	// Applies a layout update that may fail with a message.
	const update = (result: Layout | string): string | void => {
		if (typeof result === 'string') return result;
		setLayout(result);
	};

	const refresh = useCallback(() => {
		fetchIndex(conn).then(
			(agents) => {
				setIndexed(agents);
				setIndexNotice(agents ? undefined : 'no /_tui/agents index — single agent mode');
				// The starting agent may not exist (removed, or a default that was never
				// registered): move to a new thread with the first agent that does.
				if (agents?.length) {
					setOpen((o) => {
						if (o === 'activity' || agents.some((a) => a.mount === o.mount)) return o;
						const missing = o.mount.split('/').pop();
						setIndexNotice(`no agent "${missing}" on the server — opened ${agents[0]!.name}`);
						return { mount: agents[0]!.mount, id: newThreadId() };
					});
				}
			},
			(e) => setIndexNotice(`index: ${e.message}`),
		);
	}, []);

	useEffect(() => {
		refresh();
		const timer = setInterval(refresh, 3000);
		return () => clearInterval(timer);
	}, [refresh]);

	// Merge the server index with local drafts and the open thread, so the open
	// thread always has a row even before its first message.
	const agents = useMemo(() => {
		const base = indexed?.length ? indexed : [fallbackAgent];
		const pending = open === 'activity' ? drafts : [...drafts, open];
		return base.map((agent) => {
			const known = new Set(agent.threads.map((t) => t.id));
			const extra = pending
				.filter((d) => d.mount === agent.mount && !known.has(d.id))
				.filter((d, i, all) => all.findIndex((o) => o.id === d.id) === i)
				.map((d) => ({ id: d.id, lastAt: 0, messages: 0, busy: false, preview: '' }));
			return { ...agent, threads: [...extra, ...agent.threads] };
		});
	}, [indexed, drafts, open]);

	const revealed = useMemo(
		() => delegated.filter((d) => !dismissedDelegations.has(`${d.agent}/${d.thread}`)),
		[delegated, dismissedDelegations],
	);
	const rows = useMemo(() => toRows(agents, layout, revealed), [agents, layout, revealed]);
	const onDelegates = useCallback((targets: { agent: string; thread: string }[]) => {
		setDelegated((prev) => {
			const same =
				prev.length === targets.length &&
				prev.every((p, i) => p.agent === targets[i]!.agent && p.thread === targets[i]!.thread);
			return same ? prev : targets;
		});
	}, []);

	// Remember the open thread for next time (only once it exists on the server).
	useEffect(() => {
		if (open === 'activity') return;
		const agent = agents.find((a) => a.mount === open.mount);
		if (!agent?.threads.some((t) => t.id === open.id && t.lastAt > 0)) return;
		const key = threadKey(agentKey(agent), open.id);
		setLayoutState((l) => {
			if (l.lastOpen === key) return l;
			const next = { ...l, lastOpen: key };
			saveLayout(next);
			return next;
		});
	}, [open, agents]);
	const openAgent = open === 'activity' ? undefined : (agents.find((a) => a.mount === open.mount) ?? fallbackAgent);

	// Activity items name agents by mount segment; threads are keyed by full mount path.
	const openThread = (mount: string, id: string) => {
		setOpen({ mount: `/agents/${mount}`, id });
		setFocus('input');
	};

	const startThread = (agent: TuiAgent) => {
		const draft = { mount: agent.mount, id: newThreadId() };
		setDrafts((d) => [...d, draft]);
		setOpen(draft);
		setFocus('input');
	};

	const focusSidebar = () => {
		// Put the cursor on the open thread when entering the sidebar.
		const i = rows.findIndex((r) =>
			open === 'activity'
				? r.kind === 'activity'
				: r.kind === 'thread' && r.agent.mount === open.mount && r.id === open.id,
		);
		if (i >= 0) setSelected(i);
		setFocus('sidebar');
	};

	// App-scoped slash commands (tui/commands.ts); returns an error message on failure.
	const commandContext = useMemo(
		() => ({
			agents,
			sections: orderedSections(layout).map((s) => s.name),
			hidden: layout.hidden,
			// Read from this project's mcp.json, so only meaningful against a local server.
			servers: local ? safe(() => listMcp().map((m) => m.server), []) : [],
			removed: local ? safe(listRemoved, []) : [],
			archived: (layout.archived ?? []).map((k) => k.split('/').pop()!),
		}),
		[agents, layout],
	);
	const openKey = open === 'activity' ? undefined : threadKey(open.mount.split('/').pop()!, open.id);
	const findAgent = (key: string) => agents.find((a) => agentKey(a) === key.toLowerCase());
	// A thread by id across all agents; a string when the id is ambiguous.
	const findThread = (id: string): { agent: TuiAgent; id: string } | string | undefined => {
		const matches = agents.filter((a) => a.threads.some((t) => t.id === id));
		if (matches.length > 1) return `"${id}" exists for ${matches.map(agentKey).join(' and ')} — /open <agent> ${id}`;
		return matches[0] && { agent: matches[0], id };
	};
	const runCommand = (name: string, arg: string): string | void => {
		switch (name) {
			case 'new': {
				const agent = arg ? findAgent(arg) : (openAgent ?? agents[0]);
				if (!agent) {
					// A thread name given where an agent was expected: open that thread instead.
					const found = findThread(arg);
					if (typeof found === 'string') return found;
					if (found) return openThread(agentKey(found.agent), found.id);
					return `no agent "${arg}" — agents: ${agents.map(agentKey).join(', ')}`;
				}
				startThread(agent);
				return;
			}
			case 'open': {
				// '<agent> <thread>', '<agent>/<thread>', or just '<thread>' when only one agent has it.
				const parts = arg.includes('/') && !arg.includes(' ') ? arg.split('/') : arg.split(/\s+/);
				if (parts.length === 1) {
					const found = findThread(parts[0]!);
					if (typeof found === 'string') return found;
					if (!found) return `no thread "${parts[0]}" — /open <agent> <thread>`;
					openThread(agentKey(found.agent), found.id);
					return;
				}
				const agent = findAgent(parts[0] ?? '');
				if (!agent || !parts[1]) return 'usage: /open <agent> <thread>';
				openThread(agentKey(agent), parts[1]);
				return;
			}
			case 'activity':
				setOpen('activity');
				return;
			case 'threads':
				focusSidebar();
				return;
			case 'section': {
				const [sub, ...rest] = arg.split(/\s+/);
				const name = rest.join(' ');
				if (sub === 'add') return update(addSection(layout, name));
				if (sub === 'remove') return update(removeSection(layout, name));
				if (sub === 'rename') {
					const [from, ...to] = rest;
					return update(renameSection(layout, from ?? '', to.join(' ')));
				}
				return 'usage: /section add|remove|rename <name>';
			}
			case 'move':
				if (!openKey) return 'open a thread first';
				setLayout(moveThread(layout, openKey, arg.toLowerCase() === 'none' ? null : arg));
				return;
			case 'archive':
				if (!openKey) return 'open a thread first';
				setLayout(toggleArchived(layout, openKey));
				return (layout.archived ?? []).includes(openKey)
					? 'unarchived'
					: 'archived — it stays open until you switch away; /unarchive to undo';
			case 'unarchive': {
				const key =
					(layout.archived ?? []).find((k) => k === arg || k.endsWith(`/${arg}`)) ?? (!arg ? openKey : undefined);
				if (!key || !(layout.archived ?? []).includes(key)) return `no archived thread "${arg}"`;
				setLayout(toggleArchived(layout, key));
				return;
			}
			case 'pin':
				if (!openKey) return 'open a thread first';
				setLayout(togglePin(layout, openKey));
				return;
			case 'hide':
			case 'show': {
				if (!findAgent(arg)) return `no agent "${arg}"`;
				const key = arg.toLowerCase();
				if (name === 'hide') {
					setDismissedDelegations((prev) => {
						const next = new Set(prev);
						for (const d of delegated) if (d.agent === key) next.add(`${d.agent}/${d.thread}`);
						return next;
					});
				}
				setLayout(setHidden(layout, key, name === 'hide'));
				return;
			}
			case 'agent': {
				if (!local) return '/agent only works against a local dev server';
				const [sub, agentName, ...rest] = arg.split(/\s+/);
				try {
					if (sub === 'create' && agentName) {
						const result = createAgent(agentName, rest.join(' '));
						setIndexNotice(result);
						// The dev server reloads the registry; pick the new agent up once it has.
						setTimeout(refresh, 1500);
						return;
					}
					if (sub === 'restore' && agentName) {
						setIndexNotice(restoreAgent(agentName));
						setTimeout(refresh, 1500);
						return;
					}
					if (sub === 'remove' && agentName) {
						setIndexNotice(removeAgent(agentName));
						if (openAgent && agentKey(openAgent) === agentName) setOpen('activity');
						setTimeout(refresh, 1500);
						return;
					}
				} catch (e) {
					return (e as Error).message;
				}
				return 'usage: /agent create <name> [type] [instructions] | /agent remove|restore <name>';
			}
			case 'mcp': {
				if (!local) return '/mcp only works against a local dev server';
				const [sub, server, agentName] = arg.split(/\s+/);
				try {
					if (sub === 'add') {
						const { name: added, url, ...options } = parseMcpAdd(arg.split(/\s+/).slice(1));
						setIndexNotice(addMcp(added, url, options));
						// Report whether it actually connects, without holding up the command.
						probeMcp(added).then(setIndexNotice, (e: Error) =>
							setIndexNotice(`${added}: could not connect yet: ${e.message}`),
						);
					} else if (sub === 'remove' && server) setIndexNotice(removeMcp(server));
					else if (sub === 'grant' && server && agentName) setIndexNotice(grantMcp(server, agentName));
					else if (sub === 'revoke' && server && agentName) setIndexNotice(revokeMcp(server, agentName));
					else if (!sub || sub === 'list')
						return (
							listMcp()
								.map((m) => `${m.server}: ${m.agents === 'all' ? 'all agents' : m.agents.join(', ') || '(none)'}`)
								.join('\n') || 'no servers in mcp.json'
						);
					else
						return 'usage: /mcp list | add <name> <url> [--auth VAR] [--agents a,b] | remove <name> | grant|revoke <server> <agent>';
				} catch (e) {
					return (e as Error).message;
				}
				setTimeout(refresh, 500);
				return;
			}
			case 'logs':
				if (!managedServer)
					return 'the dev server was already running when the TUI started — its output is in that terminal';
				return devLogTail() ?? 'no dev server output yet';
			case 'quit':
				exit();
				return;
		}
	};

	// While the chat pane shows command suggestions, Tab completes instead of switching focus.
	const tabCaptured = useRef(false);
	const onCapturingTab = useCallback((capturing: boolean) => {
		tabCaptured.current = capturing;
	}, []);

	useInput((ch, key) => {
		if (key.ctrl && ch === 'c') {
			exit();
			return;
		}
		if (key.tab && focus === 'input' && tabCaptured.current) return;
		if (key.tab) {
			setFocus((f) => {
				if (f === 'input') {
					// Put the cursor on the open thread when entering the sidebar.
					const i = rows.findIndex((r) =>
						open === 'activity'
							? r.kind === 'activity'
							: r.kind === 'thread' && r.agent.mount === open.mount && r.id === open.id,
					);
					if (i >= 0) setSelected(i);
					return 'sidebar';
				}
				return 'input';
			});
			return;
		}
		if (focus !== 'sidebar') return;

		const row = rows[Math.min(selected, rows.length - 1)];
		if (armedRemoval && !(ch === 'x' || key.delete || key.backspace)) {
			setArmedRemoval(undefined);
			setIndexNotice(undefined);
		}
		// Headers fold with ←/→; on a thread, ← folds the header it sits under.
		const header = (r: typeof row) =>
			r?.kind === 'section' ? `section:${r.name}` : r?.kind === 'agent' ? `agent:${agentKey(r.agent)}` : undefined;
		const parentHeader = () => {
			for (let i = Math.min(selected, rows.length - 1); i >= 0; i--) {
				const h = header(rows[i]);
				if (h) return { id: h, index: i };
			}
		};
		if (key.upArrow || ch === 'k') setSelected((s) => Math.max(0, s - 1));
		else if (key.downArrow || ch === 'j') setSelected((s) => Math.min(rows.length - 1, s + 1));
		else if (key.leftArrow || key.rightArrow) {
			const target = header(row) ? { id: header(row)!, index: selected } : key.leftArrow ? parentHeader() : undefined;
			if (target) {
				setLayout(toggleCollapsed(layout, target.id, key.leftArrow));
				setSelected(target.index);
			}
		} else if ((ch === 'x' || key.delete || key.backspace) && row?.kind === 'thread') {
			setLayout(toggleArchived(layout, threadKey(agentKey(row.agent), row.id)));
		} else if ((ch === 'x' || key.delete || key.backspace) && row?.kind === 'agent') {
			// Removing an agent edits the project's code, so it takes a second press to confirm.
			const name = agentKey(row.agent);
			if (name === 'chief' || name === 'worker') {
				// Core agents can't be removed (the chief needs both), so x hides them instead.
				// Dismiss the open thread's delegations too, or the agent would stay on screen.
				setDismissedDelegations((prev) => {
					const next = new Set(prev);
					for (const d of delegated) if (d.agent === name) next.add(`${d.agent}/${d.thread}`);
					return next;
				});
				setLayout(setHidden(layout, name, true));
				setSelected((i) => Math.max(0, i - 1));
				setIndexNotice(`${displayName(row.agent.name)} hidden — /show ${name} brings it back`);
			} else if (!local) {
				setIndexNotice('removing agents only works against a local dev server');
			} else if (armedRemoval !== name) {
				setArmedRemoval(name);
				setIndexNotice(`press x again to remove ${name} (restorable with /agent restore ${name})`);
			} else {
				setArmedRemoval(undefined);
				try {
					setIndexNotice(removeAgent(name));
				} catch (e) {
					setIndexNotice((e as Error).message);
				}
				setTimeout(refresh, 1500);
			}
		} else if (ch === 'p' && row?.kind === 'thread') {
			setLayout(togglePin(layout, threadKey(agentKey(row.agent), row.id)));
		} else if (ch === 'n' && row && (row.kind === 'agent' || row.kind === 'thread')) startThread(row.agent);
		else if (ch === 'r') refresh();
		else if (key.return && row) {
			if (row.kind === 'activity') {
				setOpen('activity');
				setFocus('input');
			} else if (row.kind === 'section') setLayout(toggleCollapsed(layout, `section:${row.name}`));
			else if (row.kind === 'agent') startThread(row.agent);
			else {
				setOpen({ mount: row.agent.mount, id: row.id });
				setFocus('input');
			}
		}
	});

	return (
		<Box height={height} width="100%">
			<Sidebar
				rows={rows}
				layout={layout}
				selected={selected}
				open={open}
				focused={focus === 'sidebar'}
				height={height}
				notice={indexNotice}
			/>
			{open === 'activity' || !openAgent ? (
				<Activity conn={conn} focused={focus === 'input'} height={height} onOpen={openThread} />
			) : (
				<Chat
					key={`${open.mount}/${open.id}`}
					conn={conn}
					agent={displayName(openAgent.name)}
					mcp={openAgent.mcp}
					mount={open.mount}
					threadId={open.id}
					focused={focus === 'input'}
					onSent={refresh}
					commandContext={commandContext}
					onCommand={runCommand}
					onCapturingTab={onCapturingTab}
					onDelegates={onDelegates}
				/>
			)}
		</Box>
	);
}

// One terminal is enough: start the dev server when none is running (local URLs only).
let managedServer = false;
if (local && !args['no-server']) {
	try {
		managedServer = await ensureDevServer(conn.baseUrl, (line) => console.log(line));
	} catch (e) {
		console.error((e as Error).message);
		process.exit(1);
	}
}

// Fullscreen: Ink owns the alternate screen (and the cursor) and restores both on exit.
const app = render(<App />, { exitOnCtrlC: false, alternateScreen: true });
app.waitUntilExit().finally(() => {
	// Free any browser-view images and turn mouse reporting off, in case the pane was open.
	if (supportsKitty()) process.stdout.write('\x1b_Ga=d,d=A,q=2\x1b\\');
	process.stdout.write('\x1b[?1016l\x1b[?1000l\x1b[?1006l');
	process.exit(0);
});
