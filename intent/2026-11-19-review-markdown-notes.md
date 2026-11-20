# Intent: Rendered Markdown and notes on it in Reviews

**Status:** Draft

## Problem statement

Much of what agents hand in for review is prose: specs, plans, briefs, READMEs. On the Reviews page a changed Markdown file shows only as a line diff. The reviewer reads raw Markdown syntax, cannot see the document as its readers will, and can only anchor a note to one diff line. Plannotator lets a person read a rendered plan and annotate selected words; the Reviews page cannot.

## Proposed outcome

- In Changes, a changed `.md` or `.markdown` file opens **Rendered** by default: the file as the branch tip has it, through the dashboard's one Markdown parser and sanitizer. A **Rendered / Diff** switch in the file's header goes back to the line diff, and the choice holds across files.
- Blocks the branch changed carry a green bar in the margin (added lines, and the line after a removal). A file the branch adds gets no bars, since every block would carry one. A code link with a line range marks the blocks that cover it.
- Selecting words in the rendered file offers **Add note**, the same control the walkthrough uses. The note is a plain review note anchored to the file and the words (`kind: "doc"`): it appears in the notes list, highlights its words, counts on the file's row, is found again from the list, is resolved by a person, and goes out with every other unsent note on Request changes (and on a hand-over to a new session). The prompt names it as `On <path> (the rendered document), at "<words>"`.
- Repository links in the rendered file go quiet (their target is the title); only web addresses open. Images load only from `https:`.

## Affected users and systems

- The owner, on desktop and phone.
- `src/reviews/review-git.ts` (`reviewFileText`), `src/reviews/review-model.ts` (the `doc` anchor and its prompt line), `src/web/routes/review-routes.ts` (`GET /api/reviews/:id/file`), `src/web/public/reviews.{js,css}`.

## Constraints

- The file is read by sha with `git cat-file`, so no filter, textconv or working tree is involved; the path is a key into the branch's own change list. Markdown only, at most 400 KiB. The same Docker and remote refusals as the diff route.
- Rendered text goes only through the existing parser and the one sanitizer.
- Owner decision (2026-11-19): one plain note kind, not Plannotator's Comment / Replace / Delete; Rendered is the default view.
- Compatibility: a review that holds a `doc` note does not parse on a release before this one. Rolling back leaves such a review unread (never overwritten) until rolled forward.

## Open questions

None.
