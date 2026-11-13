import { ensureDeps } from './deps.mjs';
import { watchTick } from './watch.mjs';

process.once('message', async ({ file, spec, state, data, fingerprint }) => {
  try {
    const result = await watchTick(file, spec, await ensureDeps(), state, { data, fingerprint });
    process.send({ result }, () => process.disconnect());
  } catch (error) {
    process.send({ error: error.message }, () => process.disconnect());
  }
});
