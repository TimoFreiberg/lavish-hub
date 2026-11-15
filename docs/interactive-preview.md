# Interactive fixture preview

Run `just preview` to build the ignored `preview/` directory, or `just preview /path/to/empty-directory` to choose an empty output directory. If a generated preview is found, the command preserves the entire directory, including any personal files, in a uniquely named sibling directory (for example, `preview-previous-*/preview` for the default output) and prints its location. Review and remove that backup yourself when no longer needed. Unrecognized nonempty directories are refused. Serve the output over HTTP with any static server, for example:

```sh
just preview
cd preview
python3 -m http.server 8000
```

Open the server's index in a browser. The output also works under a nested URL prefix; opening it via `file://` is not supported. The index links the fixture variants and displays the source revision, dirty state and build time, also recorded in `manifest.json`. `SOURCE_DATE_EPOCH` overrides the timestamp. Local output identifies the local jj working-copy revision or Git HEAD and whether it has changes; it does not necessarily identify the published revision.

The pages use the application UI with an explicit preview adapter. Saves, external edits, comments and configured Create PR actions are simulations: they do not save files or run actions. State is held in memory per page and is discarded on reload or navigation. Reset restores the fixture; the theme selector changes appearance. An unconfigured Create PR remains disabled. Fixtures are trusted project content, not an arbitrary HTML hosting service.

`just shots` builds the same preview under `shots/preview/`, alongside a gallery and report. Eight wide, dark primary images represent both static and real-Lavish pages; selected scrollable pages can have additional captures. The complete static and real-Lavish matrices run checks at both widths and themes without a primary PNG for every case. See [testing](../TESTING.md) for readiness, checks and manual review.

## Public preview and operations

The `Preview Pages` workflow builds on pushes to `main` and publishes one latest preview. The site and its fixture data are public: review fixture content before adding it. The default project URL is `https://<owner>.github.io/<repository>/`; the repository's Settings → Pages also shows the actual URL. Configure the Pages publishing source as **GitHub Actions** in Settings → Pages ([GitHub instructions](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)). Repository settings and Pages availability may require administrator access. The build needs Node and jj; it uploads generated output, not credentials.

The public index and its `manifest.json` report the built revision and timestamp. Compare the revision to the current `main` commit and to the commit shown on the workflow run in the repository's Actions → Preview Pages page. Check that run and its deployment job for failures; a failed build or deployment may leave the previous site live. The workflow cancels older runs and checks current `main` immediately before deployment, but the check and publication are not atomic and GitHub does not guarantee ordering. Intermediate commits can be skipped, and a race can rarely leave an older site live.

If the published revision is stale, open the `Preview Pages` run for the **current main commit** in Actions and select **Re-run jobs** → **Re-run all jobs**, or push a fix to main. Rerunning an older commit will be skipped by the stale check. Recheck the run and published manifest afterward; a rerun is also subject to the same best-effort ordering. See [workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

To stop future publication, disable the `Preview Pages` workflow in Actions or remove the workflow from `main`. To remove the existing public site, disable GitHub Pages in Settings → Pages; disabling the workflow alone does not remove a previously deployed site. See [unpublishing a Pages site](https://docs.github.com/en/pages/getting-started-with-github-pages/unpublishing-a-github-pages-site). Do not commit generated artifacts or credentials.
