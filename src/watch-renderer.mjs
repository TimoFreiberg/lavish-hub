import { ensureDeps } from './deps.mjs';
import { watchTick } from './watch.mjs';

process.once('message', async ({ file, spec, state }) => {
  try {
    const result = await watchTick(file, spec, await ensureDeps(), state);
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    process.send({ error: error.message }, () => process.disconnect());
  }
});
