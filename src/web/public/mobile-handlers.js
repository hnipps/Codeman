/**
 * @fileoverview Mobile device support: detection, keyboard handling, and swipe navigation.
 *
 * Defines three singleton objects that manage mobile-specific behavior:
 *
 * - MobileDetection — Device type detection (mobile/tablet/desktop), touch capability,
 *   iOS/Safari identification, and body class management for CSS targeting.
 * - KeyboardHandler — Virtual keyboard show/hide detection via visualViewport API,
 *   toolbar/accessory bar repositioning, terminal resize on keyboard open/close,
 *   and input scroll-into-view. Uses 100px threshold for iOS address bar drift.
 * - SwipeHandler — Horizontal swipe detection on the terminal area for session switching.
 *   80px minimum distance, 500ms maximum time, 50px max vertical drift.
 *
 * All three have init()/cleanup() lifecycle methods. They are re-initialized after SSE
 * reconnect (in handleInit) to prevent stale closures.
 *
 * @globals {object} MobileDetection
 * @globals {object} KeyboardHandler
 * @globals {object} SwipeHandler
 *
 * @dependency keyboard-accessory.js (KeyboardAccessoryBar reference in KeyboardHandler.onKeyboardShow, soft — guarded with typeof check)
 * @loadorder 2 of 15 — loaded after constants.js, before voice-input.js
 */

// Codeman — Mobile detection, keyboard handling, and swipe navigation
// Loaded after constants.js, before app.js

// Layout height reserved for the docked prompt box (#composerDock): its
// one-line height, matching `min-height` in styles.css. A longer prompt grows
// the box upward over the terminal rather than shrinking the terminal.
const COMPOSER_DOCK_RESERVE_PX = 48;

// ═══════════════════════════════════════════════════════════════
// Mobile Detection
// ═══════════════════════════════════════════════════════════════

/**
 * MobileDetection - Detects device type and touch capability.
 * Updates body classes for CSS targeting.
 */
