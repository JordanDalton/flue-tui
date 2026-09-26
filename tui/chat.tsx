import { createFlueClient, type FlueConversationMessage, type FlueConversationPart } from '@flue/sdk';
import { Box, type DOMElement, measureElement, Text, useInput, useStdout } from 'ink';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Connection } from './api.ts';
import { findSessionId, sessionStatus } from './browser.ts';
import { type BrowserInput, BrowserView } from './browser-view.tsx';
import { COMMANDS, type CommandContext, parse, suggest } from './commands.ts';
import { SIDEBAR_WIDTH } from './sidebar.tsx';

// When this TUI first saw each running tool call. The conversation doesn't record a
// start time, so a thread opened mid-call counts from when it was opened.
const firstSeen = new Map<string, number>();

// Tools that end their output with a "Sources:" list of `- title: url` lines (web-search.ts).
function sourceHosts(output: unknown): string[] {
	if (typeof output !== 'string') return [];
	const i = output.lastIndexOf('\nSources:\n');
	if (i < 0) return [];
	return [...output.slice(i).matchAll(/https?:\/\/([^/\s]+)/g)].map((m) => m[1].replace(/^www\./, ''));
}

// MCP tools are named mcp__<server>__<tool>; show them as `server › tool`.
function ToolName({ name }: { name: string }) {
	const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
	if (!mcp) return <>{name}</>;
	return (
		<>
			<Text color="cyan">{mcp[1]}</Text> › {mcp[2]}
		</>
	);
}

function ToolRow({ part, now }: { part: Extract<FlueConversationPart, { type: 'dynamic-tool' }>; now: number }) {
	const input = JSON.stringify(part.input ?? {});
	const args = input.length > 60 ? `${input.slice(0, 57)}…` : input;
	const name = <ToolName name={part.toolName} />;
	if (part.state === 'input-available') {
		if (!firstSeen.has(part.toolCallId)) firstSeen.set(part.toolCallId, now);
		const elapsed = Math.max(0, Math.round((now - firstSeen.get(part.toolCallId)!) / 1000));
		return (
			<Text color="yellow" wrap="truncate">
				{' '}
				⚙ {name}({args}) {elapsed}s…
			</Text>
		);
	}
	const time = part.durationMs != null ? ` ${(part.durationMs / 1000).toFixed(1)}s` : '';
	if (part.state === 'output-error') {
		return (
			<Text color="red" wrap="truncate">
				{' '}
				⚙ {name}({args}) ✗ {part.errorText}
				{time}
			</Text>
		);
	}
	const hosts = [...new Set(sourceHosts(part.output))];
	const sources = hosts.length
		? ` · ${hosts.slice(0, 3).join(', ')}${hosts.length > 3 ? ` +${hosts.length - 3}` : ''}`
		: '';
	return (
		<Text color="green" wrap="truncate">
			{'  '}⚙ {name}({args}) ✓{time}
			<Text dimColor>{sources}</Text>
		</Text>
	);
}

// Outgoing agent-to-agent message (src/tools/agent-messaging.ts).
function SentRow({ part }: { part: Extract<FlueConversationPart, { type: 'dynamic-tool' }> }) {
	const input = (part.input ?? {}) as { to?: string; body?: string };
	const status = part.state === 'input-available' ? '…' : part.state === 'output-error' ? `✗ ${part.errorText}` : '';
	return (
		<Box
			flexDirection="column"
			borderStyle="single"
			borderLeft
			borderTop={false}
			borderRight={false}
			borderBottom={false}
			borderColor="blue"
			paddingLeft={1}
		>
			<Text color="blue">
				↗ to {input.to} {status}
			</Text>
			<Text dimColor>{input.body}</Text>
		</Box>
	);
}

