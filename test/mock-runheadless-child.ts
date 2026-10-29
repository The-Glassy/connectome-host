import { runHeadless } from '../src/headless.ts';
import type { AppContext } from '../src/index.ts';

await runHeadless({
  recipe: { name: 'Subscribe union child', agent: { name: 'commander' } },
  framework: {
    getAllAgents: () => [{ name: 'commander', state: { status: 'idle' } }],
    onTrace: () => () => {},
    async stop() {},
  },
} as unknown as AppContext);
