import { Box, Text, useInput } from 'ink';
import React, { useEffect, useState } from 'react';
import { ago, type Connection, fetchActivity, type TuiActivity } from './api.ts';

interface ActivityProps {
	conn: Connection;
	focused: boolean;
	height: number;
	/** Opens a thread by mount name and id. */
	onOpen: (mount: string, thread: string) => void;
}

// Live feed of agent-to-agent messages across every thread, newest first.
export function Activity({ conn, focused, height, onOpen }: ActivityProps) {
	const [items, setItems] = useState<TuiActivity[]>();
	const [error, setError] = useState<string>();
	const [selected, setSelected] = useState(0);

	useEffect(() => {
		const load = () =>
			fetchActivity(conn).then(
				(a) => {
					setItems(a);
					setError(undefined);
				},
				(e) => setError(e.message),
			);
		load();
		const timer = setInterval(load, 2000);
		return () => clearInterval(timer);
	}, [conn]);

	const list = items ?? [];
	useInput(
		(ch, key) => {
			if (key.upArrow || ch === 'k') setSelected((s) => Math.max(0, s - 1));
			else if (key.downArrow || ch === 'j') setSelected((s) => Math.min(list.length - 1, s + 1));
			else if (key.return && list[selected]) onOpen(list[selected].to, list[selected].thread);
			else if (ch === 's' && list[selected]) onOpen(list[selected].from, list[selected].fromThread);
		},
		{ isActive: focused },
	);

	// Each item takes three lines; keep the selection on screen.
	const perPage = Math.max(1, Math.floor((height - 6) / 3));
	const start = Math.max(0, Math.min(selected - perPage + 1, list.length - perPage));
	const page = list.slice(Math.max(0, start), Math.max(0, start) + perPage);

	return (
		<Box flexDirection="column" flexGrow={1}>
			<Box borderStyle="round" borderColor="gray" paddingX={1} justifyContent="space-between" flexShrink={0}>
				<Text bold>» Agent activity</Text>
				<Text dimColor>{list.filter((i) => i.busy).length} in progress</Text>
			</Box>
			<Box flexDirection="column" flexGrow={1} overflow="hidden" paddingX={1}>
				{error && <Text color="red">{error}</Text>}
				{items && list.length === 0 && <Text dimColor>No agent-to-agent messages yet.</Text>}
				{page.map((item, i) => {
					const isSelected = focused && Math.max(0, start) + i === selected;
					return (
						<Box key={`${item.at}-${item.thread}`} flexDirection="column" marginBottom={1} flexShrink={0}>
							<Text inverse={isSelected} wrap="truncate">
								<Text dimColor>{ago(item.at).padStart(3)} </Text>
								<Text color="magenta">{item.from}</Text>
								<Text> → </Text>
								<Text color="magenta">{item.to}</Text>
								{item.busy ? <Text color="yellow"> ● working</Text> : null}
								<Text dimColor> {item.thread}</Text>
							</Text>
							<Text wrap="truncate"> {item.body}</Text>
						</Box>
					);
				})}
			</Box>
			<Box borderStyle="round" borderColor={focused ? 'cyan' : 'gray'} paddingX={1} flexShrink={0}>
				<Text dimColor>↑↓ select · enter open recipient thread · s open sender thread · tab sidebar</Text>
			</Box>
		</Box>
	);
}
