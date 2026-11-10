# Intent: Review a document and send feedback to its agent

**Status:** Draft

## Problem statement

An agent writes a plan or a doc and the user wants to mark it up. Today the only way is to type comments into the prompt, quoting the text by hand. An external annotation tool can be shown through a web tab, but behind a sign-in layer it only works in a trusted frame, and a trusted frame runs that tool's page on Codeman's origin.

## Proposed outcome

A Markdown file open in the file preview has a Review mode. The user selects text and attaches a comment, adds an overall note, and presses Send feedback or Approve. Codeman saves the feedback as a Markdown file in the session's upload folder and submits a one-line prompt to that session naming the document and the feedback file.

Nothing new runs. The document is rendered by the existing sanitised Markdown pipeline in Codeman's own page. There is no frame, no trust switch and no new server route. The feedback file goes through the existing prompt-upload route.

## Affected users and systems

- The user reviewing a doc on a phone or a desktop.
- The agent in that session, which receives one prompt and reads one file.
- The file preview overlay (`panels-ui.js`), a new `doc-review.js` module, `index.html`, `styles.css` and `mobile.css`.

## Constraints

- The document, its quotes and the comments reach the DOM through the existing sanitiser or `textContent`. Highlights are built with DOM range calls, never from an HTML string.
- Feedback is sent only by the user's own press. Nothing sends itself.
- The prompt is one line of printable text, so it takes the verified plain-prompt path.
- A successful send clears only the draft snapshot it sent. Edits made during upload or prompt delivery stay as an unsent draft, including after closing and reopening Review.
- An unsent draft survives a reload on that device. It is per-device `localStorage`, keyed by session and file, never a synced setting. A draft is removed once its session is gone.
- On phones, the preview overlay and window both follow the visual viewport height so the native keyboard leaves the comment and feedback actions visible.
- A remote session cannot take a prompt upload, so Review is refused there with a message.
- A preview opened from an attachment card under a bare file name has no path to name, so Review is not offered there.
- The feedback goes to the session the preview belongs to, which is not always the selected tab.
- A comment whose quoted text has left the document is kept and sent marked as changed, never dropped.
- Logic lives in the new module. Edits to existing frontend files stay small, since this fork merges upstream releases.

## Open questions

- Whether an agent should be able to ask for a review, which would raise a badge on its tab. Not in this change.
