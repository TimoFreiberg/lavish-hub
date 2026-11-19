# Changes

The workspace hub shows jj changes and supports line feedback. Use the controls between hunks to reveal unchanged lines from the displayed snapshot. Expansion loads each side on demand for modified, renamed, or copied regular text files, up to 1 MiB per side. A read that has not answered within ten seconds is abandoned. When a file or an older snapshot is unavailable, the original diff stays visible, the hub reports the failed expansion, and expanding again retries the read. Comments and drafts stay with the displayed diff.

See [hub](hub.md) for the workspace workflow and [workflow gaps](hub-gaps.md) for removed standalone diff capabilities.
