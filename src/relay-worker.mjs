import { relayDaemon, relayMain } from './relay.mjs';
if (process.argv[2] === '--daemon') await relayDaemon();
else await relayMain(process.argv[2]);
