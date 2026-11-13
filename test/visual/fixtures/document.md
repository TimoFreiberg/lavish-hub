---
title: Screenshot document
status: Draft
owners:
  - Reviewer
  - Author
---
# Screenshot document

A fixed document for reviewing headings, **emphasis**, links to [a section](#table), and highlighted code.

## Highlighted code

```javascript
const greeting = 'Hello, reviewer';
export function greet(name) {
  return `${greeting}: ${name}`;
}
```

## Table

| Feature | State | Notes |
| --- | --- | --- |
| Documents | Ready | Markdown and raw HTML |
| Diffs | Ready | Added, deleted, renamed and changed files |

## Tasks

- [x] Read the document
- [ ] Review the screenshots

## Long lines

AReallyLongUnbrokenIdentifierThatKeepsGoingWithoutAnySpacesToExerciseWrappingAtSmallViewportWidthsAndStillHasMoreCharactersThanTheAvailableHorizontalSpaceInTheNarrowView

```text
AReallyLongUnbrokenCodeLineThatKeepsGoingWithoutAnySpacesToExerciseHorizontalScrollingRatherThanWrappingInsideTheCodeBlockAndStillHasMoreCharactersThanTheAvailableHorizontalSpaceInTheNarrowView
```

> A blockquote should remain readable in both color schemes.

### Small heading

<strong>Raw HTML remains part of the document.</strong>
