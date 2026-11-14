# One install, screenshots first, then isolated correctness suites.
check:
    node scripts/check.mjs all

test:
    node scripts/check.mjs test

test-e2e:
    node scripts/check.mjs e2e

shots:
    node scripts/check.mjs shots
