import { Box, Text } from 'ink';
import React from 'react';
import { ago, displayName, type TuiAgent } from './api.ts';
import { agentKey } from './commands.ts';
import { ARCHIVED, type Layout, orderedSections, threadKey } from './layout.ts';

export const SIDEBAR_WIDTH = 32;

export type Row =
	| { kind: 'activity' }
	| { kind: 'section'; name: string; count: number; collapsed: boolean; archive?: boolean }
	| { kind: 'agent'; agent: TuiAgent; count: number; collapsed: boolean }
	| {
			kind: 'thread';
			agent: TuiAgent;
			id: string;
			preview: string;
			lastAt?: number;
			busy: boolean;
			/** Set for threads listed in a section, where the agent needs naming. */
			tag?: string;
			/** Shown instead of the id (a worker's role). */
			label?: string;
	  };

type ThreadRow = Extract<Row, { kind: 'thread' }>;

// Flattens sections, agents and threads into the selectable rows the sidebar renders.
// Sectioned threads show under their section (from any agent, even a hidden one) and
// not under their agent. `reveal` lists threads to show anyway when their agent is
// hidden — the open conversation delegated to them.
export function toRows(
	agents: TuiAgent[],
	layout: Layout,
	reveal: { agent: string; thread: string }[] = [],
): Row[] {
	const byKey = new Map<string, ThreadRow>();
	for (const agent of agents) {
		for (const t of agent.threads) {
			byKey.set(threadKey(agentKey(agent), t.id), {
				kind: 'thread',
				agent,
				id: t.id,
				preview: t.preview,
				lastAt: t.lastAt,
				busy: t.busy,
				...(t.label && { label: t.label }),
			});
		}
	}

	// Archived threads are listed only in the Archived group at the end.
	// Retired workers count as archived.
	const archived = new Set([
		...(layout.archived ?? []),
		...agents.flatMap((a) => a.threads.filter((t) => t.retired).map((t) => threadKey(agentKey(a), t.id))),
	]);
	const rows: Row[] = [{ kind: 'activity' }];
	const sectioned = new Set<string>();
	for (const section of orderedSections(layout)) {
		const threads = section.threads.flatMap((k) => {
			const row = archived.has(k) ? undefined : byKey.get(k);
			return row ? [{ ...row, tag: agentKey(row.agent) }] : [];
		});
		section.threads.forEach((k) => sectioned.add(k));
		const collapsed = layout.collapsed.includes(`section:${section.name}`);
		rows.push({ kind: 'section', name: section.name, count: threads.length, collapsed });
		if (!collapsed) rows.push(...threads);
	}

	for (const agent of agents) {
		const key = agentKey(agent);
		const hidden = layout.hidden.includes(key);
		const revealed = new Set(reveal.filter((r) => r.agent === key).map((r) => r.thread));
		if (hidden && revealed.size === 0) continue;
		const threads = [...byKey.entries()]
			.filter(([k, row]) => row.agent === agent && !sectioned.has(k) && !archived.has(k))
			.filter(([, row]) => !hidden || revealed.has(row.id))
			.map(([, row]) => row);
		// A hidden agent with nothing left to show (its delegation was archived) stays hidden.
		if (hidden && threads.length === 0) continue;
		const collapsed = layout.collapsed.includes(`agent:${key}`);
		rows.push({ kind: 'agent', agent, count: threads.length, collapsed });
		if (!collapsed) rows.push(...threads);
	}

	const archivedRows = [...archived].flatMap((k) => {
		const row = byKey.get(k);
		return row ? [{ ...row, tag: agentKey(row.agent) }] : [];
	});
	if (archivedRows.length) {
		const collapsed = layout.collapsed.includes(`section:${ARCHIVED}`);
		rows.push({ kind: 'section', name: ARCHIVED, count: archivedRows.length, collapsed, archive: true });
		if (!collapsed) rows.push(...archivedRows);
	}
	return rows;
}

