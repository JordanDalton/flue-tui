import Anthropic from '@anthropic-ai/sdk';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

// Web research for agents, backed by Claude's server-side web_search and web_fetch
// tools: one Messages API call searches and/or reads pages, and returns a cited summary. Uses the
// ANTHROPIC_API_KEY the agents already run on — no separate search provider.

const client = new Anthropic();

// A search can pause mid-turn (pause_turn); resume at most this many times.
const MAX_CONTINUATIONS = 3;

export const webSearch = defineTool({
	name: 'search_web',
	description:
		'Search the web or read a specific page, and get back a short cited summary with source URLs. ' +
		'Use for anything recent, factual, or that you are unsure about. To look at a specific site, ' +
		'include its full URL in the query (e.g. "What does https://example.com offer?"). One focused question per call.',
	input: v.object({
		query: v.pipe(v.string(), v.minLength(3)),
	}),
	timeoutMs: 180_000,
	async run({ data, signal, log }) {
		log.info('searching', { query: data.query });
		const messages: Anthropic.Beta.BetaMessageParam[] = [
			{
				role: 'user',
				content:
					`Research this and answer in under 200 words, key facts first:\n\n${data.query}\n\n` +
					'If it names a URL or domain, fetch that page and read it directly (add https:// if missing) ' +
					'before searching elsewhere. Only state what the sources support.',
			},
		];

		let response: Anthropic.Beta.BetaMessage | undefined;
		for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
			response = await client.beta.messages.create(
				{
					model: 'claude-opus-5',
					max_tokens: 16000,
					betas: ['server-side-fallback-2026-07-01'],
					fallbacks: 'default',
					tools: [
						{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 },
						{ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
					],
					messages,
				},
				{ signal },
			);
			if (response.stop_reason !== 'pause_turn') break;
			messages.push({ role: 'assistant', content: response.content });
		}

		if (!response) throw new Error('web search returned no response');
		if (response.stop_reason === 'refusal') throw new Error('web search request was declined');

		const text = response.content
			.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
			.map((b) => b.text)
			.join('')
			.trim();

		// Fetched pages and cited sources first, then any other results the search surfaced.
		const sources = new Map<string, string>();
		for (const block of response.content) {
			if (block.type === 'web_fetch_tool_result' && block.content.type === 'web_fetch_result') {
				sources.set(block.content.url, block.content.content.title ?? block.content.url);
			}
		}
		for (const block of response.content) {
			if (block.type === 'text') {
				for (const c of block.citations ?? []) {
					if (c.type === 'web_search_result_location') sources.set(c.url, c.title ?? c.url);
				}
			}
		}
		for (const block of response.content) {
			if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
				for (const r of block.content) if (!sources.has(r.url)) sources.set(r.url, r.title);
			}
		}

		const list = [...sources].slice(0, 8).map(([url, title]) => `- ${title}: ${url}`);
		return `${text || '(no answer)'}\n\nSources:\n${list.join('\n') || '- none'}`;
	},
});
