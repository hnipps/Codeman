# Intent: Ambient capture, ticket 7: exact-pixels mode (tab capture)

**Status:** Draft (ticket 7 of `intent/2026-11-19-ambient-capture.md`, Work item W-99. That spec is merged and immutable, and says ticket 7's invariants and checks are written when it is unblocked. This file holds them.)

## Problem statement

Ticket 1's rasteriser (html-to-image) missed acceptance check 4. On a real dashboard with 6 tiles plus the main terminal, freeze time at the 95th percentile was 1.7 to 2.3 s against budgets of 400 ms (ratio 1) and 800 ms (ratio 2). The style-inlining clone and the SVG decode set that floor (draft PR #89, `docs/spikes/w-49-ambient-capture/README.md`). The rasteriser's picture is also close, not exact, and sandboxed frames reach it only through the frame bridge. On 2026-11-20 Harry chose option (c) on W-93: unblock ticket 7, tab capture, for exact pixels.

## Proposed outcome

An opt-in, per-device setting, **Exact-pixel capture**, makes `CodemanCapture.freeze()` take its picture from the browser's own capture of the current tab (`getDisplayMedia` with `preferCurrentTab`) on desktop Chromium. The browser asks once per page load. After that a freeze reads one video frame, which is fast and exact, sandboxed frames included. Every other browser, every phone, the setting off, a declined prompt, and any case below that cannot be proven safe keep the rasteriser.

## Affected users and systems

- A person on desktop Chromium who turns the setting on. They see one consent prompt per page load and Chromium's "sharing this tab" indicator while the stream is open.
- `src/web/public/capture.js` (the tab path beside the rasteriser), `settings-ui.js` and `index.html` (the setting). No server change: the key is per-device and stays out of `SettingsUpdateSchema`.
- Later tickets read `FreezeResult.source` to tell which path made a picture.

## Invariants

### T1: TabModeIsOptIn

The tab path runs only when the per-device setting `captureTabMode` is exactly `true`, the device is not a phone (`MobileDetection.isMobile()`), and the browser has `getDisplayMedia`, `MediaStreamTrack.prototype.getCaptureHandle`, `setCaptureHandleConfig` and `ImageCapture`. Anything else uses the rasteriser, and no capture prompt is ever shown.

- *Failure condition:* `getDisplayMedia` is called with the setting absent or false, on a phone, or without the APIs.
- *Test:* a browser test spies on `getDisplayMedia`, freezes with the setting off, and finds no call and `source: "raster"`.

### T2: OnlyThisTab

A stream is used only if its video track's capture handle equals the random handle this page load set with `setCaptureHandleConfig`. A stream of another tab, a window or a screen is stopped at once and that capture uses the rasteriser. `preferCurrentTab`, `selfBrowserSurface: "include"`, `surfaceSwitching: "exclude"` and `monitorTypeSurfaces: "exclude"` steer the prompt there, but the handle check is what is trusted.

- *Why:* a picture of another tab or of the screen would file content the person never meant to share into a Work item.
- *Failure condition:* a frame from a stream whose handle does not match reaches `blob`.
- *Test:* a browser test answers `getDisplayMedia` with a stream whose track reports another handle; the track is stopped and the result is `source: "raster"`.

### T3: OneConsentPerPageLoad

The stream, once accepted, stays open and is reused by every later freeze in that page load. The browser is asked again only after the stream ended (the person pressed Stop sharing, or the setting was turned off, which stops it). A declined prompt is not asked again in that page load. Concurrent freezes share one prompt.

- *Failure condition:* a second freeze in one page load calls `getDisplayMedia` while the first stream is live, or after a decline.
- *Test:* a browser test freezes three times and counts one `getDisplayMedia` call; a second case declines and counts one call over two freezes; a third ends the track and counts a second call.

### T4: FreezeComesFirstInTabMode (I1 for the tab path)

Toasts are held from the call until the frame is read, the consent prompt included. If any `[data-codeman-capture]` element is rendered at the trigger, that capture uses the rasteriser, which leaves it out; the tab path cannot. A frame whose aspect ratio differs from the viewport's by more than 2 % (the viewport changed under the stream, for example when Chromium's sharing bar first appears) is not used; that capture uses the rasteriser.

- *Failure condition:* a toast on screen at the trigger is missing from a tab-mode picture, capture UI is in one, or a stretched frame is returned.
- *Test:* the toast case of ticket 1 run in tab mode; a capture-UI case that finds `source: "raster"`.

### T5: SameResultShape

The tab path returns ticket 1's `FreezeResult` (`blob`, `width`, `height`, `pixelRatio`, `freezeMs`, `frames`, `page`) plus `source: "tab"`, and the rasteriser's result gains `source: "raster"`. In tab mode every frame record has `captured: true`, because the browser drew it.

- *Failure condition:* a consumer of `FreezeResult` needs a branch on the path to read a field.
- *Test:* the browser tests read the same fields from both paths.

## Acceptance checks

1. `npm test -- test/capture-tab-mode.test.ts` (static wiring of the setting) passes with a non-zero file count.
2. `npm run test:browser -- test/capture-tab-mode.browser.test.ts` passes, one file, non-zero count. It runs Chromium with `--auto-accept-this-tab-capture` so a real tab stream is used where the host supports it, and fakes the stream for T2.
3. Freeze time in tab mode, after consent, on the dashboard of check 2: report the 95th percentile of 10 freezes at ratio 1 in the PR. Target: under ticket 1's 400 ms budget. Headless SwiftShader numbers are a lower bound of confidence, not a desktop measurement; say so.
4. Not checkable here, and said so in the PR: the real consent prompt and sharing bar on a desktop with a real GPU.

## Constraints

- No new dependency, no server change, no change to the rasteriser's behaviour when the setting is off.
- The setting is per-device: it goes in `_displaySettingKeySet()` and is stripped before the settings PUT, like `autoCopySelection`.
- `getDisplayMedia` needs transient user activation, so `freeze()` must call it before its first `await`. The chord and the button that later tickets add are user gestures; a freeze started without one fails the prompt and falls back.

## Open questions

- None that block the build. Whether tab mode should become the default on desktop Chromium is Harry's call once he has used it.
