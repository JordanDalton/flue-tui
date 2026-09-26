import { readFileSync, writeFileSync } from 'node:fs';

// How the sidebar is organized, saved to ./.flue-tui.json (safe to edit by hand):
//
//   {
//     "sections": [{ "name": "Pinned", "threads": ["assistant/tui-abc"] }],
//     "hidden": ["researcher"],           // agents left out of the sidebar
//     "collapsed": ["section:Pinned"],    // collapsed headers ("section:<name>" / "agent:<key>")
//     "lastOpen": "assistant/tui-abc",    // reopened on start (set automatically)
//     "archived": ["researcher/old-1"]    // hidden threads (/archive, or x in the sidebar)
//   }
//
// Sections group threads from any agent. A thread lives in at most one section, and
// is listed there instead of under its agent. "Pinned" always sorts first.

export const PINNED = 'Pinned';
/** The sidebar group for archived threads; reserved as a section name. */
export const ARCHIVED = 'Archived';
const PATH = './.flue-tui.json';

export interface Section {
	name: string;
	/** Thread keys: '<agent>/<thread id>'. */
	threads: string[];
}

export interface Layout {
	sections: Section[];
	hidden: string[];
	collapsed: string[];
	/** The thread open when the TUI last ran ('<agent>/<thread id>'), reopened on start. */
	lastOpen?: string;
	/** Threads hidden from the sidebar ('<agent>/<id>'), listed under a folded "Archived" group. */
	archived?: string[];
}

export const threadKey = (agent: string, id: string) => `${agent}/${id}`;

export function loadLayout(): Layout {
	try {
		const raw = JSON.parse(readFileSync(PATH, 'utf8')) as Partial<Layout>;
		return {
			sections: raw.sections ?? [],
			hidden: raw.hidden ?? [],
			collapsed: raw.collapsed ?? [],
			...(raw.lastOpen && { lastOpen: raw.lastOpen }),
			...(raw.archived?.length && { archived: raw.archived }),
		};
	} catch {
		return { sections: [], hidden: [], collapsed: [] };
	}
}

export function saveLayout(layout: Layout) {
	try {
		writeFileSync(PATH, `${JSON.stringify(layout, null, '\t')}\n`);
	} catch {
		// Read-only directory: the layout still applies for this session.
	}
}

/** Section order for display: Pinned first, then as created. */
export const orderedSections = (layout: Layout) => [
	...layout.sections.filter((s) => s.name === PINNED),
	...layout.sections.filter((s) => s.name !== PINNED),
];

export const sectionOf = (layout: Layout, key: string) => layout.sections.find((s) => s.threads.includes(key));

// Pure updates; each returns a new layout, or an error message.

export function addSection(layout: Layout, name: string): Layout | string {
	if (!name) return 'usage: /section add <name>';
	if (name.toLowerCase() === ARCHIVED.toLowerCase()) return `"${ARCHIVED}" is reserved for archived threads`;
	if (layout.sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) return `section "${name}" exists`;
	return { ...layout, sections: [...layout.sections, { name, threads: [] }] };
}

export function removeSection(layout: Layout, name: string): Layout | string {
	const section = findSection(layout, name);
	if (!section) return `no section "${name}"`;
	return {
		...layout,
		sections: layout.sections.filter((s) => s !== section),
		collapsed: layout.collapsed.filter((c) => c !== `section:${section.name}`),
	};
}

export function renameSection(layout: Layout, from: string, to: string): Layout | string {
	const section = findSection(layout, from);
	if (!section || !to) return 'usage: /section rename <name> <new name>';
	if (findSection(layout, to)) return `section "${to}" exists`;
	return {
		...layout,
		sections: layout.sections.map((s) => (s === section ? { ...s, name: to } : s)),
		collapsed: layout.collapsed.map((c) => (c === `section:${section.name}` ? `section:${to}` : c)),
	};
}

/** Moves a thread into a section (created if needed), or out of all sections for null. */
export function moveThread(layout: Layout, key: string, to: string | null): Layout {
	const sections = layout.sections.map((s) => ({ ...s, threads: s.threads.filter((t) => t !== key) }));
	if (to === null) return { ...layout, sections };
	const existing = sections.find((s) => s.name.toLowerCase() === to.toLowerCase());
	if (existing) existing.threads.unshift(key);
	else sections.push({ name: to, threads: [key] });
	return { ...layout, sections };
}

/**
 * Archives a thread (hides it from its agent and section) or brings it back. Flue keeps every
 * conversation, so this only changes the sidebar; the thread's history is untouched.
 */
export function toggleArchived(layout: Layout, key: string): Layout {
	const archived = layout.archived ?? [];
	if (archived.includes(key)) return { ...layout, archived: archived.filter((k) => k !== key) };
	// The group starts folded, so archiving doesn't just move the clutter to the bottom.
	const collapsed =
		archived.length === 0 && !layout.collapsed.includes(`section:${ARCHIVED}`)
			? [...layout.collapsed, `section:${ARCHIVED}`]
			: layout.collapsed;
	return { ...layout, archived: [key, ...archived], collapsed };
}

export function togglePin(layout: Layout, key: string): Layout {
	return sectionOf(layout, key)?.name === PINNED ? moveThread(layout, key, null) : moveThread(layout, key, PINNED);
}

export function setHidden(layout: Layout, agent: string, hidden: boolean): Layout {
	const rest = layout.hidden.filter((a) => a !== agent);
	return { ...layout, hidden: hidden ? [...rest, agent] : rest };
}

export function toggleCollapsed(layout: Layout, id: string, collapsed?: boolean): Layout {
	const is = layout.collapsed.includes(id);
	const want = collapsed ?? !is;
	if (want === is) return layout;
	return { ...layout, collapsed: want ? [...layout.collapsed, id] : layout.collapsed.filter((c) => c !== id) };
}

function findSection(layout: Layout, name: string) {
	return layout.sections.find((s) => s.name.toLowerCase() === name.toLowerCase());
}
