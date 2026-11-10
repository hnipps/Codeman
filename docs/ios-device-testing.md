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
The runner expects Appium on `127.0.0.1:4723` and WebDriverAgent forwarded on
`127.0.0.1:8100` (Appium's defaults). Override them with `APPIUM_URL` and
`WDA_URL`. Keep Appium bound to loopback.

Run Appium as a launchd job (`~/Library/LaunchAgents/dev.codeman.appium.plist`
with `KeepAlive`), not from an SSH command. An Appium started inside an SSH
session dies with that session, and every later run fails with `fetch failed`.

Write the capabilities to `~/.config/codeman-ios-device/caps.json` on the Mac
(mode 600). The runner reuses the session id it saved in
`~/.cache/codeman-ios-device/session.json` while that session is alive, and
creates a new one from this file when it is gone. `--caps` points at another
file.

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

Creating a session takes a few seconds, ends any other Appium session on the
device, and leaves the phone's data alone (`noReset`).

## A disposable Codeman for the phone

Point the phone at a throwaway instance, never at your real one.
`scripts/ios-test-instance.sh` runs one under `CODEMAN_INSTANCE=iphone` with its
own data dir (`~/.codeman-iphone`), tmux socket, cases folder and generated
password. It clears every inherited `CODEMAN_*` variable first, so it cannot
pick up your real password, data dir or socket. It listens on `127.0.0.1` only.

```bash
IOS_TEST_ALLOWED_HOSTS=<host the phone uses> scripts/ios-test-instance.sh start [CODE_DIR]
scripts/ios-test-instance.sh status | stop | password
```

`CODE_DIR` is the build to test: a checkout (run through `tsx`) or a built
release with `dist/`. `status` and `stop` reuse the folder `start` was given.
The server is detached, so it outlives your shell but not a reboot.

What this protects: a test that taps the wrong thing hits throwaway sessions,
and your real login never sits in the phone's browser. What it does not: the
instance's shell sessions run as your OS user, so page JS that opens a shell
there can reach anything that user can. It also reads that user's agent
history, so the home screen's Past Sessions lists your real Claude, Codex and
OMP transcripts by title, and **resume** on one continues that real
conversation. Use a container or a separate OS user when you need a real
boundary.

The phone reaches the instance through an SSH tunnel the Mac opens, kept up by
launchd (`dev.codeman.ios-tunnel`, `ssh -N -L 0.0.0.0:3190:127.0.0.1:3190`).
Authorize the Mac's tunnel key on the Codeman host with
`restrict,port-forwarding,permitopen="127.0.0.1:3190",command="/usr/bin/false"`
in front of it, so the key can forward to the test instance and nothing else.
The phone then opens `http://<mac LAN address>:3190/`. That host goes in
`IOS_TEST_ALLOWED_HOSTS`, or the host guard answers 403.

Log the phone in once. Safari keeps the cookie for 24 hours and extends it
while you use it:

```bash
scripts/ios-test-instance.sh login-scenario http://<mac LAN address>:3190/ > login.json
node scripts/ios-device.mjs login.json --ssh you@mac ...
rm login.json
```

The scenario opens Safari at that address and types the generated username and
password into the login dialog. The report never contains typed text.

Create the Appium session while Safari has a page open. A session created
before that can keep a stale Web Inspector link: page steps then fail with
"Appium sees no Safari pages" while the page is plainly on screen. Delete
`~/.cache/codeman-ios-device/session.json` on the Mac and rerun.

## Running a scenario

On the Mac:

```bash
node scripts/ios-device.mjs scenario.json --out ./ios-run
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

`url` opens that address in Safari before the first step. `page` picks the
Safari tab whose URL contains that text, waiting up to 10 s for it. Without it,
the runner uses the most recent page. The page is looked up the first time a
step needs it, so native-only steps (screen points, `type`, `shot`) run with no
page open. Step names are checked before the run
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
