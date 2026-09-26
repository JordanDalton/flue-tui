import { Box, type DOMElement, Text } from 'ink';
import React, { type MutableRefObject, useEffect, useRef, useState } from 'react';
import {
	currentTabId,
	decodeJpeg,
	fit,
	type Frame,
	halfBlockRows,
	kittyDelete,
	kittyRows,
	kittyUpload,
	type CellSize,
	MAX_KITTY_ROWS,
	measureCell,
	screenshot,
	scrollPage,
	supportsKitty,
	tabfleetKey,
} from './browser.ts';
import { BrowserControl, type SpecialKey } from './cdp.ts';

/** What the chat pane forwards to the browser while the user is driving it. */
export interface BrowserInput {
	key(name: SpecialKey): void;
	type(text: string): void;
	release(): void;
}

interface BrowserViewProps {
	sessionId: string;
	/** Whose browser this is, when it isn't this thread's own. */
	owner?: string;
	maxCols: number;
	maxRows: number;
	/** Force the half-block renderer even where Kitty graphics are available. */
	blocks: boolean;
	/** Set while the user is driving, so the chat pane can forward keystrokes. */
	inputRef: MutableRefObject<BrowserInput | null>;
	/** Driving started or stopped. */
	onDrivingChange: (driving: boolean) => void;
	/** Mouse wheel outside the page: scroll the transcript by this many lines. */
	onScroll: (lines: number) => void;
}

const REFRESH_MS = 2000;
const IDLE_RELEASE_MS = 90_000; // hand the browser back if the user walks away
const WHEEL_PX = 240;

// Whether the page visibly changed. Screenshots are JPEGs, so identical pages still differ
// by compression noise; count only clear differences, on a sample of ~4k pixels.
function changed(prev: Frame | undefined, next: Frame): boolean {
	if (!prev?.rgba || !next.rgba || prev.width !== next.width || prev.height !== next.height) return true;
	const step = Math.max(4, Math.floor(next.rgba.length / 4096 / 4) * 4);
	let samples = 0;
	let different = 0;
	for (let i = 0; i < next.rgba.length; i += step) {
		samples++;
		if (Math.abs(prev.rgba[i]! - next.rgba[i]!) > 40) different++;
	}
	return different / samples > 0.002;
}

// Screen position of an Ink element, from its Yoga layout.
function screenPosition(el: DOMElement) {
	let x = 0;
	let y = 0;
	for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
		x += n.yogaNode?.getComputedLeft() ?? 0;
		y += n.yogaNode?.getComputedTop() ?? 0;
	}
	return { x, y };
}

