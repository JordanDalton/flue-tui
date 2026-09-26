import { dispatch, useAgentFinish, useDelivery, useTool } from '@flue/runtime';
import * as v from 'valibot';
// Circular (the registry imports the agents, which import this module), which is safe
// because `agents` is only read inside renders and tool runs, never at module load.
import { agents } from '../agents/registry.ts';
import { getWorker } from '../workers.ts';

// Agent-to-agent messaging over durable dispatch.
//
// A message lands in the target agent's thread as an `agent.message` signal carrying
// who sent it and which thread to answer in. Delivery is asynchronous: the sender's
// turn continues immediately, and the reply arrives later as a new message in the
// sender's own thread.

export const AGENT_MESSAGE = 'agent.message';
// Sent back into an agent's own response when it finished a request without replying.
const REPLY_REMINDER = 'agent.reply-reminder';

// Every message carries a hop count, incremented on each forward/reply. Past this,
// sends are refused so two agents can't keep a conversation going forever.
export const MAX_HOPS = 4;

export const AGENT_MESSAGING_INSTRUCTIONS = `
## Talking to other agents
You can message other agents with the \`message_agent\` tool. Messages are asynchronous:
the tool returns as soon as the message is delivered, and the other agent's answer arrives
later as a new \`<agent_message>\` in this conversation.
- When you receive an \`<agent_message>\`, answer the sender by calling \`message_agent\` with
  \`to\` set to its \`from\` attribute. The reply thread is filled in for you.
- Only reply when you have something useful to add. Do not send acknowledgements or thanks.
- Sending ends your turn once the message is delivered, so say what you're doing first, and
  send all messages for a step together. Never write an <agent_message> yourself: they only
  come from other agents.
`.trim();

/**
 * The signal message_agent delivers; also used by tools that start conversations themselves.
 * `intent` says whether the recipient owes an answer ('request') or not ('reply').
 */
export function agentMessage(
	from: string,
	fromThread: string,
	body: string,
	hops: number,
	intent: 'request' | 'reply' = 'request',
) {
	return {
		kind: 'signal' as const,
		type: AGENT_MESSAGE,
		tagName: 'agent_message',
		body,
		attributes: { from, fromThread, hops: String(hops), intent },
	};
}

/** The hop count of the message in front of the model (0 when it isn't from an agent). */
export function useIncomingHops(): number {
	const delivery = useDelivery();
	return delivery.kind === 'signal' && delivery.type === AGENT_MESSAGE ? Number(delivery.attributes?.hops ?? 0) : 0;
}

/**
 * Mounts the `message_agent` tool for an agent instance.
 * @param self   this agent's mount name in the registry (e.g. 'assistant')
 * @param thread this instance's id (the agent's `props.id`)
 * @param peers  agents it may message; defaults to every other agent in the registry except
 *               'worker' (workers are reached through the chief, by thread id)
 */
export function useAgentMessaging(self: string, thread: string, peers?: readonly string[]) {
	peers ??= Object.keys(agents).filter((name) => name !== self && name !== 'worker');
	if (peers.length === 0) return; // nobody to talk to
	const delivery = useDelivery();
	// The agent message being answered. A reply reminder carries the same attributes, so a
	// reply sent after one still goes back to the original sender's thread.
	const incoming =
		delivery.kind === 'signal' && (delivery.type === AGENT_MESSAGE || delivery.type === REPLY_REMINDER)
			? (delivery.attributes ?? {})
			: undefined;
	const hops = incoming ? Number(incoming.hops ?? 0) : 0;

	// Models often finish a long task with a plain answer and forget to send it back, leaving
	// the requester waiting forever. If a request from another agent ends without any
	// message_agent call, send the model back once to deliver its result.
	useAgentFinish(({ response, append }) => {
		if (
			!incoming?.from ||
			incoming.intent === 'reply' ||
			(delivery.kind === 'signal' && delivery.type === REPLY_REMINDER)
		)
			return;
		if (response.toolCalls.some((c) => c.tool === 'message_agent' && !c.isError)) return;
		append({
			kind: 'signal',
			type: REPLY_REMINDER,
			tagName: 'reply_reminder',
			body:
				`${incoming.from} asked you for this and is still waiting: you haven't sent your result back. ` +
				`Call message_agent now with to: "${incoming.from}" and your complete result as the body. ` +
				`Don't redo the work.`,
			attributes: incoming,
		});
	});

	useTool({
		name: 'message_agent',
		description:
			`Send a message to another agent (${peers.join(', ')}). Asynchronous: returns once delivered; ` +
			`the reply arrives later as an <agent_message> in this conversation. ` +
			`Omit \`thread\` unless you need a specific one` +
			(peers.includes('worker') ? '; to reach a worker, set `to: "worker"` and `thread` to its id.' : '.'),
		input: v.object({
			to: v.picklist(peers as [string, ...string[]]),
			body: v.pipe(v.string(), v.minLength(1)),
			thread: v.optional(v.string()),
		}),
		durable: true,
		async run({ data, step }) {
			if (hops >= MAX_HOPS) {
				return `Not sent: this exchange has reached the ${MAX_HOPS}-message limit. Summarize what you have for the user instead.`;
			}
			// Replying to the agent that messaged us goes back to its thread by default;
			// a fresh conversation gets one target thread per originating thread.
			const isReply = !!incoming && data.to === incoming.from;
			const target =
				data.thread ??
				(incoming && data.to === incoming.from && incoming.fromThread ? incoming.fromThread : `${self}--${thread}`);
			if (data.to === self && target === thread) return 'Not sent: that is this conversation.';
			// Workers only exist once spawned, and stop taking work when retired.
			if (data.to === 'worker') {
				const worker = data.thread ? getWorker(data.thread) : undefined;
				if (!worker) return 'Not sent: give `thread` as the id of a spawned worker (see list_team).';
				if (worker.status !== 'active') return `Not sent: worker ${worker.id} (${worker.role}) is retired.`;
			}

			const agent = agents[data.to as keyof typeof agents];

			// A durable step, so a recovered tool call doesn't deliver the message twice.
			const receipt = await step.do('dispatch', () =>
				dispatch(agent, {
					id: target,
					// Answering whoever messaged us is a reply; anything else asks for an answer.
					message: agentMessage(self, thread, data.body, hops + 1, isReply ? 'reply' : 'request'),
				}),
			);
			// End this agent's turn: the reply arrives later as its own message, and a model that
			// keeps going tends to invent one (writing a fake <agent_message> into its answer).
			return {
				output: `Delivered to ${data.to} (thread ${target}, submission ${receipt.submissionId}). Their reply will arrive as a new message.`,
				terminate: true,
			};
		},
	});
}
