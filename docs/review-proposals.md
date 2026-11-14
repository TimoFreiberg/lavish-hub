# Proposals for review

## Expand unchanged diff context (issue #2)

The pinned `@pierre/diffs` already supports `loadDiffFiles`, expansion controls,
and `expansionLineCount`. The missing part is supplying full old/new file
contents for the exact reviewed revisions. A patch alone cannot recover them.

Proposed behavior: expand 20 lines above or below a gap, with an explicit
Expand all action. Load file contents lazily from the recorded git/jj snapshots
and verify them against the patch. Preserve old/new rename paths and the
reviewed working-tree snapshot; never fill a historical gap with today's file.
For stdin patches without available base contents, explain that additional
context is unavailable instead of showing misleading expansion controls.

This needs browser checks for unified/split views, comment line coordinates,
large files, collapsed files, and navigation after the virtualized height
changes. It is intentionally left unimplemented while browser execution is
blocked.

## One save-and-send action

The page currently warns users to choose its Send button instead of Lavish's
sidebar Send because only the page action reliably queues edits. Proposed:
route both through one save-and-send contract and replace the warning with a
short description of what will be sent. This needs a verified Lavish hook;
hiding the warning before sidebar saves work would make lost edits likelier.

## Keyboard save

Cmd/Ctrl+S currently intercepts the browser shortcut and asks the user to click
Send. Decide whether it should save only, or also send queued comments like
the page's Send button. Sending comments from a familiar save shortcut is a
behavioral choice, so it has not been changed without review.

## Narrow diff layout

The sidebar retains 160 pixels below 700 pixels wide, while per-file headers
contain Viewed controls, counts, and per-hunk Zed links. Proposed: a Files
drawer at narrow widths and a compact Open in editor menu. Confirm this in
480-pixel screenshots before choosing breakpoints or changing virtualized
header heights. Do not infer a fixed layout from source inspection alone.

## Safe lifetime and resume

Lavish 0.1.96 tracks browser connections internally through WebSocket event
clients and returns browser_disconnected from a consuming poll. Its health
endpoint exposes poll listeners, not non-consuming browser connection counts.
Opening an event connection to observe presence would itself count as a
connected review. Neither is an adequate observation API for watch-only
cleanup or a ten-minute idle policy.

Proposed upstream addition: non-consuming per-session browser presence and
last-disconnect time. Then keep pages while an opening agent is live, retain
the outbox when stopping, and show a Not live banner with an explicit Resume
action. Integrate the resume path with the external herdr Artifacts opener
only after that opener and its tests are available. Those dotfiles are not in
this repository.
