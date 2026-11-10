# Testing on a real iPhone

`scripts/ios-device.mjs` drives Codeman in Safari on a real iPhone. A whole
test (a scenario) runs in one call and returns one JSON report with
screenshots. Use it to verify touch, selection, keyboard and layout behaviour
that Chromium's mobile emulation does not reproduce.

## How it works

- Taps, long presses and drags go to WebDriverAgent as W3C touch actions. iOS
  receives them as real touches, so native text selection, handles, callouts
  and the keyboard behave as they do for a person.
- Checks run as JavaScript in the Safari page through Appium's web context.
- Taps aim at CSS selectors. The runner swallows one calibration touch to learn
  where the page sits on screen (Safari's status bar and toolbars move it), so
  it never queries the accessibility tree. That tree is slow in Safari and once
  stalled WebDriverAgent outright.
- It runs on the Mac next to Appium. With `--ssh` it copies itself there, runs,
  and copies the report back, so each step costs no network round trip.

Measured on an iPhone XR (iOS 18.1.1) with the runner on the Mac: a tap takes
about 0.65 s, a JS check about 0.02 s and a screenshot about 0.2 s. A
14-step scenario took 6.7 s on the device and 16 s end to end over SSH, most
of it connection setup and copying screenshots back.

## One-time setup

You need a Mac with Xcode, the iPhone connected by USB with Developer Mode and
Safari's Web Inspector turned on, and Appium with the XCUITest driver, its
WebDriverAgent signed for your team. Follow the
[XCUITest driver's real-device guide](https://appium.github.io/appium-xcuitest-driver/latest/preparation/real-device-config/).
Start Appium on the Mac. Its defaults (`127.0.0.1:4723`, WebDriverAgent
forwarded on `127.0.0.1:8100`) are what the runner expects. Override them with
`APPIUM_URL` and `WDA_URL`.

Write the capabilities to a file the first run can create a session from:

```json
{
  "platformName": "iOS",
  "appium:automationName": "XCUITest",
  "appium:udid": "<device udid>",
  "appium:usePrebuiltWDA": true,
  "appium:updatedWDABundleId": "<your WebDriverAgent bundle id>",
  "appium:noReset": true,
  "appium:newCommandTimeout": 1800,
  "appium:waitForIdleTimeout": 0,
  "appium:includeSafariInWebviews": true
}
```

The runner saves the session id in `~/.cache/codeman-ios-device/session.json`
on the Mac and reuses it while it is alive. It creates a session only when the
saved one is gone and `--caps` was passed.

## Running a scenario

On the Mac:

```bash
node scripts/ios-device.mjs scenario.json --caps caps.json --out ./ios-run
```

From another machine (paths are on your side; `--remote-node` is the Mac's
`node`, which a non-interactive SSH shell often cannot find by name):

```bash
node scripts/ios-device.mjs scenario.json --ssh you@mac --ssh-key ~/.ssh/key \
  --remote-node /Users/you/.nvm/versions/node/v24/bin/node --out ./ios-run
```

The report goes to stdout and `<out>/report.json`. Each step prints one
progress line to stderr. A failing step stops the run, unless the scenario sets
`"keepGoing": true`, and saves `<n>-failure.png`. The exit code is 0 when every
step passed, 1 when a step failed, and 2 when the run could not start.

## Scenario format

```json
{
  "page": "192.168.1.20:3000",
  "url": "optional: open this URL first",
  "steps": [
    { "do": "tap", "at": { "css": "#filePreviewReviewBtn" } },
    { "do": "waitFor", "js": "return !!window.app._docReview" },
    { "do": "press", "at": { "css": "#filePreviewBody p", "ax": 0.2, "ay": 0.2 }, "ms": 900 },
    { "do": "waitFor", "js": "return getSelection().toString()" },
    { "do": "drag", "from": { "selection": "end" }, "to": { "selection": "end", "dx": 150 }, "holdMs": 150 },
    { "do": "check", "name": "selection grew", "js": "return getSelection().toString().length > 7" },
    { "do": "shot", "name": "after-drag" }
  ]
}
```

`page` picks an already open Safari tab whose URL contains that text. Without
it, the runner uses the most recent page. `url` then navigates that tab, so
open the tab first when you set both. Step names are checked before the run
starts, so a typo fails without touching the phone.

| Step        | Fields                                       | What it does                                                             |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------------ |
| `tap`       | `at`                                         | One short touch.                                                         |
| `press`     | `at`, `ms` (800)                             | Touch and hold. A long press on text starts a native selection.          |
| `drag`      | `from`, `to`, `holdMs` (0), `ms` (600)       | Touch, optionally hold, move, release.                                   |
| `type`      | `text`                                       | Types on the native keyboard into the focused field.                     |
| `eval`      | `js`, `args`                                 | Runs JS and records what it returns.                                     |
| `check`     | `js`, `args`                                 | Fails unless the JS returns a truthy value.                              |
| `waitFor`   | `js`, `timeoutMs` (5000), `intervalMs` (100) | Polls the JS until it returns a truthy value. A throw counts as not yet. |
| `shot`      | `name`                                       | Saves a screenshot.                                                      |
| `sleep`     | `ms`                                         | Waits.                                                                   |
| `open`      | `url`                                        | Navigates the page.                                                      |
| `calibrate` | none                                         | Re-measures where the page sits on screen.                               |

The `js` text is a function body, so it must `return` its value.

A target (`at`, `from`, `to`) is one of:

- `{ "css": "<selector>" }` aims at the centre of the first match. `index` picks
  another match. `ax` and `ay` (0 to 1) pick a point inside the box, and `dx`
  and `dy` add CSS pixels. `"scroll": true` scrolls it into view first and measures again once it settles.
  Otherwise an element outside the visible viewport, or one with an empty box,
  fails the step.
- `{ "selection": "start" | "end" }` aims at an edge of the current text
  selection, where iOS draws its handles. `dx` and `dy` apply here too.
- `{ "x": 100, "y": 200 }` is a raw screen point, for native UI outside the
  page.

## Limits

- Calibration taps the middle of the screen once and swallows the touch. It
  fails when a native sheet or the keyboard covers that point, so calibrate
  before opening the keyboard. The runner recalibrates by itself after `open`
  and whenever `innerHeight` changes (Safari's toolbars collapsing). After
  anything else that moves the page, add a `calibrate` step.
- Elements inside iframes cannot be targeted by selector.
- Native UI (share sheets, permission prompts, the keyboard's own keys) has no
  selector. Use screen points read off a screenshot.
- Each touch costs about 0.6 s inside XCTest, so a scenario with many taps
  stays in seconds, not milliseconds.
