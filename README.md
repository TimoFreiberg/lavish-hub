# lavish-hub

lavish-hub is a personal workspace review tool built around [Lavish](https://github.com/kunchenguid/lavish-axi). A foreground hub brings jj commits, changes, tasks, PR drafts, and published Markdown or HTML together in one review.

## Install

Install a prebuilt release with Node.js 22 or newer and jj. macOS and Linux are supported. The package includes patched Lavish; a global `lavish-axi` is not required. With mise v2026.11.6 or newer:

```toml
[tools]
"npm:https://github.com/TimoFreiberg/lavish-hub/releases/latest/download/lavish-hub.tgz" = "latest"
```

Run `mise install` after editing your configuration. See [installation and releases](docs/releasing.md) for a pinned URL, updates, and the release process. Remove an old source-archive entry yourself. Checkout and source-archive runtime installations are not supported; existing state is not migrated.

## Use

Run `lavish-hub listen --open` in a long-running terminal or agent job in a jj workspace. The foreground owner prints feedback as JSON and a command for replying. Short `lavish-hub` commands connect to that owner; they do not start one. See the [hub guide](docs/hub.md), [command reference](docs/cli.md), and [workflow gaps](docs/hub-gaps.md).

See the [documentation index](docs/README.md) and [testing guide](TESTING.md).