// One-line summary of a runtime note. Tool-set changes list every tool with its
// description; count them instead, grouping MCP tools by server.
function summarizeSystem(text: string, attributes?: Record<string, string>): string {
	if (attributes?.resource === 'tool') {
		const added = text.includes('New tools available')
			? [...text.split('All available tools')[0].matchAll(/^- \*\*([\w-]+)\*\*/gm)].map((m) => m[1])
			: [];
		const updated = [...text.matchAll(/The tool "[^"]+" was updated/g)].length;
		const removed = [...text.matchAll(/(?:was|were) removed|no longer available/g)].length;
		const servers = new Map<string, number>();
		for (const name of added) {
			const server = /^mcp__(.+?)__/.exec(name)?.[1] ?? 'built-in';
			servers.set(server, (servers.get(server) ?? 0) + 1);
		}
		const parts = [
			added.length && `+${added.length} (${[...servers].map(([k, n]) => `${k} ×${n}`).join(', ')})`,
			updated && `${updated} updated`,
			removed && `${removed} removed`,
		].filter(Boolean);
		return `tools changed: ${parts.join(', ') || 'updated'}`;
	}
	return text.split('\n')[0];
}

/**
 * Delegations still waiting on a reply: message_agent / spawn_worker calls in this thread
 * with no <agent_message> back from the delegate's thread since.
 */
function pendingDelegations(messages: FlueConversationMessage[]) {
	const pending = new Map<string, { key: string; thread: string; label: string }>();
	let lastSender: string | undefined; // who last wrote to this thread; answering them isn't a delegation
	for (const m of messages) {
		const attrs = m.signal?.tagName === 'agent_message' ? m.signal.attributes : undefined;
		if (attrs?.fromThread) {
			for (const [key, d] of pending) if (d.thread === attrs.fromThread) pending.delete(key);
			lastSender = attrs.from;
			continue;
		}
		for (const p of m.parts) {
			if (p.type !== 'dynamic-tool' || p.state !== 'output-available' || typeof p.output !== 'string') continue;
			const input = (p.input ?? {}) as { to?: string; role?: string };
			const sent = /^Delivered to \S+ \(thread ([^,]+),/.exec(p.output);
			const spawned = /^Spawned worker (\S+) /.exec(p.output);
			if (p.toolName === 'message_agent' && sent && input.to !== lastSender) {
				pending.set(p.toolCallId, { key: p.toolCallId, thread: sent[1]!, label: input.to ?? 'agent' });
			} else if (p.toolName === 'spawn_worker' && spawned) {
				pending.set(p.toolCallId, { key: p.toolCallId, thread: spawned[1]!, label: input.role ?? 'worker' });
			}
		}
	}
	return [...pending.values()];
}

const NO_BROWSER = 'no browser open yet — ask the agent to open the page in its browser, then /view';

/**
 * Threads this conversation handed work to, most recent last. A worker's browser
 * lives in its own thread; /view follows these when this thread has no session.
 * Output text is the receipt from spawn_worker and message_agent.
 */
function delegatedThreads(messages: FlueConversationMessage[]): { agent: string; thread: string }[] {
	const seen = new Map<string, { agent: string; thread: string }>();
	for (const m of messages) {
		for (const p of m.parts) {
			if (p.type !== 'dynamic-tool' || p.state !== 'output-available' || typeof p.output !== 'string') continue;
			const sent = /^Delivered to (\S+) \(thread ([^,]+),/.exec(p.output);
			const spawned = /^Spawned worker (\S+) /.exec(p.output);
			const target =
				p.toolName === 'message_agent' && sent
					? { agent: sent[1]!, thread: sent[2]! }
					: p.toolName === 'spawn_worker' && spawned
						? { agent: 'worker', thread: spawned[1]! }
						: undefined;
			if (!target) continue;
			const key = `${target.agent}/${target.thread}`;
			seen.delete(key); // re-insert so the latest hand-off sorts last
			seen.set(key, target);
		}
	}
	return [...seen.values()];
}

/** Latest Tabfleet session across delegated threads (the last thread that has one). */
async function findDelegatedSession(
	conn: Connection,
	targets: { agent: string; thread: string }[],
	signal?: AbortSignal,
): Promise<string | undefined> {
	const ids = await Promise.all(
		targets.map(async (t) => {
			try {
				const client = createFlueClient({
					url: `${conn.baseUrl}/agents/${t.agent}/${t.thread}`,
					token: conn.token,
				});
				const snap = await client.history({ signal });
				return findSessionId(snap.messages.flatMap((m) => m.parts));
			} catch {
				return undefined; // missing thread, or this lookup was aborted
			}
		}),
	);
	for (let i = ids.length - 1; i >= 0; i--) if (ids[i]) return ids[i];
	return undefined;
}

interface MessageProps {
	message: FlueConversationMessage;
	agent: string;
	now: number;
	showThinking: boolean;
}

function Message({ message, agent, now, showThinking }: MessageProps) {
	// Incoming agent-to-agent message: a dispatched `agent_message` signal.
	if (message.signal?.tagName === 'agent_message') {
		const text = message.parts.map((p) => ('text' in p ? p.text : '')).join('');
		return (
			<Box
				flexDirection="column"
				marginBottom={1}
				flexShrink={0}
				borderStyle="single"
				borderLeft
				borderTop={false}
				borderRight={false}
				borderBottom={false}
				borderColor="blue"
				paddingLeft={1}
			>
				<Text bold color="blue">
					↘ from {message.signal.attributes?.from}
				</Text>
				<Text>{text}</Text>
			</Box>
		);
	}
	if (message.role === 'system') {
		const text = message.parts.map((p) => ('text' in p ? p.text : '')).join('');
		// Failed/aborted settlements stay in full; runtime notes to the model (tool-set
		// changes, instruction updates) collapse to one line unless details are expanded.
		const full = message.settlement || showThinking;
		return (
			<Box flexShrink={0}>
				<Text
					color={message.settlement ? 'red' : 'gray'}
					dimColor={!message.settlement}
					wrap={full ? 'wrap' : 'truncate'}
				>
					{' '}
					· {full ? text : summarizeSystem(text, message.signal?.attributes)}
				</Text>
			</Box>
		);
	}
	const isUser = message.role === 'user';
	return (
		<Box flexDirection="column" marginBottom={1} flexShrink={0}>
			<Text bold color={isUser ? 'cyan' : 'magenta'}>
				{isUser ? 'you' : agent}
			</Text>
			{message.parts.map((part, i) => {
				switch (part.type) {
					case 'text': {
						// A model sometimes invents a delegate's reply, copying the format real ones
						// arrive in. Real <agent_message>s are separate messages, never part of an
						// answer, so cut it off and say so rather than show it as if it were real.
						const fake = isUser ? -1 : part.text.search(/<agent_message[\s>]/);
						return (
							<Box key={i} flexDirection="column">
								<Text>
									{fake >= 0 ? part.text.slice(0, fake).trimEnd() : part.text}
									{part.state === 'streaming' && fake < 0 ? '▍' : ''}
								</Text>
								{fake >= 0 && (
									<Text color="red" dimColor>
										⚠ hidden: the agent wrote a made-up reply from another agent here. The real one arrives as its own
										message.
									</Text>
								)}
							</Box>
						);
					}
					case 'reasoning':
						// Collapsed to one line unless expanded with ctrl+o.
						return showThinking ? (
							<Text key={i} dimColor italic>
								{part.text}
							</Text>
						) : (
							<Text key={i} dimColor italic wrap="truncate">
								› {part.state === 'streaming' ? 'thinking… ' : ''}
								{part.text.replace(/\s+/g, ' ').trim()}
							</Text>
						);
					case 'dynamic-tool':
						return part.toolName === 'message_agent' ? (
							<SentRow key={i} part={part} />
						) : (
							<ToolRow key={i} part={part} now={now} />
						);
					case 'file':
						return (
							<Text key={i} dimColor>
								{' '}
								📎 {part.filename ?? part.mediaType}
							</Text>
						);
					default:
						return (
							<Text key={i} dimColor>
								{' '}
								[{part.type}]
							</Text>
						);
				}
			})}
		</Box>
	);
}

interface ChatProps {
	conn: Connection;
	agent: string;
	/** MCP servers the agent connects to, shown in the header. */
	mcp: string[];
	mount: string;
	threadId: string;
	focused: boolean;
	onSent: () => void;
	/** Agents and threads, for command completion. */
	commandContext: CommandContext;
	/** Runs an app-scoped slash command; returns an error message to show, if any. */
	onCommand: (name: string, arg: string) => string | void;
	/** Tells the app whether Tab is claimed for command completion. */
	onCapturingTab: (capturing: boolean) => void;
	/** Threads this conversation handed work to, so a hidden agent can still be opened. */
	onDelegates?: (targets: { agent: string; thread: string }[]) => void;
}

// One conversation. Keyed by thread in the parent, so switching threads remounts it
// and the old observation is closed.
export function Chat({
	conn,
	agent,
	mcp,
	mount,
	threadId,
	focused,
	onSent,
	commandContext,
	onCommand,
	onCapturingTab,
	onDelegates,
}: ChatProps) {
	const { client, observation } = useMemo(() => {
		const client = createFlueClient({ url: `${conn.baseUrl}${mount}/${threadId}`, token: conn.token });
		return { client, observation: client.observe({ live: 'sse' }) };
	}, [conn, mount, threadId]);
	useEffect(() => () => observation.close(), [observation]);

	const snap = useSyncExternalStore(observation.subscribe, observation.getSnapshot);
	const [input, setInput] = useState('');
	const [sending, setSending] = useState(false);
	const [notice, setNotice] = useState<string>();
	const [showThinking, setShowThinking] = useState(false);
	// Browser pane: off, or on with the chosen renderer.
	const [view, setView] = useState<false | 'auto' | 'blocks'>(false);
	// While driving the browser, keystrokes go to the page instead of the input.
	const [driving, setDriving] = useState(false);
	const browserInput = useRef<BrowserInput | null>(null);
	const { stdout } = useStdout();

	const messages = snap.conversation?.messages ?? [];
	const settlements = snap.conversation?.settlements ?? [];
	// This thread's own browser, or the latest one a worker it delegated to has open.
	const localSessionId = useMemo(() => findSessionId(messages.flatMap((m) => m.parts)), [messages]);
	// Keyed so the list keeps its identity while the transcript streams. Agent and thread
	// ids don't contain slashes (mount name, then conversation id).
	const delegateKey = useMemo(
		() => delegatedThreads(messages).map((d) => `${d.agent}/${d.thread}`).join('\n'),
		[messages],
	);
	const delegates = useMemo(
		() =>
			delegateKey
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const i = line.indexOf('/');
					return { agent: line.slice(0, i), thread: line.slice(i + 1) };
				}),
		[delegateKey],
	);
	useEffect(() => {
		onDelegates?.(delegates);
	}, [delegates, onDelegates]);
	useEffect(() => () => onDelegates?.([]), [onDelegates]);

	// Busy while any submission seen in the transcript has no settlement yet.
	const busy = useMemo(() => {
		const settled = new Set(settlements.map((s) => s.submissionId));
		return sending || messages.some((m) => m.submissionId && !settled.has(m.submissionId));
	}, [messages, settlements, sending]);

	// Tick once a second while a tool is running, for its elapsed-time counter.
	const toolRunning = messages.some((m) =>
		m.parts.some((p) => p.type === 'dynamic-tool' && p.state === 'input-available'),
	);
	const waiting = useMemo(() => pendingDelegations(messages), [messages]);
	const pendingKey = waiting.map((w) => w.thread).join('\n');
	const [remoteSessionId, setRemoteSessionId] = useState<string>();
	const sessionId = localSessionId ?? remoteSessionId;
	// /view closes the pane; don't pop the same session back open until a new one appears.
	const closedSession = useRef<string | undefined>(undefined);
	// Workers launch the browser in their own thread, often before they reply. Look it up
	// once the delegations are known, and again while one of them is still working.
	useEffect(() => {
		if (localSessionId || delegates.length === 0) return;
		const ac = new AbortController();
		const load = (targets: { agent: string; thread: string }[]) =>
			findDelegatedSession(conn, targets, ac.signal).then((id) => {
				if (!ac.signal.aborted && id) setRemoteSessionId(id);
			});
		void load(delegates);
		const pending = new Set(pendingKey.split('\n').filter(Boolean));
		const pendingTargets = delegates.filter((d) => pending.has(d.thread));
		if (pendingTargets.length === 0) return () => ac.abort();
		const timer = setInterval(() => void load(pendingTargets), 2000);
		return () => {
			ac.abort();
			clearInterval(timer);
		};
	}, [localSessionId, delegates, pendingKey, conn]);
	// The browser a worker opened is watched from this thread, not by opening the worker.
	useEffect(() => {
		if (!sessionId || view || closedSession.current === sessionId) return;
		let cancelled = false;
		sessionStatus(sessionId).then(
			(s) => {
				if (!cancelled && s.status === 'active' && closedSession.current !== sessionId) setView('auto');
			},
			() => {},
		);
		return () => {
			cancelled = true;
		};
	}, [sessionId, view]);
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		if (!toolRunning && waiting.length === 0) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [toolRunning, waiting.length]);

	// Slash-command suggestions for what's typed so far.
	const suggestions = useMemo(() => suggest(input, commandContext), [input, commandContext]);
	const [selected, setSelected] = useState(0);
	useEffect(() => setSelected(0), [suggestions.length]);
	const capturing = focused && suggestions.length > 0;
	useEffect(() => onCapturingTab(capturing || driving), [capturing, driving, onCapturingTab]);

	const abort = () => {
		if (!busy) {
			setNotice('nothing to abort');
			return;
		}
		client.abort().then(
			(r) => setNotice(r.aborted ? 'aborted' : 'nothing to abort'),
			(e) => setNotice(`abort failed: ${e.message}`),
		);
	};

	const send = (body: string) => {
		setScroll(0);
		setInput('');
		setNotice(undefined);
		setSending(true);
		client
			.send({ message: { kind: 'user', body } })
			.then(() => {
				// The first send creates the conversation; re-check if we were 'absent'.
				if (observation.getSnapshot().phase === 'absent') observation.refresh();
				onSent();
			})
			.catch((e) =>
				setNotice(
					e?.status === 404
						? `send failed: there's no "${mount.split('/').pop()}" agent on the server (removed?) — /new <agent> to start a thread with another one`
						: `send failed: ${e.message}`,
				),
			)
			.finally(() => setSending(false));
	};

	const runCommand = (line: string) => {
		setInput('');
		setNotice(undefined);
		const parsed = parse(line);
		if ('error' in parsed) {
			setNotice(parsed.error);
			return;
		}
		const { command, arg } = parsed;
		if (command.scope === 'app') {
			const error = onCommand(command.name, arg);
			if (error) setNotice(error);
			return;
		}
		switch (command.name) {
			case 'abort':
				abort();
				break;
			case 'thinking':
				setShowThinking((v) => !v);
				break;
			case 'view': {
				if (view) {
					closedSession.current = sessionId;
					setView(false);
					setDriving(false);
					break;
				}
				closedSession.current = undefined;
				const mode = arg === 'blocks' ? 'blocks' : 'auto';
				// Check first: the browser may have expired since the agent last used it.
				const open = (id: string) => {
					setNotice('checking the browser…');
					sessionStatus(id).then(
						(s) => {
							if (s.status === 'active') {
								setNotice(undefined);
								setView(mode);
								return;
							}
							const when = s.endedAt
								? ` at ${new Date(s.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
								: '';
							const why = s.closeReason === 'expired' ? ' when its time ran out' : '';
							setNotice(
								`the browser (${id.slice(0, 8)}) ${s.status === 'closed' ? 'closed' : `is ${s.status}`}${when}${why} — ask the agent to open the page again, then /view`,
							);
						},
						// Can't check (no key, network): try anyway; the pane reports errors itself.
						() => {
							setNotice(undefined);
							setView(mode);
						},
					);
				};
				if (sessionId) {
					open(sessionId);
					break;
				}
				if (delegates.length === 0) {
					setNotice(NO_BROWSER);
					break;
				}
				setNotice('checking the browser…');
				findDelegatedSession(conn, delegates).then(
					(id) => {
						if (!id) {
							setNotice(NO_BROWSER);
							return;
						}
						setRemoteSessionId(id);
						open(id);
					},
					(e) => setNotice(`couldn't check the browser: ${e.message}`),
				);
				break;
			}
			case 'info': {
				const running = messages.filter((m) => m.submissionId).length - settlements.length;
				setNotice(
					[
						`agent   ${agent} (${mount})`,
						`thread  ${threadId}`,
						`url     ${client.url}`,
						`status  ${snap.phase}${running > 0 ? `, ${running} running` : ''}`,
						`mcp     ${mcp.length ? mcp.join(', ') : 'none'}`,
					].join('\n'),
				);
				break;
			}
			case 'help':
				setNotice(
					[
						...COMMANDS.map((c) => `/${c.name}${c.args ? ` ${c.args}` : ''}`.padEnd(26) + c.description),
						'//text'.padEnd(26) + 'send a message that starts with /',
					].join('\n'),
				);
				break;
		}
	};

	// Scrollback, in lines up from the bottom. Measured after each render: the pane's height
	// and the transcript's full height bound it. While scrolled up, growth below (a streaming
	// reply) raises the offset by the same amount, so the view holds still.
	const paneRef = useRef<DOMElement>(null);
	const contentRef = useRef<DOMElement>(null);
	const [scroll, setScroll] = useState(0);
	const [paneHeight, setPaneHeight] = useState(0);
	const contentHeight = useRef(0);
	useLayoutEffect(() => {
		if (!paneRef.current || !contentRef.current) return;
		const pane = measureElement(paneRef.current).height;
		const content = measureElement(contentRef.current).height;
		const grew = content - contentHeight.current;
		contentHeight.current = content;
		if (pane !== paneHeight) setPaneHeight(pane);
		const max = Math.max(0, content - pane);
		setScroll((s) => Math.min(max, s > 0 && grew > 0 ? s + grew : s));
	});
	const scrollBy = (lines: number) =>
		setScroll((s) => Math.max(0, Math.min(Math.max(0, contentHeight.current - paneHeight), s + lines)));
	const page = Math.max(1, paneHeight - 2);

	useInput(
		(ch, key) => {
			// Mouse reports (ESC[<b;x;y M) and terminal replies (cell size ESC[6;h;wt, mode
			// report ESC[?1016;n$y) belong to the browser pane, which reads them itself.
			if (/\[<\d+;\d+;\d+[mM]|\[6;\d+;\d+t|\[\?\d+;\d\$y/.test(ch)) return;
			if (driving) {
				const b = browserInput.current;
				if (key.escape) b?.release();
				else if (key.return) b?.key('enter');
				else if (key.backspace || key.delete) b?.key('backspace');
				else if (key.tab) b?.key('tab');
				else if (key.upArrow) b?.key('up');
				else if (key.downArrow) b?.key('down');
				else if (key.leftArrow) b?.key('left');
				else if (key.rightArrow) b?.key('right');
				else if (key.pageUp) b?.key('pageup');
				else if (key.pageDown) b?.key('pagedown');
				else if (key.home) b?.key('home');
				else if (key.end) b?.key('end');
				else if (ch && !key.ctrl && !key.meta) b?.type(ch);
				return;
			}
			if (key.ctrl && ch === 'o') {
				setShowThinking((s) => !s);
				return;
			}
			// While suggestions are open: ↑↓ pick, tab completes, esc cancels.
			if (suggestions.length > 0) {
				const pick = suggestions[Math.min(selected, suggestions.length - 1)];
				if (key.upArrow) return setSelected((i) => (i - 1 + suggestions.length) % suggestions.length);
				if (key.downArrow) return setSelected((i) => (i + 1) % suggestions.length);
				if (key.tab) return setInput(pick.value);
				if (key.escape) return setInput('');
				if (key.return) {
					const typed = input.trim();
					// Run the typed line when it's already complete; otherwise take the suggestion,
					// running it straight away unless it still needs an argument.
					const complete = COMMANDS.some((c) => typed === `/${c.name}` && (!c.args || c.optionalArgs));
					if (complete || (typed.includes(' ') && pick.value.trim() === typed)) return runCommand(typed);
					if (pick.value.endsWith(' ')) return setInput(pick.value);
					return runCommand(pick.value);
				}
			}
			// Scrolling: ↑/↓ (and the mouse wheel, which terminals send as arrows in fullscreen
			// apps) by 3 lines, PgUp/PgDn by a page, End back to the latest.
			if (key.upArrow) return scrollBy(3);
			if (key.downArrow) return scrollBy(-3);
			if (key.pageUp) return scrollBy(page);
			if (key.pageDown) return scrollBy(-page);
			if (key.end) return setScroll(0);
			if (key.home) return scrollBy(Number.MAX_SAFE_INTEGER);
			if (key.escape) {
				if (busy) abort();
				return;
			}
			// A paste can arrive as one chunk with the Enter at the end.
			const pastedSubmit = !key.return && ch.length > 1 && /[\r\n]$/.test(ch);
			if (key.return || pastedSubmit) {
				const body = (pastedSubmit ? input + ch : input).replace(/\r/g, '\n').trim();
				if (!body) return;
				if (body.startsWith('//')) send(body.slice(1));
				else if (body.startsWith('/')) runCommand(body);
				else send(body);
				return;
			}
			if (key.backspace || key.delete) {
				setInput((s) => s.slice(0, -1));
				return;
			}
			if (ch && !key.ctrl && !key.meta && !key.tab) setInput((s) => s + ch);
		},
		{ isActive: focused },
	);

	const phaseColor = snap.phase === 'live' ? 'green' : snap.phase === 'error' ? 'red' : 'yellow';
	const visible = messages.filter((m) => m.display !== 'hidden').slice(-200);

	// The browser pane: a column to the right of the chat when there's room, otherwise stacked
	// above the transcript. The column gets ~60% of the width and the full height.
	const columns = stdout.columns || 100;
	const rows = stdout.rows || 30;
	const available = columns - SIDEBAR_WIDTH;
	const side = available >= 90;
	const browserWidth = Math.min(available - 40, Math.floor(available * 0.6));
	const browser =
		view && sessionId
			? (maxCols: number, maxRows: number) => (
					<BrowserView
						sessionId={sessionId}
						owner={localSessionId ? undefined : 'worker'}
						blocks={view === 'blocks'}
						maxCols={Math.max(20, maxCols)}
						maxRows={Math.max(6, maxRows)}
						inputRef={browserInput}
						onDrivingChange={setDriving}
						onScroll={scrollBy}
					/>
				)
			: undefined;

	return (
		<Box flexGrow={1}>
			<Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
				<Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between" flexShrink={0}>
					<Text bold>
						{agent} · {threadId}
						{mcp.length > 0 && (
							<Text dimColor bold={false}>
								{' '}
								· mcp: {mcp.join(', ')}
							</Text>
						)}
					</Text>
					<Text color={phaseColor}>● {snap.phase === 'absent' ? 'new thread' : snap.phase}</Text>
				</Box>

				{browser && !side && <Box flexShrink={0}>{browser(available - 4, Math.floor(rows * 0.55))}</Box>}

				{/* Bottom-anchored: when the transcript is taller than the pane, the top is clipped.
			    Scrolling pulls the content down by `scroll` lines with a negative bottom margin. */}
				<Box ref={paneRef} flexDirection="column" flexGrow={1} justifyContent="flex-end" overflow="hidden" paddingX={1}>
					<Box ref={contentRef} flexDirection="column" flexShrink={0} marginBottom={-scroll}>
						{visible.length === 0 && snap.phase !== 'loading' && <Text dimColor>No messages yet. Say hi.</Text>}
						{visible.map((m) => (
							<Message key={m.id} message={m} agent={agent} now={now} showThinking={showThinking} />
						))}
						{/* flexShrink={0}: in an overflowing pane, shrinkable lines get squeezed to nothing. */}
						{snap.error && snap.phase !== 'absent' && (
							<Box flexShrink={0}>
								<Text color="red">{snap.error.message}</Text>
							</Box>
						)}
						{notice && (
							<Box flexShrink={0}>
								<Text color="yellow">{notice}</Text>
							</Box>
						)}
					</Box>
				</Box>
				{waiting.map((d) => {
					// Live status from the sidebar index: is the delegate's thread still busy?
					const thread = commandContext.agents.flatMap((a) => a.threads).find((t) => t.id === d.thread);
					const label = thread?.label ?? d.label;
					if (!firstSeen.has(d.key)) firstSeen.set(d.key, now);
					const secs = Math.max(0, Math.round((now - firstSeen.get(d.key)!) / 1000));
					return (
						<Box key={d.key} paddingX={1} flexShrink={0}>
							<Text color="yellow" wrap="truncate">
								⧗ {label} {thread?.busy === false ? 'finished, reply on its way' : 'is working'} · {secs}s
								<Text dimColor> · /open {d.thread}</Text>
							</Text>
						</Box>
					);
				})}
				{scroll > 0 && (
					<Box paddingX={1} flexShrink={0}>
						<Text inverse dimColor>
							{' '}
							↓ {scroll} more line{scroll === 1 ? '' : 's'} below · end to jump{' '}
						</Text>
					</Box>
				)}

				{capturing && (
					<Box flexDirection="column" paddingX={2} flexShrink={0}>
						{suggestions.map((sug, i) => (
							<Text key={sug.value} wrap="truncate">
								<Text inverse={i === Math.min(selected, suggestions.length - 1)} color="cyan">
									{sug.label.padEnd(26)}
								</Text>
								<Text dimColor> {sug.description}</Text>
							</Text>
						))}
					</Box>
				)}

				<Box
					borderStyle="round"
					borderColor={focused ? (busy ? 'yellow' : 'cyan') : 'gray'}
					paddingX={1}
					justifyContent="space-between"
					flexShrink={0}
				>
					<Text>
						<Text color="cyan">› </Text>
						{input}
						{focused && <Text inverse> </Text>}
					</Text>
					<Text dimColor wrap="truncate">
						{driving
							? 'typing into the browser · esc to hand back to the agent'
							: capturing
								? '↑↓ pick · tab complete · enter run · esc cancel'
								: busy
									? 'working… esc abort'
									: `enter send · / commands${sessionId && !view ? ' · /view browser' : ''} · ctrl+o ${showThinking ? 'hide' : 'show'} details · tab threads`}
					</Text>
				</Box>
			</Box>
			{browser && side && (
				<Box
					width={browserWidth}
					flexShrink={0}
					flexDirection="column"
					borderStyle="round"
					borderColor={driving ? 'yellow' : 'gray'}
				>
					{browser(browserWidth - 4, rows - 5)}
				</Box>
			)}
		</Box>
	);
}
