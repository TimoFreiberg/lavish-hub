# Interactive fixture preview

Run `just preview` to build the ignored `preview/` directory, or `just preview /path/to/empty-directory` to choose an empty output directory. Serve it over HTTP with any static server, for example:

```sh
just preview
cd preview
python3 -m http.server 8000
```

Open the server's index in a browser. The output also works under a nested URL prefix; opening it via `file://` is not supported. The index links the fixture variants and displays the source revision and build time, also recorded in `manifest.json`. `SOURCE_DATE_EPOCH` overrides the timestamp. Development output identifies the actual revision, not a published main revision.

The pages use the application UI with an explicit preview adapter. Saves, external edits, comments and configured Create PR actions are simulations: they do not save files or run actions. State is held in memory per page and is discarded on reload or navigation. Reset restores the fixture; the theme selector changes appearance. An unconfigured Create PR remains disabled. Fixtures are trusted project content, not an arbitrary HTML hosting service.

`just shots` builds the same preview under `shots/preview/`, alongside a gallery and report. Eight wide, dark primary images represent both static and real-Lavish pages; selected scrollable pages can have additional captures. The complete static and real-Lavish matrices run checks at both widths and themes without a primary PNG for every case. See [testing](../TESTING.md) for readiness, checks and manual review.

No command deploys or publishes the preview. GitHub Pages is a possible future static host; project sites use a repository URL prefix. Publication requires a separate decision and authorization. If commit-specific version directories are published later, decide an explicit retention policy first; deployment history alone does not provide immutable per-commit URLs. Do not commit generated artifacts or add credentials for this local preview.
