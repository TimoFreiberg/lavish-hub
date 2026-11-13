test:
    npm ci
    node --test --test-concurrency=1 test/

test-e2e:
    node test/relay-e2e.mjs

shots:
    env -u HC_TERMINAL_ID node scripts/shots.mjs
