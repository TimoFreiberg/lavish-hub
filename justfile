# Generate a local, read-only fixture preview in an empty directory.
preview out="preview":
    npm ci
    node scripts/preview.mjs "{{out}}"

# Run the real hub against generated demo data, isolated from your normal hub.
demo *args:
    node scripts/demo.mjs {{args}}

demo-stop *args:
    node scripts/demo.mjs --stop {{args}}

# One install, screenshots first, then isolated correctness suites.
check:
    node scripts/check.mjs all

test:
    node scripts/check.mjs test

test-e2e:
    node scripts/check.mjs e2e

shots:
    node scripts/check.mjs shots

# Verify release prerequisites: version, tag/release availability, Nix flake, and package smoke.
release-check *args:
    node scripts/release-check.mjs {{args}}
