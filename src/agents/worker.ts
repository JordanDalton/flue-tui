'use agent';
import { type AgentProps, useMcpConnection, useModel, useTool } from '@flue/runtime';
import { mcpConnection } from '../mcp.ts';
import { AGENT_MESSAGING_INSTRUCTIONS, useAgentMessaging } from '../tools/agent-messaging.ts';
import { BROWSER_INSTRUCTIONS } from '../tools/browser.ts';
import { webSearch } from '../tools/web-search.ts';
import { getWorker } from '../workers.ts';

// A worker the Chief of Staff spawned for a role. Its role, instructions and capabilities
// come from the workers store (src/workers.ts), keyed by this conversation's id.
export function Worker({ id }: AgentProps) {
	useModel('anthropic/claude-haiku-4-5');
	const worker = getWorker(id);
	const caps = worker?.status === 'active' ? worker.capabilities : [];
	if (caps.includes('search')) useTool(webSearch);
	const browser = caps.includes('browser') ? mcpConnection('tabfleet') : undefined;
	if (browser) useMcpConnection(browser);
	useAgentMessaging('worker', id);

	if (!worker) return 'You are an unassigned worker. Reply that you have no assignment and cannot take work.';
	if (worker.status === 'retired') {
		return `You were the ${worker.role} worker and have been retired. If you receive work, reply briefly that you're retired.`;
	}
	return [
		`You are a worker on the user's team. Your role: ${worker.role}.

${worker.instructions}

The Chief of Staff assigned you this work. Send results back to it with \`message_agent\`
(to: "chief"); the reply thread is filled in for you. Reports should be concise: the result
first, then anything the chief should know. If a task is unclear, ask the chief rather than guessing.`,
		browser ? BROWSER_INSTRUCTIONS : '',
		AGENT_MESSAGING_INSTRUCTIONS,
	]
		.filter(Boolean)
		.join('\n\n');
}
