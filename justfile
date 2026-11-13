test:
    npm ci
    node --test test/

test-e2e:
    node test/relay-e2e.mjs
