import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Runs the Flue dev server for the TUI when nothing is listening yet, so one terminal is
// enough. Output goes to a log file (it would corrupt the TUI's screen); an already-running
// `npm run dev` is used as-is and left alone.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const DEV_LOG = fileURLToPath(new URL('../node_modules/.cache/flue-tui/dev.log', import.meta.url));

let child: ChildProcess | undefined;

async function reachable(baseUrl: string): Promise<boolean> {
	try {
		await fetch(baseUrl, { signal: AbortSignal.timeout(1000) });
		return true; // any HTTP answer means a server is there
	} catch {
		return false;
	}
}

/**
 * Starts `vite dev` on the URL's port unless a server already answers there. Resolves once
 * it's reachable; returns whether this process started it.
 */
export async function ensureDevServer(baseUrl: string, onStatus: (line: string) => void): Promise<boolean> {
	if (await reachable(baseUrl)) return false;
	const port = new URL(baseUrl).port || '5173';

	mkdirSync(fileURLToPath(new URL('../node_modules/.cache/flue-tui/', import.meta.url)), { recursive: true });
	const log = openSync(DEV_LOG, 'w');
	onStatus(`Starting the dev server on :${port} (logs: ${DEV_LOG})…`);
	child = spawn(
		fileURLToPath(new URL('../node_modules/.bin/vite', import.meta.url)),
		['dev', '--port', port, '--strictPort'],
		{
			cwd: ROOT,
			stdio: ['ignore', log, log],
		},
	);
	closeSync(log);
	const exited = new Promise<never>((_, reject) =>
		child!.once('exit', (code) => reject(new Error(`dev server exited (code ${code}) — see ${DEV_LOG}`))),
	);

	// Stop it with the TUI, however the TUI ends.
	process.once('exit', stopDevServer);
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
		process.once(signal, () => {
			stopDevServer();
			process.exit(130);
		});
	}

	const ready = (async () => {
		for (let i = 0; i < 120; i++) {
			if (await reachable(baseUrl)) return;
			await new Promise((r) => setTimeout(r, 250));
		}
		throw new Error(`dev server didn't answer within 30s — see ${DEV_LOG}`);
	})();
	await Promise.race([ready, exited]);
	return true;
}

export function stopDevServer() {
	if (child && child.exitCode === null) child.kill('SIGTERM');
	child = undefined;
}

/** The last lines of the dev server log, when this TUI started the server. */
export function devLogTail(lines = 20): string | undefined {
	try {
		return readFileSync(DEV_LOG, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return undefined;
	}
}
