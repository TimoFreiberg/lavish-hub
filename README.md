# lavish-kit

lavish-kit contains features I want around
[Lavish](https://github.com/kunchenguid/lavish-axi), plus herdr integration.

## Install

You need Node.js 22 or newer (Lavish requires it), npm, and `lavish-axi` on
`PATH` (tested with 0.1.96). Diff pages need jj or git, and PR drafts need jj.
Inside herdr, feedback routing needs herdr's `hc` on `PATH`, and the Artifacts
listing and Create PR use `herdr-app`. macOS and Linux are supported.

There are no releases; install `main`. With mise:

```toml
[tools]
"npm:lavish-axi" = "0.1.96"
"http:lavish-kit" = { version = "main", url = "https://github.com/TimoFreiberg/lavish-kit/archive/refs/heads/{{ version }}.tar.gz", strip_components = 1, bin_path = "bin" }
```

`mise install` fetches `main` once; `mise install -f http:lavish-kit` fetches
it again (`mise up` doesn't, since `main` isn't a version number).

Or run it from a checkout and update with `git pull`. The entry point works
through a symlink:

```sh
git clone https://github.com/TimoFreiberg/lavish-kit "$HOME/src/lavish-kit"
mkdir -p "$HOME/.local/bin"
ln -s "$HOME/src/lavish-kit/bin/lavish-kit" "$HOME/.local/bin/lavish-kit"
```

The first run installs the pinned npm dependencies and builds the browser
bundles, so it needs network access. After an update, they're rebuilt on the
next run. A background process that's already running keeps the old code until
its last open page stops.

## Features

### Workspace hub

Run `lavish-kit hub listen --open` in a long-running terminal or agent job for
one jj workspace. The hub combines commits, changes, tasks, a PR draft, and
published Markdown or HTML in one review. Short `lavish-kit hub` commands connect
to that owner; they do not start a daemon. The owner prints feedback for the
agent and stops when its command exits. See [the hub guide](docs/hub.md) for
publication, action connectivity, and lifecycle details.

### HTML pages

`lavish-kit page.html` opens an HTML file in Lavish where it is, with Lavish's
own live reload and annotations. Use it instead of `lavish-axi page.html` when
you want herdr feedback routing and the herdr Artifacts listing.

### Markdown

`lavish-kit notes.md` renders a Markdown file as a read-only page with syntax
highlighting and a table of its frontmatter. The page re-renders when the file
changes.

### Task documents

`lavish-kit task notes.md` opens an existing Markdown file in an editor with
Edit and Rendered tabs. Save writes the file only if it hasn't changed on disk
since editing started. Save goes through Lavish's send, so it also sends any
comments you have queued on the page.

### Diffs

`lavish-kit diff` shows a jj or git diff (by default, the current branch
against trunk) and lets you comment on a line or a range of lines. When the
diff changes, the page offers a Refresh button.

### PR drafts

`lavish-kit pr draft.md` edits a PR title and body kept in a file, next to the
commits the PR covers. Create PR saves the draft and starts your own PR command
in a new herdr tab.

### Feedback routing in herdr

Inside herdr, a background listener routes Lavish feedback back to the herdr
terminal of the agent that opened the page, so the agent doesn't poll. Outside
herdr it works like plain Lavish: the agent runs `lavish-axi poll` itself. Each
command prints which of the two applies.

Commands, options, and details for each feature: [docs/README.md](docs/README.md).
