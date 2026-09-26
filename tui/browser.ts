import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import jpeg from 'jpeg-js';

// Shows an agent's Tabfleet browser inside the TUI. Flue flattens MCP image results to
// text before they reach the conversation, so the TUI takes its own screenshots of the
// thread's browser session over Tabfleet's MCP server (URL and key from mcp.json/.env).
// Manual control (clicking and typing into the page) lives in cdp.ts.
//
// Rendering: in terminals with the Kitty graphics protocol (Ghostty, Kitty) the image is
// sent once and drawn through Unicode placeholder cells, which Ink lays out like text.
// Elsewhere it falls back to half-block characters (two pixels per cell).

/** A browser frame: decoded pixels, or PNG data that Kitty-capable terminals take as-is. */
export type Frame = { width: number; height: number; rgba?: Uint8Array; png?: string };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The most recent Tabfleet session id seen in a thread's tool calls. */
export function findSessionId(parts: { type: string; toolName?: string; input?: unknown; output?: unknown }[]) {
	let id: string | undefined;
	for (const p of parts) {
		if (p.type !== 'dynamic-tool' || !p.toolName?.startsWith('mcp__tabfleet__')) continue;
		const input = p.input as { sessionId?: string } | undefined;
		const found = input?.sessionId ?? UUID.exec(typeof p.output === 'string' ? p.output : '')?.[0];
		if (found) id = found;
	}
	return id;
}

let client: Promise<Client> | undefined;

function tabfleetConfig() {
	// Resolved from the project root (this file's parent), not the directory the TUI runs in.
	const mcp = JSON.parse(readFileSync(new URL('../mcp.json', import.meta.url), 'utf8')) as {
		servers?: Record<string, { url: string; auth?: string }>;
	};
	const server = mcp.servers?.tabfleet;
	if (!server) throw new Error('no tabfleet server in mcp.json');
	const auth = server.auth?.replace(/\$\{(\w+)\}/g, (_, name: string) => {
		const value = process.env[name];
		if (!value) throw new Error(`$${name} is not set (add it to .env)`);
		return value;
	});
	return { url: server.url, auth };
}

/** The Tabfleet API key (from mcp.json's tabfleet auth, resolved from the environment). */
export function tabfleetKey(): string {
	const { auth } = tabfleetConfig();
	if (!auth) throw new Error('mcp.json has no auth for tabfleet');
	return auth;
}

function connect(): Promise<Client> {
	client ??= (async () => {
		const { url, auth } = tabfleetConfig();
		const c = new Client({ name: 'flue-tui', version: '1.0.0' });
		await c.connect(
			new StreamableHTTPClientTransport(new URL(url), {
				requestInit: { headers: auth ? { authorization: `Bearer ${auth}` } : {} },
			}),
		);
		return c;
	})().catch((e) => {
		client = undefined; // retry on the next call
		throw e;
	});
	return client;
}

type ToolResult = { isError?: boolean; content?: { type: string; data?: string; mimeType?: string; text?: string }[] };

async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
	const result = (await (await connect()).callTool({ name, arguments: args })) as ToolResult;
	if (result.isError) {
		const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
		// Tabfleet errors are JSON: {"error":"…","message":"…"}
		const message = /"message"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? text.slice(0, 200);
		throw new Error(message || `${name} failed`);
	}
	return result;
}

/** A session's lifecycle state from Tabfleet's REST API ('active', 'closed', …). */
export async function sessionStatus(
	sessionId: string,
): Promise<{ status: string; endedAt?: string; closeReason?: string }> {
	const res = await fetch(`https://api.tabfleet.com/v1/sessions/${sessionId}`, {
		headers: { authorization: `Bearer ${tabfleetKey()}` },
	});
	if (!res.ok) throw new Error(`could not look up the browser session (${res.status})`);
	return (await res.json()) as { status: string; endedAt?: string; closeReason?: string };
}

/** Decodes a base64 JPEG into a frame. */
export function decodeJpeg(base64: string): Frame {
	const decoded = jpeg.decode(Buffer.from(base64, 'base64'), { useTArray: true, formatAsRGBA: true });
	return { width: decoded.width, height: decoded.height, rgba: decoded.data };
}

/** Screenshots a Tabfleet session's current tab. */
export async function screenshot(sessionId: string): Promise<Frame> {
	const image = (await tool('browser_screenshot', { sessionId })).content?.find((c) => c.type === 'image');
	if (!image?.data) throw new Error('no screenshot returned');
	if (image.mimeType !== 'image/jpeg') throw new Error(`unsupported screenshot type ${image.mimeType}`);
	return decodeJpeg(image.data);
}

/** Scrolls the current tab through MCP, which (unlike manual control) never blocks the agent. */
export async function scrollPage(sessionId: string, deltaY: number) {
	await tool('browser_scroll', { sessionId, deltaY });
}

/** The tab the agent is working in; its id doubles as the CDP target id. */
export async function currentTabId(sessionId: string): Promise<string | undefined> {
	const text = (await tool('browser_tabs', { sessionId })).content?.find((c) => c.type === 'text')?.text ?? '';
	return /"currentTabId"\s*:\s*"([^"]+)"/.exec(text)?.[1];
}

