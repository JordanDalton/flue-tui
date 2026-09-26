import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { agents } from './agents/registry.ts';
import { tuiIndex } from './tui-index.ts';

// 1. Create your Hono application instance.
const app = new Hono();
// 2. Define your agent routes. Add agents in ./agents/registry.ts.
for (const [mount, agent] of Object.entries(agents)) {
	app.route(`/agents/${mount}`, createAgentRouter(agent));
}
// Agent + conversation index for the TUI sidebar (see tui-index.ts for access rules).
app.route('/_tui/agents', tuiIndex('./data/flue.db', agents));
// 3. Export your application.
export default app;
