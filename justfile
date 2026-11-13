test:
    npm ci
    node scripts/test-run.mjs test

test-e2e:
    node test/relay-e2e.mjs

shots:
    node scripts/test-run.mjs shots