// A Tabfleet browser in the chat pane. Watching re-screenshots every couple of seconds over
// MCP, which never gets in the agent's way. Clicking the page takes control: a CDP
// connection streams frames and receives clicks, scrolling and typing, and the agent's
// browser actions are refused until control is handed back (esc, or after idling).
export function BrowserView({
	sessionId,
	owner,
	maxCols,
	maxRows,
	blocks,
	inputRef,
	onDrivingChange,
	onScroll,
}: BrowserViewProps) {
	const kitty = supportsKitty() && !blocks;
	const [frame, setFrame] = useState<Frame>();
	const [updatedAt, setUpdatedAt] = useState<number>();
	const [error, setError] = useState<string>();
	const [control, setControl] = useState<BrowserControl>();
	const [connecting, setConnecting] = useState(false);
	// Page size in CSS pixels, for mapping clicks onto the page.
	const page = useRef({ width: 1440, height: 900 });
	const lastInput = useRef(Date.now());
	const mounted = useRef(true);
	useEffect(
		() => () => {
			mounted.current = false;
		},
		[],
	);

	// Watching: poll screenshots, paused while driving (Tabfleet refuses MCP actions then).
	useEffect(() => {
		if (control) return;
		let stopped = false;
		let timer: NodeJS.Timeout;
		let last: Frame | undefined;
		const tick = async () => {
			try {
				const next = await screenshot(sessionId);
				if (stopped) return;
				page.current = { width: next.width, height: next.height };
				if (changed(last, next)) {
					last = next;
					setFrame(next);
				}
				setUpdatedAt(Date.now());
				setError(undefined);
				timer = setTimeout(tick, REFRESH_MS);
			} catch (e) {
				if (stopped) return;
				setError((e as Error).message);
				timer = setTimeout(tick, REFRESH_MS * 3); // back off; the session may have closed
			}
		};
		tick();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [sessionId, control]);

	const takeControl = async (): Promise<BrowserControl | undefined> => {
		if (control) return control;
		if (connecting) return;
		setConnecting(true);
		// Once attached, the agent is locked out until release: every exit path below must
		// either hand over `c` (setControl) or release it.
		let c: BrowserControl | undefined;
		try {
			const tab = await currentTabId(sessionId).catch(() => undefined);
			c = await BrowserControl.attach(sessionId, tabfleetKey(), tab);
			if (!mounted.current) {
				c.release(); // the pane closed while connecting
				return;
			}
			const attached = c;
			attached.onClose = (reason) => {
				setControl(undefined);
				onDrivingChange(false);
				if (reason !== 'released') setError(`control ended: ${reason}`);
			};
			// Frames arrive as the page changes; render at most ~8 per second.
			let pending: Frame | undefined;
			let flush: NodeJS.Timeout | undefined;
			await attached.screencast(kitty ? 'png' : 'jpeg', 1200, (f) => {
				page.current = { width: f.width, height: f.height };
				pending = kitty ? { width: f.width, height: f.height, png: f.data } : decodeJpeg(f.data);
				flush ??= setTimeout(() => {
					flush = undefined;
					if (pending) setFrame(pending);
					setUpdatedAt(Date.now());
				}, 120);
			});
			lastInput.current = Date.now();
			setError(undefined);
			setControl(attached);
			onDrivingChange(true);
			return attached;
		} catch (e) {
			c?.release();
			if (mounted.current) setError(`could not take control: ${(e as Error).message}`);
		} finally {
			if (mounted.current) setConnecting(false);
		}
	};

	// Hand back after idling, and always when the pane closes.
	useEffect(() => {
		if (!control) return;
		const timer = setInterval(() => {
			if (Date.now() - lastInput.current > IDLE_RELEASE_MS) control.release();
		}, 5000);
		return () => {
			clearInterval(timer);
			control.release();
		};
	}, [control]);

	// Keystrokes from the chat pane while driving.
	useEffect(() => {
		inputRef.current = control
			? {
					key: (name) => {
						lastInput.current = Date.now();
						control.key(name).catch(() => {});
					},
					type: (text) => {
						lastInput.current = Date.now();
						control.type(text).catch(() => {});
					},
					release: () => control.release(),
				}
			: null;
		return () => {
			inputRef.current = null;
		};
	}, [control, inputRef]);

	// The terminal's real cell shape, so the grid matches the page and clicks land true.
	const [cell, setCell] = useState<CellSize>();
	useEffect(() => {
		measureCell().then(setCell);
	}, []);
	const size =
		frame && fit(frame, maxCols, kitty ? Math.min(maxRows, MAX_KITTY_ROWS) : maxRows, cell && cell.width / cell.height);

	// Mouse: SGR reports (ESC[<button;col;row M/m) while the pane is open. Ink reads the same
	// bytes; the chat pane ignores them.
	const imageRef = useRef<DOMElement>(null);
	const latest = useRef({ size, control, takeControl, onScroll });
	latest.current = { size, control, takeControl, onScroll };
	useEffect(() => {
		process.stdout.write('\x1b[?1000h\x1b[?1006h');
		// Pixel-precise reports (SGR-Pixels, mode 1016) when we know the cell size to convert
		// them; cells are too coarse for small links. Ask whether the terminal switched modes.
		let pixels = false;
		if (cell) process.stdout.write('\x1b[?1016h\x1b[?1016$p');
		let wheelTotal = 0;
		let wheelTimer: NodeJS.Timeout | undefined;
		const onData = (data: Buffer) => {
			const text = data.toString();
			const mode = /\x1b\[\?1016;(\d)\$y/.exec(text);
			if (mode) pixels = mode[1] === '1' || mode[1] === '3';
			for (const m of text.matchAll(/\x1b\[<(\d+);(\d+);(\d+)([mM])/g)) {
				const button = Number(m[1]);
				// Position in cells (fractional in pixel mode), 0-based.
				const x = pixels && cell ? (Number(m[2]) - 1) / cell.width : Number(m[2]) - 1 + 0.5;
				const y = pixels && cell ? (Number(m[3]) - 1) / cell.height : Number(m[3]) - 1 + 0.5;
				const pressed = m[4] === 'M';
				const { size: s, control: c, takeControl: take, onScroll: scroll } = latest.current;
				const origin = imageRef.current ? screenPosition(imageRef.current) : undefined;
				const inside =
					!!s && !!origin && x >= origin.x && x < origin.x + s.cols && y >= origin.y && y < origin.y + s.rows;
				const px = inside ? ((x - origin!.x) / s!.cols) * page.current.width : 0;
				const py = inside ? ((y - origin!.y) / s!.rows) * page.current.height : 0;
				const wheel = button & 64 ? (button & 1 ? 1 : -1) : 0;

				if (wheel && !inside) scroll(-wheel * 3);
				else if (wheel && c) {
					lastInput.current = Date.now();
					c.wheel(px, py, wheel * WHEEL_PX).catch(() => {});
				} else if (wheel) {
					// Watching: batch wheel ticks into one MCP scroll.
					wheelTotal += wheel * WHEEL_PX;
					wheelTimer ??= setTimeout(() => {
						const delta = wheelTotal;
						wheelTotal = 0;
						wheelTimer = undefined;
						scrollPage(sessionId, delta).catch((e) => setError(e.message));
					}, 150);
				} else if (button === 0 && pressed && inside) {
					lastInput.current = Date.now();
					(c ? Promise.resolve(c) : take()).then((ctl) => ctl?.click(px, py)).catch(() => {});
				}
			}
		};
		process.stdin.on('data', onData);
		return () => {
			process.stdin.off('data', onData);
			process.stdout.write('\x1b[?1016l\x1b[?1000l\x1b[?1006l');
			clearTimeout(wheelTimer);
		};
	}, [sessionId, cell]);

	// Kitty: upload each frame once; the rows below only reference it by id. The previous
	// image is deleted shortly after the new one is on screen, so refreshes don't blink.
	const [imageId, setImageId] = useState<number>();
	useEffect(() => {
		if (!kitty || !frame || !size) return;
		const id = kittyUpload(frame, size.cols, size.rows);
		setImageId(id);
		return () => {
			setTimeout(() => kittyDelete(id), 300);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps -- size derives from frame and limits
	}, [kitty, frame, size?.cols, size?.rows]);

	const rows = !size
		? []
		: kitty
			? imageId !== undefined
				? kittyRows(imageId, size.cols, size.rows)
				: []
			: halfBlockRows(frame!, size.cols, size.rows);

	const age = updatedAt ? Math.round((Date.now() - updatedAt) / 1000) : undefined;
	return (
		<Box flexDirection="column" flexShrink={0} paddingX={1} marginBottom={1}>
			{control ? (
				<Text color="yellow" wrap="truncate">
					● you're driving · the agent's browser actions wait until you hand back · esc to hand back
				</Text>
			) : (
				<Text dimColor wrap="truncate">
					{owner ? `${owner}'s browser` : 'browser'} · {sessionId.slice(0, 8)} ·{' '}
					{connecting ? 'taking control…' : age === undefined ? 'loading…' : `updated ${age}s ago`}
					{kitty ? '' : ' · blocks'} · click to take control · wheel scrolls · /view to close
				</Text>
			)}
			{error && (
				<Text color="yellow" wrap="truncate">
					{error}
				</Text>
			)}
			<Box ref={imageRef} flexDirection="column">
				{rows.map((row, i) => (
					<Text key={i}>{row}</Text>
				))}
			</Box>
		</Box>
	);
}
