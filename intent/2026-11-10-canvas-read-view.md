# Intent: Read-only canvas tab

**Status:** Implemented; independent program verification pending

## Problem statement

Canvas data has no first-party visual workspace.

## Proposed outcome

An authenticated, opt-in canvas document shows nested objects, preserves view state on agent writes, and supports keyboard, pointer and touch reading.

## Affected users and systems

Canvas readers; case picker, managed web tabs, browser bundle and build.

## Constraints

Read-only content; default-off setting; base paths; safe text; independent selection and focus; 500 objects at 50fps; pinned matte design.

## Open questions

None. Independent program verification and design verdict belong to the coordinator.

## Implementation

Nested DOM objects, a pure view-command layer, SSE catch-up, outline/search, reader/Keys and native-theme tokens implement the read-only slice. Unit and browser evidence lives in the task report. The phone starts on the first readable object in outline order. The full program review remains separate from this owner implementation.
