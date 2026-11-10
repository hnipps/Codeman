# Intent: Fast real-iPhone scenario runner

**Status:** Draft

## Problem statement

Testing Codeman in iOS Safari on a real iPhone works through Appium, but each
tap or check is one agent tool call. On 2026-11-10 a Codex session made 118
tool calls in a 28-minute test pass, about 14 s each. Every request also
crossed a ZeroTier and SSH tunnel (251 ms round trip, 731 ms per screenshot,
measured from this host). On the Mac itself a tap costs about 0.63 s, a page
JS call about 0.02 s and a screenshot about 0.14 s. The device is not the
bottleneck. The agent's turn count and the tunnel are.

The same session found that reading the accessibility tree inside Safari is
slow and once stalled WebDriverAgent, and it aimed taps by reading
coordinates off screenshots by hand.

## Proposed outcome

`scripts/ios-device.mjs` runs a whole scenario (a JSON list of steps) in one
call, next to Appium on the Mac. Gestures go to WebDriverAgent as W3C touch
actions, so iOS sees real touches. Assertions run as JS in the Safari page.
Taps aim at CSS selectors. One swallowed calibration touch maps page
coordinates to screen points, with no accessibility-tree queries. The run
returns one JSON report plus screenshots. With `--ssh` it copies itself to the
Mac, runs there, and copies the results back.

## Affected users and systems

Developers and agents verifying mobile features on a real device. No server,
frontend or package code changes. Nothing ships in the npm package.

## Constraints

- No new dependencies. Node 22+ built-ins only, because the Mac runs it from a
  bare copy.
- No host names, users or device ids in the repo. They come from flags and env.
- Never create or delete an Appium session the caller did not ask for. Reuse
  the saved one, and create one only from a capabilities file.

## Open questions

None.
