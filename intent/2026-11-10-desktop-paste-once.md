# Intent: Desktop paste once, with no editing toolbar

**Status:** Draft

## Problem statement

On a desktop, Ctrl+V or Cmd+V in the terminal chat box either inserts the clipboard twice or pops a floating toolbar. The toolbar shows up on Cmd+V in this session's composer. The chord should insert the clipboard once and leave the terminal focused.

## Proposed outcome

A fine primary pointer pastes once, immediately, into the terminal that already has focus. No contenteditable is created, and no platform editing toolbar appears. A coarse pointer and Android keep the existing paste trap, including image pastes.

## Affected users and systems

Desktop browsers using the Codeman terminal, including split panes and grid tiles. Phones keep the current trap.

## Constraints

The key handler must still return false without preventDefault, or Chromium inserts nothing. Do not call `navigator.clipboard.readText()` on this path. Do not remove `execCommand('paste')` from the coarse-pointer trap. Right-click Paste stays on xterm once the short desktop arm expires. Do not send keystrokes into a live user session to verify.

## Open questions

None. Linux Chromium Meta+V delivers no paste event. That chord inserts nothing and must not leave a focused editable behind. macOS Cmd+V is the platform paste shortcut and inserts once through the browser paste event.