export const supportsKitty = () =>
	['ghostty', 'kitty'].includes((process.env.TERM_PROGRAM ?? '').toLowerCase()) || !!process.env.KITTY_WINDOW_ID;

// A terminal cell's size in pixels, asked of the terminal once (CSI 16 t). Undefined when the
// terminal doesn't answer; callers then assume the common 1:2 shape and cell-level mouse input.
export type CellSize = { width: number; height: number };
let cellSize: Promise<CellSize | undefined> | undefined;
export function measureCell(): Promise<CellSize | undefined> {
	cellSize ??= new Promise((resolve) => {
		const done = (size: CellSize | undefined) => {
			process.stdin.off('data', onData);
			clearTimeout(timer);
			resolve(size);
		};
		const onData = (data: Buffer) => {
			const m = /\x1b\[6;(\d+);(\d+)t/.exec(data.toString());
			if (m && Number(m[1]) > 0 && Number(m[2]) > 0) done({ height: Number(m[1]), width: Number(m[2]) });
		};
		const timer = setTimeout(() => done(undefined), 500);
		process.stdin.on('data', onData);
		process.stdout.write('\x1b[16t');
	});
	return cellSize;
}

/**
 * Cells for an image: as wide as allowed, capped by height. The grid must match the image's
 * shape exactly: Kitty keeps an image's aspect ratio inside its cells, so a mismatched grid
 * leaves margins and clicks mapped across the grid land off target.
 */
export function fit(frame: Frame, maxCols: number, maxRows: number, cellWidthToHeight = 0.5) {
	const rowsPerCol = (frame.height / frame.width) * cellWidthToHeight;
	let cols = maxCols;
	let rows = Math.round(cols * rowsPerCol);
	if (rows > maxRows) {
		rows = maxRows;
		cols = Math.round(rows / rowsPerCol);
	}
	return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

// --- Kitty graphics protocol, Unicode placeholder mode ---

// Row/column diacritics from Kitty's rowcolumn-diacritics table (first entries only:
// rows use one each; columns after the first are inferred by the terminal).
const DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f, 0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351,
	0x0352, 0x0357, 0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369, 0x036a, 0x036b, 0x036c, 0x036d,
	0x036e, 0x036f, 0x0483, 0x0484, 0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597, 0x0598, 0x0599,
	0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1, 0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4,
].map((c) => String.fromCodePoint(c));
export const MAX_KITTY_ROWS = DIACRITICS.length;

const PLACEHOLDER = String.fromCodePoint(0x10eeee);
const apc = (control: string, payload = '') => `\x1b_G${control}${payload ? `;${payload}` : ''}\x1b\\`;
let nextImageId = 0x2a0000; // high bits set, so the id can't collide with the default fg color

/** Uploads a frame and creates a virtual placement of cols x rows cells; returns its image id. */
export function kittyUpload(frame: Frame, cols: number, rows: number): number {
	const id = nextImageId++;
	// PNG goes as-is (f=100); raw pixels are zlib-compressed RGBA (f=32).
	const data = frame.png ?? deflateSync(frame.rgba!).toString('base64');
	const format = frame.png ? 'f=100' : `f=32,o=z,s=${frame.width},v=${frame.height}`;
	const chunks = data.match(/.{1,4096}/g) ?? [''];
	let out = '';
	chunks.forEach((chunk, i) => {
		const more = i < chunks.length - 1 ? 1 : 0;
		const control = i === 0 ? `a=t,${format},i=${id},q=2,m=${more}` : `m=${more},q=2`;
		out += apc(control, chunk);
	});
	out += apc(`a=p,U=1,i=${id},c=${cols},r=${rows},q=2`);
	process.stdout.write(out);
	return id;
}

export function kittyDelete(id: number) {
	process.stdout.write(apc(`a=d,d=I,i=${id},q=2`));
}

/** Text rows that display an uploaded image: placeholder cells colored with the image id. */
export function kittyRows(id: number, cols: number, rows: number): string[] {
	const color = `\x1b[38;2;${(id >> 16) & 255};${(id >> 8) & 255};${id & 255}m`;
	return Array.from(
		{ length: rows },
		(_, r) => `${color}${PLACEHOLDER}${DIACRITICS[r]}${DIACRITICS[0]}${PLACEHOLDER.repeat(cols - 1)}\x1b[39m`,
	);
}

// --- Half-block fallback ---

/** Text rows drawing the frame with '▀' (top pixel as foreground, bottom as background). */
export function halfBlockRows(frame: Frame, cols: number, rows: number): string[] {
	if (!frame.rgba) return [];
	const rgba = frame.rgba;
	const px = (x: number, y: number) => {
		const sx = Math.min(frame.width - 1, Math.floor((x / cols) * frame.width));
		const sy = Math.min(frame.height - 1, Math.floor((y / (rows * 2)) * frame.height));
		const i = (sy * frame.width + sx) * 4;
		return `${rgba[i]};${rgba[i + 1]};${rgba[i + 2]}`;
	};
	return Array.from({ length: rows }, (_, r) => {
		let line = '';
		for (let c = 0; c < cols; c++) line += `\x1b[38;2;${px(c, r * 2)}m\x1b[48;2;${px(c, r * 2 + 1)}m▀`;
		return `${line}\x1b[0m`;
	});
}
