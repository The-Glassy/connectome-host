import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

await runHeadless({
  recipe: { name: 'Subscribe union child', agent: { name: 'commander' } },
  framework: {
    getAllAgents: () => [{ name: 'commander', state: { status: 'idle' } }],
    getAllModules: () => [],
    getHostModeStatus: () => ({ drained: true, activeTurnAgents: [], parkedAdmissions: 0, gatedRequests: 0, backgroundScripts: 0 }),
    getQueueDepth: () => 0,
    onTrace: () => () => {},
    async stop() {},
  },
} as unknown as AppContext);
