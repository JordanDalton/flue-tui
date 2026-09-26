import { ChiefOfStaff } from './chief.ts';
import { Worker } from './worker.ts';

// Mount name → agent. Drives the HTTP mounts in app.ts, the TUI sidebar,
// and which agents `message_agent` can reach. The chief comes first: it's the default.
// `worker` is the generic agent behind the chief's spawned workers (src/workers.ts).
export const agents = {
	chief: ChiefOfStaff,
	worker: Worker,
};

export const agentNames = Object.keys(agents);
