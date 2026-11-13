# Markdown pages

This covers `lavish-kit FILE.md`, which renders a Markdown file as a read-only
Lavish page. To edit a file in the browser, use a
[task document](task-documents.md) instead.

```sh
lavish-kit notes.md
lavish-kit notes.md --title "Design review"
```

## Rendering

The page is rendered with markdown-it: links (bare URLs too), tables, task
lists, raw HTML, heading anchors, and Shiki syntax highlighting with light and
dark themes. YAML frontmatter is shown as a table at the top of the page (or as
raw text if it isn't a mapping).

The title is the frontmatter `title`, else the first H1, else the file name.
`--title` overrides it.

Styling (DaisyUI and Tailwind) loads from the jsDelivr CDN, so the page is
unstyled without network access.

Comments use Lavish's native annotations.

## Updates

The worker checks the source file every second and re-renders the page when
its bytes change. Lavish then live-reloads it. If rendering fails, the worker
logs the error and keeps the last version on the page.

The default page path is
`${XDG_DATA_HOME:-$HOME/.local/share}/lavish-kit/pages/markdown/<name>-<hash>/index.html`
([files-and-logs.md](files-and-logs.md)).