const MobileDetection = {
  /** Check if device supports touch input */
  isTouchDevice() {
    return (
      'ontouchstart' in window ||
      navigator.maxTouchPoints > 0 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
    );
  },

  /**
   * Check whether this browser belongs to a handheld device.
   *
   * Unlike getDeviceType(), this classification must remain stable when a
   * foldable changes posture. An unfolded phone can expose a desktop-width
   * viewport, but it still needs the same per-device settings that were saved
   * while folded. User-Agent Client Hints are preferred where available; the
   * legacy token fallback covers Android WebView and iPhone browsers.
   */
  isHandheldDevice() {
    if (!this.isTouchDevice()) return false;

    const userAgent = navigator.userAgent || '';

    // Prefer explicit UA form-factor signals. Besides matching real browsers,
    // this avoids Chromium emulation reporting userAgentData.mobile=true for
    // an iPad/tablet context created with isMobile=true.
    if (/iPad|Tablet|Silk|PlayBook|Kindle|Windows NT|CrOS|Macintosh/i.test(userAgent)) {
      return false;
    }
    if (/Android/i.test(userAgent) && !/Mobile/i.test(userAgent)) return false;
    if (/Mobi|iPhone|iPod/i.test(userAgent)) return true;

    const uaDataMobile = navigator.userAgentData?.mobile;
    if (typeof uaDataMobile === 'boolean') return uaDataMobile;

    return false;
  },

  /** Check if device is iOS (iPhone, iPad, iPod) */
  isIOS() {
    return (
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  },

  /** Check if browser is Safari */
  isSafari() {
    return /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  },

  /** Check if screen is small (phone-sized, <600px) */
  isSmallScreen() {
    return window.innerWidth < 600;
  },

  /** Check if screen is medium (tablet-sized, 600-768px) */
  isMediumScreen() {
    return window.innerWidth >= 600 && window.innerWidth < 768;
  },

  /** Get device type based on screen width */
  getDeviceType() {
    const width = window.innerWidth;
    if (width < 600) return 'mobile';
    if (width < 768) return 'tablet';
    return 'desktop';
  },

  /** Update body classes based on device detection */
  updateBodyClass() {
    const body = document.body;
    const deviceType = this.getDeviceType();
    const isTouch = this.isTouchDevice();

    // Remove existing device classes
    body.classList.remove(
      'device-mobile',
      'device-tablet',
      'device-desktop',
      'touch-device',
      'ios-device',
      'safari-browser'
    );

    // Add current device class
    body.classList.add(`device-${deviceType}`);

    // Add touch device class if applicable
    if (isTouch) {
      body.classList.add('touch-device');
    }

    // Add iOS-specific class for safe area handling
    if (this.isIOS()) {
      body.classList.add('ios-device');
    }

    // Add Safari class for browser-specific fixes
    if (this.isSafari()) {
      body.classList.add('safari-browser');
    }
  },

  /** Set --app-height CSS variable from visual viewport.
   *  On iPad Safari with tabs, 100vh extends behind the tab bar.
   *  visualViewport.height reflects the actual visible area.
   *  Skips when virtual keyboard is open — KeyboardHandler manages
   *  layout via translateY + paddingBottom; shrinking --app-height
   *  would double-count and leave zero space for the terminal. */
  updateAppHeight() {
    if (typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible) return;
    const vh = window.visualViewport?.height || window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${vh}px`);
    // How far the layout viewport (which anchors position: fixed) extends below
    // the visual viewport, i.e. behind the browser's bottom bar. 0 on iPhone
    // Safari, where fixed elements already stop above the bar; the overlap
    // where they do not. mobile.css lifts the toolbar by this rather than by
    // (100vh - --app-height), which on iPhone measures the collapsible chrome
    // instead and left an empty band between the toolbar and the bar.
    document.documentElement.style.setProperty('--chrome-overlap', `${Math.max(0, window.innerHeight - vh)}px`);
  },

  /** Initialize mobile detection and set up resize listener */
  init() {
    this.updateBodyClass();
    this.updateAppHeight();

    // Update --app-height on viewport resize (orientation, tab bar toggle)
    if (window.visualViewport) {
      this._appHeightHandler = () => this.updateAppHeight();
      window.visualViewport.addEventListener('resize', this._appHeightHandler);
    }

    // Debounced resize handler
    let resizeTimeout;
    this._resizeHandler = () => {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        this.updateBodyClass();
        this.updateAppHeight();
        // Whether the session sidebar is a docked column or a modal overlay is
        // decided at 1024px, so crossing that width has to re-sync the drawer
        // state — otherwise the `inert`/aria-hidden set on a closed overlay
        // drawer survives into the docked rail and makes it unclickable.
        if (typeof app !== 'undefined') app.applySessionListLayout?.();
        // Tab auto-wrap is width-driven, so it must re-evaluate on resize — the only
        // other trigger is a tab content render. No-op on mobile/tablet (method bails).
        if (typeof app !== 'undefined') app.updateTabOverflowMode?.();
      }, 100);
    };
    window.addEventListener('resize', this._resizeHandler);

    // iOS: prevent pinch-to-zoom (Safari ignores user-scalable=no since iOS 10)
    if (this.isIOS()) {
      this._gestureStartHandler = (e) => e.preventDefault();
      this._gestureChangeHandler = (e) => e.preventDefault();
      document.addEventListener('gesturestart', this._gestureStartHandler);
      document.addEventListener('gesturechange', this._gestureChangeHandler);
    }
  },

  /** Remove event listeners */
  cleanup() {
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
      this._resizeHandler = null;
    }
    if (this._gestureStartHandler) {
      document.removeEventListener('gesturestart', this._gestureStartHandler);
      document.removeEventListener('gesturechange', this._gestureChangeHandler);
      this._gestureStartHandler = null;
      this._gestureChangeHandler = null;
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Keyboard Handler
// ═══════════════════════════════════════════════════════════════

/**
 * KeyboardHandler - Simple handler to scroll inputs into view when keyboard appears.
 * Uses focusin event and scrollIntoView - keeps it simple and reliable.
 * Also handles terminal scrolling and toolbar repositioning via visualViewport API.
 */
const KeyboardHandler = {
  VIEWPORT_SETTLE_MS: 80,
  lastViewportHeight: 0,
  // Width of the visual viewport at the previous resize event. A virtual
  // keyboard never changes it, so a change here means the device itself
  // changed shape. See handleViewportResize().
  lastViewportWidth: 0,
  keyboardVisible: false,
  initialViewportHeight: 0,
  _viewportSettleTimer: null,
  _settleRestoreScroll: false,
  _settlePending: false,
  // Scroll intent captured at the start of a settle cycle (#259). `true` =
  // following live output, `false` = reading history and _settleAnchorY holds
  // the top visible line to return to.
  _settleFollowing: true,
  _settleAnchorY: null,
  // Invisible fixed element measured by _layoutViewportBottom().
  _fixedProbe: null,

  /** Initialize keyboard handling */
  init() {
    // Only initialize on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    this.initialViewportHeight = window.visualViewport?.height || window.innerHeight;
    this.lastViewportHeight = this.initialViewportHeight;
    // Seed the width too, or the first resize event reads as a shape change and
    // swallows a real keyboard.
    this.lastViewportWidth = window.visualViewport?.width || window.innerWidth;

    // Simple focus handler - scroll input into view after keyboard appears
    this._focusinHandler = (e) => {
      const target = e.target;
      if (!this.isInputElement(target)) return;

      // Wait for keyboard animation, then scroll input into view
      setTimeout(() => {
        this.scrollInputIntoView(target);
      }, 400);
    };
    document.addEventListener('focusin', this._focusinHandler);

    // Use visualViewport to detect keyboard and reposition toolbar
    if (window.visualViewport) {
      this._viewportResizeHandler = () => {
        this.handleViewportResize();
      };
      this._viewportScrollHandler = () => {
        this.updateLayoutForKeyboard();
      };
      window.visualViewport.addEventListener('resize', this._viewportResizeHandler);
      // Also handle scroll (iOS scrolls viewport when keyboard appears)
      window.visualViewport.addEventListener('scroll', this._viewportScrollHandler);
    }

    // Prevent page-level scroll when keyboard is visible.
    // iOS Safari scrolls the document to bring xterm's hidden textarea into
    // view when the user types, pushing the entire UI off-screen. The CSS
    // position:fixed on .app prevents most cases, but reset as a safety net.
    this._windowScrollHandler = () => {
      if (this.keyboardVisible) {
        window.scrollTo(0, 0);
      }
    };
    window.addEventListener('scroll', this._windowScrollHandler);
  },

  /** Remove event listeners */
  cleanup() {
    if (this._focusinHandler) {
      document.removeEventListener('focusin', this._focusinHandler);
      this._focusinHandler = null;
    }
    if (this._viewportResizeHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._viewportResizeHandler);
      this._viewportResizeHandler = null;
    }
    if (this._viewportScrollHandler && window.visualViewport) {
      window.visualViewport.removeEventListener('scroll', this._viewportScrollHandler);
      this._viewportScrollHandler = null;
    }
    if (this._windowScrollHandler) {
      window.removeEventListener('scroll', this._windowScrollHandler);
      this._windowScrollHandler = null;
    }
    if (this._viewportSettleTimer) {
      clearTimeout(this._viewportSettleTimer);
      this._viewportSettleTimer = null;
    }
    this._settleRestoreScroll = false;
    this._settlePending = false;
    this._settleFollowing = true;
    this._settleAnchorY = null;
  },

  /**
   * Handle viewport resize (keyboard show/hide).
   *
   * ⚠️ A resize that changes the viewport WIDTH is the device changing shape
   * (a rotation, or a foldable opening or closing), and is never a virtual
   * keyboard, which only ever takes height. Without that distinction, closing
   * an iPhone Duo (626→466pt wide, 890→678pt tall) drops the height by more
   * than the 150px threshold, so the app latched `keyboardVisible` with no
   * keyboard on screen: the accessory bar appeared, `main` grew 84px of dead
   * padding, and `updateAppHeight()` (which bails while the keyboard is up)
   * stopped refreshing --app-height. The latch is sticky, because clearing it
   * needs the height back within 100px of a baseline that is now a display the
   * user is no longer looking at, so it survived until the device was opened
   * again. Rotating any phone hit the same latch; the fold just makes it a
   * routine gesture rather than a rare one.
   *
   * The shape-change branch re-baselines instead, which is also what lets a
   * keyboard opened AFTER the fold be detected against the new display.
   */
  handleViewportResize() {
    const currentHeight = window.visualViewport?.height || window.innerHeight;
    const currentWidth = window.visualViewport?.width || window.innerWidth;
    const shapeChanged = currentWidth !== this.lastViewportWidth;
    this.lastViewportWidth = currentWidth;
    const heightDiff = this.initialViewportHeight - currentHeight;

    // Keyboard appeared (viewport shrunk by more than 150px). Both detection
    // branches are skipped on a shape change, whichever way the height moved.
    if (!shapeChanged && heightDiff > 150 && !this.keyboardVisible) {
      this.keyboardVisible = true;
      // Hold the PTY's rows for as long as the keyboard covers the terminal
      // (keyboardHoldsRows, keyboardClipPx in constants.js): every height
      // change makes Claude Code clear and reprint only the tail that fits.
      // Captured before anything refits, so these are the keyboard-free rows.
      if (typeof app !== 'undefined' && app.terminal && app._keyboardHoldEligible?.()) {
        app._keyboardHeldRows = app.terminal.rows;
      }
      document.body.classList.add('keyboard-visible');
      // While the keyboard is open, size the app to the visual viewport so
      // xterm's bottom row and cursor sit above the OS keyboard.
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
      this.onKeyboardShow();
    }
    // Keyboard hidden (viewport grew back close to initial)
    // Use 100px threshold (not 50) to handle iOS address bar drift,
    // iOS 26's persistent 24px discrepancy, and Safari bottom bar changes
    else if (!shapeChanged && heightDiff < 100 && this.keyboardVisible) {
      this.keyboardVisible = false;
      this._releaseHeldRows();
      document.body.classList.remove('keyboard-visible');
      this.onKeyboardHide();
      // Re-sync --app-height now that keyboard is gone (MobileDetection skipped
      // updates while keyboardVisible was true)
      MobileDetection.updateAppHeight();
    }

    // Update baseline when keyboard is not visible: adapts to address bar
    // state changes, orientation changes, and other viewport shifts. A shape
    // change re-baselines even with the keyboard up (it may genuinely still be
    // open, but its old baseline belongs to a display that is gone), and still
    // writes --app-height below so the keyboard-open sizing follows the new
    // display.
    //
    // ⚠️ With the keyboard up, the new baseline must be the KEYBOARD-FREE
    // height of the display the device moved to, which is window.innerHeight
    // (the layout viewport; the page sets no interactive-widget, so the
    // keyboard shrinks only the visual viewport on both engines, the same
    // fact updateLayoutForKeyboard() relies on). Baselining to the SHRUNK
    // visual height made heightDiff 0, so the very next same-width resize
    // (the settle event the OS animation produces, or any address-bar drift)
    // satisfied the hide branch and tore the keyboard layout down with the
    // keyboard still on screen, and it could not recover: no further 150px
    // drop can re-arm the show branch against a baseline that already sits
    // at the shrunk height.
    if (shapeChanged) {
      // Held rows belong to the display that is gone: release them and arm the
      // settle, which refits and tells the PTY. Nothing else would: with the
      // keyboard up throttledResize stands aside, and a rotation alone arms no
      // settle, so xterm kept the held rows with no clip and the composer sat
      // under the keyboard until it closed.
      if (this._releaseHeldRows()) this._scheduleViewportSettle();
      this.initialViewportHeight = this.keyboardVisible ? window.innerHeight : currentHeight;
    } else if (!this.keyboardVisible) {
      this.initialViewportHeight = currentHeight;
    }
    if (this.keyboardVisible) {
      document.documentElement.style.setProperty('--app-height', `${currentHeight}px`);
    }

    this.updateLayoutForKeyboard();
    this._deferViewportSettle();
    this.lastViewportHeight = currentHeight;
  },

  /** End a keyboard row hold (app._releaseKeyboardHold); true when one was held. */
  _releaseHeldRows() {
    return typeof app !== 'undefined' && !!app._releaseKeyboardHold?.();
  },

  /** Update layout when keyboard shows/hides */
  updateLayoutForKeyboard() {
    if (!window.visualViewport) return;

    if (!MobileDetection.isTouchDevice()) {
      this.resetLayout();
      return;
    }

    const cjkInput = document.getElementById('cjkInput');
    const isSmallMedium = MobileDetection.isSmallScreen() || MobileDetection.isMediumScreen();

    if (this.keyboardVisible) {
      const keyboardHeight = this.initialViewportHeight - (window.visualViewport.height || window.innerHeight);
      const accessoryBar = document.querySelector('.keyboard-accessory-bar');
      // The docked prompt box (keyboard-accessory.js syncDock), when showing.
      const composerDock = document.querySelector('#composerDock.composer-dock-visible');

      // The mobile case picker is a third position:fixed bottom-anchored
      // surface, and since it gained a search field the keyboard can open over
      // it. iOS does not shrink the layout viewport, so an unlifted sheet sits
      // BEHIND the keyboard with its own search box out of sight.
      const caseSheet = document.querySelector('.mobile-case-picker.active .mobile-case-picker-sheet');

      if (isSmallMedium) {
        // Phones/small tablets: toolbar and accessory bar are position:fixed
        // via CSS. Use translateY to lift them above the keyboard.
        const toolbar = document.querySelector('.toolbar');
        const main = document.querySelector('.main');

        const layoutHeight = this._layoutViewportBottom();
        const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
        const keyboardOffset = Math.max(0, layoutHeight - visualBottom);

        if (toolbar) {
          toolbar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
        }
        if (accessoryBar) {
          accessoryBar.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
        }
        if (caseSheet) {
          caseSheet.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
        }
        if (composerDock) {
          composerDock.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
          composerDock.style.bottom = '';
        }
        if (main && keyboardHeight > 0) {
          const cjkInputHeight = cjkInput?.classList.contains('cjk-input-visible') ? 44 : 0;
          const dockHeight = composerDock ? COMPOSER_DOCK_RESERVE_PX : 0;
          main.style.paddingBottom = `${84 + cjkInputHeight + dockHeight}px`;
        }
      } else if (keyboardHeight > 0) {
        // iPad: use direct bottom positioning (translateY unreliable —
        // iOS auto-scrolls the visual viewport, making keyboardOffset ≈ 0).
        if (accessoryBar) {
          accessoryBar.style.bottom = `${keyboardHeight}px`;
        }
        if (caseSheet) {
          caseSheet.style.bottom = `${keyboardHeight}px`;
        }
        // iPad: direct bottom = keyboard + accessory bar height, as for CJK.
        if (composerDock) {
          composerDock.style.bottom = `${keyboardHeight + 44}px`;
          composerDock.style.transform = '';
        }
      }

      // CJK textarea positioning (always position:fixed on touch devices).
      if (cjkInput?.classList.contains('cjk-input-visible') && keyboardHeight > 0) {
        if (isSmallMedium) {
          // Phones: use translateY like toolbar/accessory bar.
          const layoutHeight = this._layoutViewportBottom();
          const visualBottom = window.visualViewport.offsetTop + window.visualViewport.height;
          const keyboardOffset = Math.max(0, layoutHeight - visualBottom);
          cjkInput.style.transform = keyboardOffset > 0 ? `translateY(${-keyboardOffset}px)` : '';
          cjkInput.style.bottom = '';
        } else {
          // iPad: direct bottom = keyboard + accessory bar height.
          cjkInput.style.bottom = `${keyboardHeight + 44}px`;
          cjkInput.style.transform = '';
        }
      }
    } else {
      this.resetLayout();
    }
  },

  /**
   * Where `position: fixed; bottom: 0` lands, in px from the top: the bottom of
   * the layout viewport, which the toolbar, accessory bar and prompt box anchor to.
   *
   * ⚠️ Measured with an invisible fixed probe, never read off `window.innerHeight`.
   * The lift above assumed innerHeight stays the keyboard-free height while the
   * keyboard is up. On an iPhone (2026-11-04, home-screen app) it shrank with the
   * keyboard instead, so the lift came out 0 and every fixed bar sat BEHIND the
   * keyboard: an empty band where the bars should be, no accessory bar at all.
   * The probe reports where the bars really are on every engine; innerHeight is
   * only the fallback when the probe cannot be measured.
   */
  _layoutViewportBottom() {
    try {
      let probe = this._fixedProbe;
      if (!probe || !probe.isConnected) {
        probe = document.createElement('div');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.cssText = 'position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;';
        document.body.appendChild(probe);
        this._fixedProbe = probe;
      }
      const bottom = probe.getBoundingClientRect().top;
      if (Number.isFinite(bottom) && bottom > 0) return bottom;
    } catch {}
    return window.innerHeight;
  },

  /** Reset layout to normal (no keyboard) */
  resetLayout() {
    const toolbar = document.querySelector('.toolbar');
    const accessoryBar = document.querySelector('.keyboard-accessory-bar');
    const cjkInput = document.getElementById('cjkInput');
    const main = document.querySelector('.main');
    // Not scoped to `.active`, unlike the lift above: a sheet closed while the
    // keyboard was still up must still have its inline offset cleared, or the
    // next open slides in already displaced.
    const caseSheet = document.querySelector('.mobile-case-picker-sheet');

    if (toolbar) {
      toolbar.style.transform = '';
    }
    if (accessoryBar) {
      accessoryBar.style.transform = '';
      accessoryBar.style.bottom = '';
    }
    if (cjkInput) {
      cjkInput.style.transform = '';
      cjkInput.style.bottom = '';
    }
    if (caseSheet) {
      caseSheet.style.transform = '';
      caseSheet.style.bottom = '';
    }
    // Not scoped to `.composer-dock-visible`: a dock hidden while the keyboard
    // was up must not come back displaced.
    const composerDock = document.getElementById('composerDock');
    if (composerDock) {
      composerDock.style.transform = '';
      composerDock.style.bottom = '';
    }
    if (main) {
      main.style.paddingBottom = '';
    }
  },

  /** Called when keyboard appears */
  onKeyboardShow() {
    // Show keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.show();
    }

    // Reset any page scroll that occurred during keyboard open.
    // iOS Safari may scroll the document to reveal xterm's hidden textarea.
    window.scrollTo(0, 0);

    // visualViewport emits multiple heights throughout the OS animation.
    // Re-schedule on every event and fit only after the final height settles.
    this._scheduleViewportSettle({ restoreScroll: true });

    // Reposition subagent windows to stack from bottom (above keyboard)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /** Called when keyboard hides */
  onKeyboardHide() {
    // Hide keyboard accessory bar
    if (typeof KeyboardAccessoryBar !== 'undefined') {
      KeyboardAccessoryBar.hide();
    }

    this.resetLayout();

    this._scheduleViewportSettle({ restoreScroll: true });

    // Reposition subagent windows to stack from top (below header)
    if (typeof app !== 'undefined') app.relayoutMobileSubagentWindows();
  },

  /**
   * Coalesce the keyboard animation into one final xterm reflow and PTY resize.
   * Only a real show/hide transition arms the settle work; ongoing viewport
   * resize events merely push a pending settle back (_deferViewportSettle).
   * A viewport change that never crosses the show/hide thresholds must not
   * refit: keyboard detection can miss a fine-grained OS animation entirely
   * (each step under 150px, with the baseline chasing the animation), and the
   * container is then mid-animation with no keyboard CSS compensation, so a
   * fit against it resizes the PTY to transient dims and the SIGWINCH thrash
   * garbles the transcript.
   */
  _scheduleViewportSettle({ restoreScroll = false } = {}) {
    // Capture scroll intent on the FIRST event of a settle cycle, BEFORE any
    // fit() has reflowed the buffer — a later capture reads an already-moved
    // viewportY. Issue #259: this path used to force scrollToBottom
    // unconditionally, so opening the keyboard yanked a user who was reading
    // history down to the live output.
    if (!this._settlePending) this._captureTerminalScrollIntent();
    this._settleRestoreScroll = this._settleRestoreScroll || restoreScroll;
    this._settlePending = true;
    this._armViewportSettleTimer();
  },

  /**
   * Record whether the terminal is following live output, and if not, the top
   * visible line to return to. `_settleFollowing` defaults to true so a
   * terminal we cannot read keeps the historical scroll-to-bottom behavior.
   */
  _captureTerminalScrollIntent() {
    this._settleFollowing = true;
    this._settleAnchorY = null;
    if (typeof app === 'undefined' || !app.terminal?.buffer?.active) return;
    this._settleFollowing = app.isTerminalAtBottom();
    if (!this._settleFollowing) this._settleAnchorY = app.terminal.buffer.active.viewportY;
  },

  /**
   * Return to the captured anchor after the keyboard reflow. Reflow can rewrap
   * lines, so the anchor is approximate by construction; it is clamped to the
   * post-reflow buffer rather than trusted blindly.
   */
  _restoreTerminalScrollIntent() {
    const term = typeof app !== 'undefined' ? app.terminal : null;
    const anchor = this._settleAnchorY;
    if (typeof anchor !== 'number' || typeof term?.scrollToLine !== 'function' || !term.buffer?.active) {
      term?.scrollToBottom?.();
      return;
    }
    term.scrollToLine(Math.max(0, Math.min(anchor, term.buffer.active.baseY)));
  },

  /** Push a pending settle back while the viewport is still animating; no-op otherwise. */
  _deferViewportSettle() {
    if (!this._settlePending) return;
    this._armViewportSettleTimer();
  },

  _armViewportSettleTimer() {
    if (this._viewportSettleTimer) clearTimeout(this._viewportSettleTimer);
    this._viewportSettleTimer = setTimeout(() => {
      this._viewportSettleTimer = null;
      this._settlePending = false;
      const shouldRestoreScroll = this._settleRestoreScroll;
      this._settleRestoreScroll = false;

      if (typeof app !== 'undefined' && app.terminal) {
        // Floored fit, not a bare fitAddon.fit(): _shrinkPaddingToFit measures
        // the leftover gap under the LAST row, so it has to run against the
        // geometry xterm will actually keep (issue #464).
        app.syncTerminalGeometry?.();
        if (this.keyboardVisible) this._shrinkPaddingToFit();
        // Rows held: nothing re-renders on its own (the size did not change),
        // so place the screen for the settled box here.
        app._applyKeyboardClip?.();
        // Following live output → bottom, as before. Reading history → back to
        // the pre-reflow anchor instead of being yanked down (#259).
        if (shouldRestoreScroll) {
          if (this._settleFollowing === false) this._restoreTerminalScrollIntent();
          else app.terminal.scrollToBottom();
        }
        app._syncMobileHelperTextareaToCursor?.();
        app._localEchoOverlay?.rerender?.();
        this._sendTerminalResize();
      }
      window.scrollTo(0, 0);
    }, this.VIEWPORT_SETTLE_MS);
  },

  /**
   * Send the settled terminal dimensions to the server (one-shot, for keyboard
   * open/close — `throttledResize` deliberately holds the PTY's shape for the
   * whole animation, so this is what stops it going stale).
   *
   * ⚠️ Delegates rather than computing its own numbers. This used to re-read
   * `proposeDimensions()` and floor only what it POSTed, so on a phone with the
   * keyboard up — where the proposal is routinely under ten rows — the PTY was
   * told ten and xterm kept six, which is the #464 divergence. Worse, it read
   * the proposal AFTER `_shrinkPaddingToFit()` had moved the container, so even
   * unfloored its answer could differ from the fit above it. `sendResize` fits,
   * floors and applies in one step, and additionally gets the WS fast path and
   * the detached-session yield this hand-rolled POST never had.
   */
  _sendTerminalResize() {
    if (typeof app === 'undefined' || !app.activeSessionId) return;
    app.sendResize?.(app.activeSessionId)?.catch?.(() => {});
  },

  /**
   * Shrink .main paddingBottom to eliminate the terminal row quantization gap.
   * xterm can only render whole rows, so fractional-row pixels create dead
   * space below the last row. After fitAddon.fit(), measure the gap and
   * reduce padding by that amount so the terminal sits flush against the bars.
   */
  /**
   * Combined height of the fixed bars that overlay the terminal's bottom edge.
   *
   * On phones the toolbar and the accessory bar are `position: fixed`, so they
   * occupy no layout space of their own — `main`'s padding-bottom is the only
   * thing reserving room for them, and any pixel taken out of it is a pixel of
   * terminal painted underneath them.
   */
  _fixedBottomBarsHeight() {
    let px = 0;
    for (const selector of [
      '.toolbar',
      '.keyboard-accessory-bar',
      '#cjkInput.cjk-input-visible',
      '#composerDock.composer-dock-visible',
    ]) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const style = window.getComputedStyle?.(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      px += el.offsetHeight || 0;
    }
    return px;
  },

  /**
   * Reclaim sub-row slack at the bottom of the terminal — but never the space the
   * fixed bars stand in.
   *
   * Shrinking the padding by the whole slack pulled the terminal's bottom edge
   * DOWN under those bars, and the row the following re-fit then gained was
   * painted behind them: on a long wrapped prompt the last line was clipped by
   * the accessory bar, i.e. the bottom half of the text being typed. The floor is
   * now the bars' MEASURED height, so a device where the hard-coded 84px
   * over-reserves still reclaims the difference, while one that genuinely needs
   * it keeps every pixel.
   *
   * ⚠️ The floor can only ever prevent a shrink, never cause a grow
   * (`Math.min(currentPadding, …)`): a measured height LARGER than the current
   * padding makes this a no-op rather than silently resizing the terminal.
   */
  _shrinkPaddingToFit() {
    try {
      const container = document.getElementById('terminalContainer');
      const main = document.querySelector('.main');
      if (!container || !main || typeof app === 'undefined' || !app.terminal) return;
      const cellH = app.terminal._core?._renderService?.dimensions?.css?.cell?.height;
      if (!cellH) return;
      const gap = container.clientHeight - app.terminal.rows * cellH;
      if (gap > 0 && gap < cellH) {
        const currentPadding = parseInt(main.style.paddingBottom) || 0;
        const floor = Math.min(currentPadding, this._fixedBottomBarsHeight());
        main.style.paddingBottom = Math.max(floor, currentPadding - gap) + 'px';
        // Floored, like every other fit of the main terminal (#464).
        app.syncTerminalGeometry?.();
      }
    } catch {}
  },

  /** Check if element is an input that triggers keyboard (excludes terminal) */
  isInputElement(el) {
    if (!el) return false;

    // Exclude xterm.js terminal inputs (they handle their own scroll), and the
    // docked prompt box: it is position:fixed above the keyboard already, and
    // scrollIntoView would scroll the page under the app instead.
    if (el.closest('.xterm') || el.closest('.terminal-container') || el.closest('#composerDock')) {
      return false;
    }

    const tagName = el.tagName?.toLowerCase();
    // Exclude type=range, type=checkbox, type=radio (don't trigger keyboard)
    if (tagName === 'input') {
      const type = el.type?.toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'range' || type === 'file') {
        return false;
      }
    }
    return tagName === 'input' || tagName === 'textarea' || el.isContentEditable;
  },

  /** Scroll input into view above the keyboard */
  scrollInputIntoView(input) {
    // Check if input is still focused (user might have tapped away)
    if (document.activeElement !== input) return;

    // Find if we're in a modal
    const modal = input.closest('.modal.active');
    const modalBody = modal?.querySelector('.modal-body');

    if (modalBody) {
      // For modals - scroll within the modal body
      const inputRect = input.getBoundingClientRect();
      const modalRect = modalBody.getBoundingClientRect();

      // If input is below middle of modal, scroll it up
      if (inputRect.top > modalRect.top + modalRect.height * 0.4) {
        const scrollAmount = inputRect.top - modalRect.top - 100;
        modalBody.scrollBy({ top: scrollAmount, behavior: 'smooth' });
      }
    } else {
      // For page-level - use scrollIntoView
      input.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// Mobile Swipe Handler
// ═══════════════════════════════════════════════════════════════

/**
 * SwipeHandler - Detects horizontal swipes on terminal to switch sessions.
 * Only active on mobile/touch devices.
 */
const SwipeHandler = {
  startX: 0,
  startY: 0,
  startTime: 0,
  minSwipeDistance: 80, // Minimum pixels for a valid swipe
  // 300ms rejected an unhurried but deliberate swipe outright, which read as an
  // unresponsive gesture rather than as "too slow".
  maxSwipeTime: 500, // Maximum ms for a swipe gesture
  maxVerticalDrift: 50, // Max vertical movement allowed, at any point of the gesture

  _touchStartHandler: null,
  _touchMoveHandler: null,
  _touchEndHandler: null,
  _element: null,
  _ignoreGesture: false,

  /**
   * Surfaces inside `.main` that own their own gestures or controls: a swipe
   * there must not switch sessions. The phone overview and welcome screen are
   * deliberately NOT listed: swiping from home into a session is a feature.
   */
  IGNORE_SELECTOR: '.tile-grid, .term-select-bar, #cjkInput, .history-trunc-bar, #chatView, #composerDock',

  /** Initialize swipe handling */
  init() {
    // Only on touch devices
    if (!MobileDetection.isTouchDevice()) return;

    const terminal = document.querySelector('.main');
    if (!terminal) return;

    this._element = terminal;
    this._touchStartHandler = (e) => this.onTouchStart(e);
    this._touchMoveHandler = (e) => this.onTouchMove(e);
    this._touchEndHandler = (e) => this.onTouchEnd(e);
    terminal.addEventListener('touchstart', this._touchStartHandler, { passive: true });
    terminal.addEventListener('touchmove', this._touchMoveHandler, { passive: true });
    terminal.addEventListener('touchend', this._touchEndHandler, { passive: true });
  },

  /** Remove swipe listeners */
  cleanup() {
    if (this._element && this._touchStartHandler) {
      this._element.removeEventListener('touchstart', this._touchStartHandler);
      this._element.removeEventListener('touchmove', this._touchMoveHandler);
      this._element.removeEventListener('touchend', this._touchEndHandler);
    }
    this._touchStartHandler = null;
    this._touchMoveHandler = null;
    this._touchEndHandler = null;
    this._element = null;
  },

  onTouchStart(e) {
    // The session sidebar is an overlay child of .main, so its touches bubble in
    // here. Swiping across the open session drawer — the natural "dismiss it"
    // gesture — would otherwise fire nextSession() and drop the user into a
    // session they never tapped.
    // The terminal's touch handler publishes the axis it locks for a gesture
    // that starts on it; a touch that starts elsewhere in `.main` (the home
    // screen) must not inherit the last one, or a terminal scroll a moment
    // earlier vetoes a swipe from home. Reset before any early return.
    if (typeof app !== 'undefined') app._terminalGestureAxis = null;
    this._ignoreGesture = !!e.target?.closest?.('.session-sidebar');
    if (this._ignoreGesture) return;
    // A second finger makes this a different gesture (pinch, two-finger scroll):
    // never measure a later lift against the first finger's start. Stays set
    // until the next touchstart, so the first finger's lift cannot clear it.
    if (!e.touches || e.touches.length !== 1) {
      this._ignoreGesture = true;
      return;
    }
    this._ignoreGesture = !!e.target?.closest?.(this.IGNORE_SELECTOR);
    this.startX = e.touches[0].clientX;
    this.startY = e.touches[0].clientY;
    this.startTime = Date.now();
  },

  onTouchMove(e) {
    if (this._ignoreGesture || !e.touches || e.touches.length !== 1) return;
    if (Math.abs(e.touches[0].clientY - this.startY) > this.maxVerticalDrift) this._ignoreGesture = true;
  },

  onTouchEnd(e) {
    if (this._ignoreGesture) return;
    if (!e.changedTouches || e.changedTouches.length !== 1) return;
    if (typeof app === 'undefined') return;
    // The terminal's own touch handler (terminal-ui.js) runs first, on the same
    // gesture: a drag it locked as a scroll or a pan is not a session swipe,
    // and neither is a lift it consumed (its long-press selection gesture
    // preventDefaults the touchend, even on blank space where no selection
    // survives the lift). A swipe must not extend or drop a touch selection.
    if (e.defaultPrevented) return;
    if (app._terminalGestureAxis === 'y' || app._terminalGestureAxis === 'x') return;
    if (app._touchSelecting || app._touchSelectionActive) return;

    const endX = e.changedTouches[0].clientX;
    const endY = e.changedTouches[0].clientY;
    const elapsed = Date.now() - this.startTime;

    // Check if it's a valid swipe
    const deltaX = endX - this.startX;
    const deltaY = Math.abs(endY - this.startY);

    if (elapsed > this.maxSwipeTime) return; // Too slow
    if (deltaY > this.maxVerticalDrift) return; // Too much vertical movement
    if (Math.abs(deltaX) < this.minSwipeDistance) return; // Too short

    // Valid swipe detected. Swipe right -> previous session, left -> next.
    // In the order the strip draws, which a grouped layout ('case', 'state', a
    // sorted rail) makes differ from the canonical session order.
    if (deltaX > 0) app.prevSession({ visual: true });
    else app.nextSession({ visual: true });
  },
};
