import { mcpServersFor } from '../mcp.ts';

// Guidance for agents with the Tabfleet cloud browser (mcp.json). Added to an agent's
// instructions only while Tabfleet is configured for it.

export const BROWSER_INSTRUCTIONS = `
## Cloud browser (Tabfleet)
You have a real cloud browser through the \`mcp__tabfleet__*\` tools. If you also have \`search_web\`,
prefer it for simple lookups; use the browser when a page needs interaction (logins, forms,
clicking through, JavaScript-heavy pages) or when asked to operate a site. Read pages with
\`browser_snapshot\`; you cannot see screenshots, so don't rely on \`browser_screenshot\`.

Sessions expire: each lasts the \`durationSeconds\` it was launched with (default 300). A session
from earlier in the conversation may be gone, so if a tool reports it closed or expired, launch a
new browser and reopen the page rather than reporting the old one. Never re-send an old live view
link; they stop working when the session ends.

When the user wants to see or watch a page, open it in a live session (launch with
\`durationSeconds: 900\`) and tell them to run \`/view\` in their terminal: it shows the browser
in place, and they can click the page to take control and Esc to hand it back. Leave that
session open while they're looking. Otherwise call \`close_browser\` when the task is done, even
after an error: sessions are billed by the minute.`.trim();

/** Browser instructions for this agent (registry mount name), or '' without Tabfleet. */
export function browserInstructions(agent: string): string {
	return mcpServersFor(agent).includes('tabfleet') ? BROWSER_INSTRUCTIONS : '';
}
