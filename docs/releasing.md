# Building and releasing

The distributed package is built from the root npm lockfile. The vendored Lavish
source retains its upstream pnpm metadata, but the package producer resolves its
build and runtime dependencies from the root npm installation. Keep the upstream
license, notices, and patch history described in [maintenance](maintenance.md).

For a development build, run `node scripts/package.mjs OUTPUT_DIRECTORY` with
Node 22 or later, npm, and jj installed. The producer uses a temporary staging
directory and writes `lavish-hub.tgz`, `SHA256SUMS`, and
`release-metadata.json`. Set `LAVISH_HUB_SOURCE_COMMIT` to the full source
commit when building from a Git checkout without jj. Test the archive with
`node test/package-smoke.mjs OUTPUT_DIRECTORY/lavish-hub.tgz`. The smoke test
requires jj. It checks the production dependency tree, rejects external links and
native binaries, and starts the extracted package with read-only files and an
empty home. It does not replace the full local checks or the Linux and macOS
smoke jobs.

## Release checklist

1. Run `just check` on the exact integrated source and inspect the screenshots at
   original size. Record both results before release.
2. Run `just release-check` to verify the release prerequisites:
   - `package.json` has an `X.Y.Z` version matching `package-lock.json`,
   - tag `v<version>` and GitHub release `v<version>` do not already exist,
   - `flake.nix` builds (`nix build --no-link` and `nix flake check`) and the
     built `lavish-hub` binary runs,
   - `scripts/package.mjs` and `test/package-smoke.mjs` pass on a local archive.
   Pass `--skip-availability` to verify `flake.nix` and packaging before bumping
   the version. If `nix build` reports an out-of-date `npmDepsHash` after
   updating dependencies or bumping the version, set `npmDepsHash = pkgs.lib.fakeHash;`,
   run `nix build --no-link` to get the expected `sha256-...` hash, update
   `flake.nix`, and rerun `just release-check`.
3. Push the tested source to main.
4. Manually dispatch the [release workflow](https://github.com/TimoFreiberg/lavish-hub/actions/workflows/release.yml)
   with the full integrated commit and version without `v`. CI builds one archive,
   tests those bytes on Linux and macOS, and publishes them only after both pass.
5. Check the published metadata and checksum against the CI artifact. Attempt
   installation from both the pinned and latest URLs using isolated mise state.
   Report failures and any partially created release rather than overwriting it.

CI builds its own archive. It does not prove byte equality with a local build,
and its smoke tests do not replace local visual inspection or real-hc checks.

## Installation with mise

With mise v2026.11.6 or newer, use an npm HTTPS URL in your mise configuration:

```toml
[tools]
"npm:https://github.com/TimoFreiberg/lavish-hub/releases/latest/download/lavish-hub.tgz" = "latest"
```

For a fixed release, replace the URL with
`https://github.com/TimoFreiberg/lavish-hub/releases/download/v0.1.0/lavish-hub.tgz`.
Run `mise install` after editing the configuration. `mise up` checks the URL's
content digest for updates. An actual update between two releases remains to be
verified. Remove an old source-archive entry yourself when switching. No global
Lavish installation is needed, and existing Lavish state is not migrated.
