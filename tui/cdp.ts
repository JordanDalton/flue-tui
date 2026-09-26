// Manual control of a Tabfleet browser over the Chrome DevTools Protocol.
//
// Tabfleet hands out a CDP WebSocket per session (POST /v1/sessions/:id/connection). While
// it's attached, Tabfleet refuses the agent's MCP browser actions ("controller_connected"),
// so the TUI only attaches while the user is actively driving and closes it to hand back.

const API = 'https://api.tabfleet.com';

export interface ScreencastFrame {
	/** Base64 image data in the requested format. */
	data: string;
	/** Page size in CSS pixels, for mapping clicks. */
	width: number;
	height: number;
}

// Special keys the TUI forwards, with the fields Chrome needs to act on them.
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
	enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
	backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
	tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
	up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
	down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
	left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
	right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
	pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
	pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
	home: { key: 'Home', code: 'Home', keyCode: 36 },
	end: { key: 'End', code: 'End', keyCode: 35 },
};
export type SpecialKey = keyof typeof KEYS;

export class BrowserControl {
	private id = 0;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private closed = false;

	private constructor(
		private ws: WebSocket,
		private target: string,
		/** Called when the connection drops (session ended, token revoked, closed). */
		public onClose?: (reason: string) => void,
	) {}

	/** Attaches to a session's tab (the current one when tabId is omitted). */
	static async attach(sessionId: string, apiKey: string, tabId?: string): Promise<BrowserControl> {
		const res = await fetch(`${API}/v1/sessions/${sessionId}/connection`, {
			method: 'POST',
			headers: { authorization: `Bearer ${apiKey}` },
		});
		const body = (await res.json()) as { cdpUrl?: string; error?: { message?: string } };
		if (!res.ok || !body.cdpUrl) throw new Error(body.error?.message ?? `connection failed (${res.status})`);

		const ws = new WebSocket(body.cdpUrl);
		await new Promise<void>((resolve, reject) => {
			ws.onopen = () => resolve();
			ws.onerror = () => reject(new Error('could not open the browser connection'));
		});
		const control = new BrowserControl(ws, '');
		ws.onmessage = (e) => control.receive(JSON.parse(String(e.data)));
		ws.onclose = () => control.finish('browser connection closed');

		const { targetInfos } = await control.call('Target.getTargets');
		const pages = (targetInfos as { targetId: string; type: string }[]).filter((t) => t.type === 'page');
		const page = pages.find((t) => t.targetId === tabId) ?? pages.at(-1);
		if (!page) throw new Error('no open tab in this browser');
		const { sessionId: target } = await control.call('Target.attachToTarget', {
			targetId: page.targetId,
			flatten: true,
		});
		control.target = target;
		await control.call('Page.enable', {}, target);
		return control;
	}

	private receive(message: {
		id?: number;
		result?: any;
		error?: { message: string };
		method?: string;
		params?: any;
		sessionId?: string;
	}) {
		if (message.id !== undefined) {
			const p = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (message.error) p?.reject(new Error(message.error.message));
			else p?.resolve(message.result);
			return;
		}
		if (message.method === 'Page.screencastFrame' && this.onFrame) {
			const { data, metadata, sessionId } = message.params;
			this.call('Page.screencastFrameAck', { sessionId }, this.target).catch(() => {});
			this.onFrame({ data, width: metadata.deviceWidth, height: metadata.deviceHeight });
		}
	}

	private call(method: string, params: object = {}, sessionId?: string): Promise<any> {
		if (this.closed) return Promise.reject(new Error('browser control has ended'));
		const id = ++this.id;
		this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
		return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
	}

	private onFrame?: (frame: ScreencastFrame) => void;

	/** Streams frames as the page changes. PNG for Kitty graphics (sent as-is), JPEG otherwise. */
	screencast(format: 'png' | 'jpeg', maxWidth: number, onFrame: (frame: ScreencastFrame) => void) {
		this.onFrame = onFrame;
		return this.call('Page.startScreencast', { format, quality: 70, maxWidth, maxHeight: maxWidth }, this.target);
	}

	async click(x: number, y: number) {
		const base = { x, y, button: 'left', clickCount: 1 };
		await this.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, this.target);
		await this.call('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, this.target);
		await this.call('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, this.target);
	}

	wheel(x: number, y: number, deltaY: number) {
		return this.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }, this.target);
	}

	type(text: string) {
		return this.call('Input.insertText', { text }, this.target);
	}

	async key(name: SpecialKey) {
		const k = KEYS[name];
		const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
		await this.call(
			'Input.dispatchKeyEvent',
			{ ...base, type: k.text ? 'keyDown' : 'rawKeyDown', text: k.text },
			this.target,
		);
		await this.call('Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, this.target);
	}

	/** Detaches, handing the browser back to the agent. */
	release() {
		this.finish('released');
		try {
			this.ws.close();
		} catch {
			// already closed
		}
	}

	private finish(reason: string) {
		if (this.closed) return;
		this.closed = true;
		for (const p of this.pending.values()) p.reject(new Error(reason));
		this.pending.clear();
		this.onClose?.(reason);
	}
}
