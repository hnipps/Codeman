# Intent: Send review notes to a new session

**Status:** Done

## Problem statement

On the Reviews page, Request changes is disabled once the session that wrote the review has ended ("The session that wrote this review has ended, so there is nowhere to send notes"). Sessions end all the time (a deploy, a reboot, a closed tab), so notes on such a review could not reach any agent.

## Proposed outcome

When the author session has ended, the button still reads **Request changes** (review note: the reviewer doesn't need to know a new session is involved). Pressing it starts a Claude session in the review's checked-out folder and sends it one prompt with the whole piece of work, not just the notes: title, walkthrough, branch and base, changed files, the open canvas Work items linked to the old session (key, title, status, description, open question, last outcome), and the notes. Once the prompt lands, the review belongs to the new session (its `codeman agent review submit` updates the same review, and Request changes goes to it), and the new session is linked to those work items.

## Affected users and systems

The reviewer on the Reviews page. `POST /api/reviews/:id/new-session` (`review-routes.ts`), `handoverPrompt`/`handOver` (`review-model.ts`), `review-work.ts`, the server's existing `startConversationSession` (no second spawn path).

## Constraints

- Nothing starts or sends without a button press; a person's act only (agent header refused), live colour only.
- Refused while the author session still runs, so two agents never work one branch.
- The folder must still have the branch checked out; the new session never checks anything out itself.
- A prompt that never reached the pane deletes the new session and changes nothing (no half hand-over).
- Uses the caller's own credentials through the ordinary create routes, so caps and ownership rules apply.

## Open questions

None.