// Keys for the selected row; the sidebar is too narrow to list them all at once.
function hint(row: Row | undefined, layout: Layout): string {
	if (row?.kind === 'agent') {
		const core = ['chief', 'worker'].includes(agentKey(row.agent));
		return `enter new thread · x ${core ? 'hide' : 'remove'} · ←→ fold`;
	}
	if (row?.kind !== 'thread') return row?.kind === 'activity' ? 'enter open · tab chat' : 'enter/←→ fold · n new';
	const archived = (layout.archived ?? []).includes(threadKey(agentKey(row.agent), row.id));
	return `enter open · x ${archived ? 'unarchive' : 'archive'} · p pin`;
}

interface SidebarProps {
	rows: Row[];
	layout: Layout;
	selected: number;
	/** The open thread, or 'activity' when the activity feed is showing. */
	open: { mount: string; id: string } | 'activity';
	focused: boolean;
	height: number;
	notice?: string;
}

export function Sidebar({ rows, layout, selected, open, focused, height, notice }: SidebarProps) {
	// Thread rows take two lines; keep the selection inside a window that fits.
	const budget = Math.max(4, height - 6);
	let start = 0;
	const lines = (from: number, to: number) =>
		rows.slice(from, to + 1).reduce((n, r) => n + (r.kind === 'thread' ? 2 : 1), 0);
	while (start < selected && lines(start, selected) > budget) start++;
	let end = start;
	while (end + 1 < rows.length && lines(start, end + 1) <= budget) end++;

	const caret = (collapsed: boolean) => (collapsed ? '▸ ' : '▾ ');

	return (
		<Box
			flexDirection="column"
			width={SIDEBAR_WIDTH}
			flexShrink={0}
			borderStyle="round"
			borderColor={focused ? 'cyan' : 'gray'}
			paddingX={1}
		>
			<Text bold>flue</Text>
			<Box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
				{rows.slice(start, end + 1).map((row, i) => {
					const isSelected = focused && start + i === selected;
					if (row.kind === 'activity') {
						return (
							<Text key="activity" inverse={isSelected} color={open === 'activity' ? 'cyan' : 'blue'} wrap="truncate">
								{open === 'activity' ? '› ' : ''}» Activity
							</Text>
						);
					}
					if (row.kind === 'section') {
						return (
							<Text
								key={`s:${row.name}`}
								bold={!row.archive}
								color={row.archive ? 'gray' : 'yellow'}
								inverse={isSelected}
								wrap="truncate"
							>
								{caret(row.collapsed)}
								{row.name}
								<Text dimColor bold={false}>
									{' '}
									{row.count}
								</Text>
							</Text>
						);
					}
					if (row.kind === 'agent') {
						return (
							<Text key={`a:${row.agent.mount}`} bold color="magenta" inverse={isSelected} wrap="truncate">
								{caret(row.collapsed)}
								{displayName(row.agent.name)}
								{row.collapsed ? (
									<Text dimColor bold={false}>
										{' '}
										{row.count}
									</Text>
								) : null}
							</Text>
						);
					}
					const isOpen = open !== 'activity' && row.agent.mount === open.mount && row.id === open.id;
					return (
						<Box key={`t:${row.tag ?? ''}:${row.agent.mount}/${row.id}`} flexDirection="column">
							<Text inverse={isSelected} color={isOpen ? 'cyan' : undefined} wrap="truncate">
								{row.busy ? <Text color="yellow">● </Text> : isOpen ? '› ' : '  '}
								{row.label ?? row.id}
								{row.tag ? <Text color="magenta"> @{row.tag}</Text> : null}
								{row.lastAt ? <Text dimColor> {ago(row.lastAt)}</Text> : null}
							</Text>
							<Text dimColor wrap="truncate">
								{'  '}
								{row.preview || '(new)'}
							</Text>
						</Box>
					);
				})}
			</Box>
			{notice && (
				<Text color="yellow" wrap="truncate">
					{notice}
				</Text>
			)}
			<Text dimColor wrap="truncate">
				{focused ? hint(rows[selected], layout) : 'tab threads'}
			</Text>
		</Box>
	);
}
