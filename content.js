/**
 * AttentionSpam — content.js
 * Manifest V3 Content Script
 *
 * Targets: https://www.youtube.com/live_chat* (the iframe document).
 * The manifest injects this into all_frames, so it runs in both the
 * outer watch page and the embedded live-chat iframe. An early-exit
 * guard ensures all DOM work only executes inside the iframe context.
 *
 * Polymer / async rendering strategy:
 *  - MutationObserver is anchored to documentElement immediately so it
 *    fires even before <body> is available.
 *  - customElements.whenDefined() awaits precise Polymer component
 *    upgrades (yt-live-chat-text-input-field) rather than relying on
 *    the element merely being present in the DOM tree.
 *  - setInterval polling is kept as a belt-and-suspenders fallback.
 *
 * Core responsibilities:
 *  1. Locate the contenteditable chat input and Send button using
 *     stable, non-minified selectors.
 *  2. Inject a text-only hint banner above the chat input box.
 *  3. Toggle an automation loop on a 1.5 s long-press of the Send button.
 *  4. While looping: capture the typed text, re-insert it after each post,
 *     and maintain a smart cooldown with humanizer jitter.
 *  5. Parse YouTube slow-mode and error banners to dynamically adjust the
 *     cooldown so the loop stays safe and within YouTube's rate limits.
 *
 * Security notes:
 *  - No user data is sent to any remote server or background script.
 *  - The extension only reads from and writes to the DOM of youtube.com.
 *  - All timing values are positive-only to prevent race conditions.
 */

(function attentionSpam() {
  "use strict";

  /* =========================================================
     CONSTANTS
     ========================================================= */

  /** Minimum hold duration (ms) required to activate / deactivate. */
  const LONG_PRESS_THRESHOLD_MS = 1500;

  /** Default base cooldown (ms) when slow-mode is not detected. */
  const DEFAULT_COOLDOWN_MS = 10_000;

  /** Humanizer jitter: random extra delay added each cycle (ms). */
  const JITTER_MIN_MS = 500;
  const JITTER_MAX_MS = 1500;

  /** How often (ms) to poll for the chat UI after page load.
   *  The poll runs indefinitely — no cap — because YouTube's Polymer
   *  pipeline can take an unpredictable amount of time to upgrade
   *  and render the chat input components.
   */
  const INIT_POLL_INTERVAL_MS = 800;

  /** Hint banner text states. */
  const HINT_TEXT_IDLE = "Hold Send to loop this message safely.";
  const HINT_TEXT_LOOPING = "Looping active. Hold Send again to stop.";

  /* =========================================================
     STATE
     ========================================================= */

  let isLooping = false;
  let loopTimeoutId = null;
  let longPressTimerId = null;
  let longPressStartTime = 0;

  /**
   * Base cooldown in ms. Updated dynamically when YouTube's error
   * banner surfaces a "Please wait X seconds…" message.
   */
  let baseCooldownMs = DEFAULT_COOLDOWN_MS;

  /**
   * Timestamp (Date.now()) of the most recent post attempt.
   * Used by the smart auto-adjuster to compute the true cooldown.
   */
  let lastPostAttemptTime = 0;

  /* =========================================================
     SELECTOR HELPERS
     (no minified/hashed class names — only stable DOM attributes)
     ========================================================= */

  /**
   * Returns the contenteditable div inside <yt-live-chat-text-input-field>
   * or the element with id="input", whichever is found first.
   */
  function getChatInput() {
    // Primary: polymer component → inner contenteditable
    const component = document.querySelector(
      "yt-live-chat-text-input-field #contenteditable-root, " +
      "yt-live-chat-text-input-field [contenteditable='true']"
    );
    if (component) return component;

    // Fallback: generic contenteditable inside #input wrapper
    const inputWrapper = document.querySelector("#input [contenteditable='true']");
    if (inputWrapper) return inputWrapper;

    // Last resort: any contenteditable in the chat panel
    return document.querySelector("[contenteditable='true']");
  }

  /**
   * Returns the Send button element using stable attribute selectors.
   */
  function getSendButton() {
    // Primary: id="send-button" which may wrap an inner button/paper-button
    const byId = document.querySelector(
      "#send-button button, #send-button paper-button, #send-button"
    );
    if (byId) return byId;

    // Fallback: aria-label
    return document.querySelector(
      "button[aria-label='Send message'], " +
      "yt-button-renderer[aria-label='Send message']"
    );
  }

  /**
   * Returns the container that wraps the chat input and send button row.
   * Used to inject the hint banner directly above it.
   */
  function getChatInputContainer() {
    return (
      document.querySelector("#input-panel") ||
      document.querySelector("yt-live-chat-text-input-field") ||
      (getChatInput() && getChatInput().closest("form, #input-panel, #input-container"))
    );
  }

  /* =========================================================
     SLOW-MODE & ERROR BANNER PARSING
     ========================================================= */

  /**
   * Scans the live chat panel for a slow-mode indicator text such as
   * "Slow mode is on. Send messages every X seconds."
   * Returns the number of seconds, or null if not found.
   *
   * @returns {number|null}
   */
  function parseSlowModeSeconds() {
    // YouTube renders slow-mode text inside various renderer elements
    const candidates = document.querySelectorAll(
      "yt-live-chat-restricted-participation-renderer, " +
      "#slow-mode-panel, " +
      "[id*='slow'], " +
      "yt-live-chat-header-renderer"
    );

    for (const el of candidates) {
      const text = el.textContent || "";
      const match = text.match(/send messages every (\d+) second/i);
      if (match) {
        const secs = parseInt(match[1], 10);
        if (Number.isFinite(secs) && secs > 0) return secs;
      }
    }
    return null;
  }

  /**
   * Scans the chat panel for a YouTube error banner such as
   * "Please wait X seconds before sending another message."
   * Returns the extracted X value in milliseconds, or null if not found.
   *
   * @returns {number|null}
   */
  function parseErrorBannerWaitSeconds() {
    const candidates = document.querySelectorAll(
      "yt-live-chat-banner-renderer, " +
      "#panel-pages yt-live-chat-toast-renderer, " +
      "[id*='error'], " +
      "[id*='banner'], " +
      "[id*='toast']"
    );

    for (const el of candidates) {
      const text = el.textContent || "";
      // Matches "Please wait 12 seconds" or "Wait 5 seconds"
      const match = text.match(/(?:please\s+)?wait\s+(\d+)\s+second/i);
      if (match) {
        const secs = parseInt(match[1], 10);
        if (Number.isFinite(secs) && secs > 0) return secs;
      }
    }
    return null;
  }

  /**
   * Reads the current slow-mode delay from the DOM and updates baseCooldownMs.
   * Called once at initialization.
   */
  function initCooldownFromSlowMode() {
    const secs = parseSlowModeSeconds();
    if (secs !== null) {
      baseCooldownMs = secs * 1000;
      console.info(
        `[AttentionSpam] Slow mode detected: ${secs}s — base cooldown set to ${baseCooldownMs}ms`
      );
    } else {
      baseCooldownMs = DEFAULT_COOLDOWN_MS;
      console.info(
        `[AttentionSpam] No slow mode found — using default cooldown ${baseCooldownMs}ms`
      );
    }
  }

  /**
   * Called after a post attempt to check for YouTube error banners.
   * If found, recalculates baseCooldownMs using:
   *   trueBase = (X + Y) where X = YouTube's wait requirement,
   *              Y = elapsed time since last attempt (seconds)
   */
  function smartAdjustCooldown() {
    const waitSecs = parseErrorBannerWaitSeconds();
    if (waitSecs === null) return; // no error banner visible

    const elapsedMs = lastPostAttemptTime > 0
      ? Date.now() - lastPostAttemptTime
      : 0;
    const elapsedSecs = elapsedMs / 1000;

    const trueSecs = waitSecs + elapsedSecs;
    baseCooldownMs = Math.max(trueSecs * 1000, DEFAULT_COOLDOWN_MS);

    console.warn(
      `[AttentionSpam] Rate-limit detected — wait=${waitSecs}s, elapsed=${elapsedSecs.toFixed(1)}s. ` +
      `New base cooldown: ${(baseCooldownMs / 1000).toFixed(1)}s`
    );
  }

  /**
   * Returns a cooldown duration in ms with humanizer jitter applied.
   * @returns {number}
   */
  function getCooldownWithJitter() {
    const jitter =
      Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1)) +
      JITTER_MIN_MS;
    return baseCooldownMs + jitter;
  }

  /* =========================================================
     CHAT INPUT MANIPULATION
     ========================================================= */

  /**
   * Reads the current text from the contenteditable chat input.
   * Returns an empty string if the element cannot be found.
   *
   * @returns {string}
   */
  function captureInputText() {
    const input = getChatInput();
    if (!input) return "";
    return (input.innerText || input.textContent || "").trim();
  }

  /**
   * Injects text into the contenteditable chat input in a way that
   * YouTube's Polymer/lit-element framework can detect.
   * Uses execCommand for maximum compatibility with contenteditable elements.
   *
   * @param {string} text
   */
  function setInputText(text) {
    const input = getChatInput();
    if (!input) return;

    // Focus the element first
    input.focus();

    // Select all existing content
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);

    // Insert new text — execCommand triggers framework change detection
    document.execCommand("insertText", false, text);

    // Dispatch a synthetic 'input' event as a safety fallback
    input.dispatchEvent(
      new Event("input", { bubbles: true, composed: true })
    );
  }

  /**
   * Clears the contenteditable chat input.
   */
  function clearInput() {
    const input = getChatInput();
    if (!input) return;
    input.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand("delete", false);
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  }

  /**
   * Programmatically clicks the Send button to submit the message.
   * Records the attempt timestamp for smart-adjuster calculations.
   */
  function clickSendButton() {
    const btn = getSendButton();
    if (!btn) return;
    lastPostAttemptTime = Date.now();
    btn.click();
  }

  /* =========================================================
     HINT BANNER
     ========================================================= */

  let hintBanner = null;

  /**
   * Creates and injects the hint banner above the chat input container.
   * Does nothing if the banner already exists.
   */
  function injectHintBanner() {
    if (document.getElementById("attentionspam-hint")) return;

    const container = getChatInputContainer();
    if (!container) return;

    hintBanner = document.createElement("div");
    hintBanner.id = "attentionspam-hint";
    hintBanner.setAttribute("role", "status");
    hintBanner.setAttribute("aria-live", "polite");
    hintBanner.textContent = HINT_TEXT_IDLE;

    // Insert the banner as the first child of the container,
    // placing it visually above the input row.
    container.insertBefore(hintBanner, container.firstChild);
  }

  /**
   * Shows the hint banner with the specified text state.
   * @param {'idle'|'looping'} state
   */
  function showHint(state) {
    if (!hintBanner) injectHintBanner();
    if (!hintBanner) return;

    hintBanner.textContent =
      state === "looping" ? HINT_TEXT_LOOPING : HINT_TEXT_IDLE;

    hintBanner.classList.remove("looping");
    if (state === "looping") hintBanner.classList.add("looping");

    // Trigger CSS transition by first removing then adding .visible
    hintBanner.classList.remove("visible");
    // rAF ensures the browser registers the removal before re-adding
    requestAnimationFrame(() => hintBanner.classList.add("visible"));
  }

  /**
   * Hides the hint banner.
   */
  function hideHint() {
    if (!hintBanner) return;
    hintBanner.classList.remove("visible", "looping");
  }

  /* =========================================================
     INPUT OBSERVER — show hint when the user starts typing
     ========================================================= */

  function attachInputObserver() {
    const input = getChatInput();
    if (!input || input._attentionSpamObserved) return;
    input._attentionSpamObserved = true;

    input.addEventListener("input", () => {
      const text = captureInputText();
      if (text.length > 0 && !isLooping) {
        showHint("idle");
      } else if (text.length === 0 && !isLooping) {
        hideHint();
      }
    });

    // Also hide when the input is manually cleared (e.g., user presses Escape)
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !isLooping) hideHint();
    });
  }

  /* =========================================================
     LOOP ENGINE
     ========================================================= */

  /**
   * Executes one iteration of the automation loop:
   *  1. Re-insert the captured text into the chat input.
   *  2. Click Send.
   *  3. Check for YouTube error banners and adjust cooldown.
   *  4. Schedule the next iteration with humanizer jitter.
   *
   * @param {string} capturedText — the text to keep re-sending
   */
  function runLoopIteration(capturedText) {
    if (!isLooping) return;

    // Re-populate the input with the captured text
    setInputText(capturedText);

    // Post the message
    clickSendButton();

    // After a short delay (enough for YT to render any error banner),
    // check for rate-limit messages and adjust cooldown accordingly.
    setTimeout(() => {
      smartAdjustCooldown();

      if (!isLooping) return;

      const delay = getCooldownWithJitter();
      console.info(
        `[AttentionSpam] Next iteration in ${(delay / 1000).toFixed(2)}s`
      );

      loopTimeoutId = setTimeout(() => {
        runLoopIteration(capturedText);
      }, delay);
    }, 1200); // 1.2 s — gives YT time to show error banners
  }

  /**
   * Starts the automation loop.
   */
  function startLoop() {
    if (isLooping) return;

    const capturedText = captureInputText();
    if (!capturedText) {
      console.warn("[AttentionSpam] Cannot start loop — chat input is empty.");
      return;
    }

    isLooping = true;
    showHint("looping");

    // Refresh cooldown from slow-mode banner before the first post
    initCooldownFromSlowMode();

    console.info(`[AttentionSpam] Loop STARTED. Message: "${capturedText}"`);

    runLoopIteration(capturedText);
  }

  /**
   * Stops the automation loop.
   */
  function stopLoop() {
    if (!isLooping) return;
    isLooping = false;

    if (loopTimeoutId !== null) {
      clearTimeout(loopTimeoutId);
      loopTimeoutId = null;
    }

    console.info("[AttentionSpam] Loop STOPPED.");
    showHint("idle");
  }

  /* =========================================================
     LONG-PRESS DETECTION ON SEND BUTTON
     ========================================================= */

  /**
   * Attaches long-press event listeners to the Send button.
   * - mousedown / touchstart: start a 1.5 s timer.
   * - mouseup / touchend / mouseleave: cancel the timer.
   * - If the timer fires, toggle the loop (no click event is fired).
   * - If the user releases before 1.5 s, the normal click propagates.
   */
  function attachSendButtonListeners() {
    const btn = getSendButton();
    if (!btn || btn._attentionSpamListened) return;
    btn._attentionSpamListened = true;

    /**
     * Fires when a long-press is confirmed (timer expires).
     * We stop propagation to prevent a normal message send.
     */
    function onLongPressConfirmed(e) {
      // Prevent the click from propagating to YouTube's handler
      btn.addEventListener("click", suppressNextClick, { once: true, capture: true });

      if (isLooping) {
        stopLoop();
      } else {
        startLoop();
      }
    }

    function suppressNextClick(e) {
      e.stopImmediatePropagation();
      e.preventDefault();
    }

    function startLongPressTimer(e) {
      // Only respond to primary mouse button or touch
      if (e.button !== undefined && e.button !== 0) return;

      longPressStartTime = Date.now();
      longPressTimerId = setTimeout(() => {
        longPressTimerId = null;
        onLongPressConfirmed(e);
      }, LONG_PRESS_THRESHOLD_MS);
    }

    function cancelLongPressTimer() {
      if (longPressTimerId !== null) {
        clearTimeout(longPressTimerId);
        longPressTimerId = null;
      }
    }

    btn.addEventListener("mousedown", startLongPressTimer, { capture: false });
    btn.addEventListener("touchstart", startLongPressTimer, {
      capture: false,
      passive: true,
    });

    btn.addEventListener("mouseup", cancelLongPressTimer, { capture: false });
    btn.addEventListener("mouseleave", cancelLongPressTimer, {
      capture: false,
    });
    btn.addEventListener("touchend", cancelLongPressTimer, {
      capture: false,
      passive: true,
    });
    btn.addEventListener("touchcancel", cancelLongPressTimer, {
      capture: false,
      passive: true,
    });

    console.info("[AttentionSpam] Send button listeners attached.");
  }

  /* =========================================================
     EARLY-EXIT GUARD
     all_frames:true injects this script into every frame on the
     page — including sandboxed ad iframes and cross-origin frames
     where APIs like customElements may be null or inaccessible.

     ALL THREE conditions must pass before any observer, API call,
     or DOM lifecycle hook is executed:
       1. URL contains "/live_chat"         — correct iframe document.
       2. customElements !== undefined/null — API is available.
       3. Hostname belongs to youtube.com   — correct origin.

     A direct `return` exits the outer attentionSpam() IIFE silently
     with zero console output, which is the correct behaviour for
     sandboxed or cross-origin frames that should be ignored.
     ========================================================= */

  // Condition 1 — must be the live-chat iframe URL
  const _isLiveChatUrl = window.location.href.includes("/live_chat");

  // Condition 2 — customElements must be defined and non-null.
  // Sandboxed / cross-origin frames can expose this as null or undefined,
  // which would cause a TypeError on customElements.whenDefined().
  const _hasCustomElements =
    typeof customElements !== "undefined" && customElements !== null;

  // Condition 3 — hostname must be youtube.com or a subdomain.
  // Guards against any embedded third-party ad / widget iframe.
  const _isYouTubeHost =
    typeof window.location.hostname === "string" &&
    (window.location.hostname === "youtube.com" ||
      window.location.hostname.endsWith(".youtube.com"));

  if (!_isLiveChatUrl || !_hasCustomElements || !_isYouTubeHost) {
    // Silent early exit — this frame is not the live-chat context.
    // `return` here exits the outer attentionSpam() IIFE directly;
    // no error is thrown and no console output is produced.
    return;
  }

  /* =========================================================
     INITIALIZATION — poll + Polymer-aware setup
     ========================================================= */

  let initPollId = null;
  let initComplete = false;

  /**
   * Core setup: attach all listeners and inject the banner.
   *
   * Runs indefinitely on each poll tick until BOTH the chat input
   * and Send button are verified as real HTMLElement instances in
   * the DOM. No hard cap — YouTube's Polymer rendering pipeline
   * can upgrade components at any point after document_idle.
   *
   * Re-entry safety: each sub-function checks its own
   * _attentionSpamListened / _attentionSpamObserved flag, so even
   * if init() is called again by the MutationObserver during a
   * dynamic DOM mutation, no listener is ever bound twice.
   */
  function init() {
    // Guard: only run once. initComplete is set to true on the
    // first successful setup and never reset during the session.
    if (initComplete) return;

    const input = getChatInput();
    const btn   = getSendButton();

    // Validate that both elements are genuine, fully-upgraded DOM nodes.
    // A Polymer custom element may be present in the tree as a stub
    // before its class is applied — instanceof HTMLElement filters those out.
    const inputReady = input instanceof HTMLElement;
    const btnReady   = btn   instanceof HTMLElement;

    if (!inputReady || !btnReady) {
      // Elements not ready yet — keep polling silently.
      return;
    }

    // Both elements are verified — stop the fallback poll and set up.
    clearInterval(initPollId);
    initComplete = true;

    injectHintBanner();
    attachInputObserver();
    attachSendButtonListeners();
    initCooldownFromSlowMode();

    console.info("[AttentionSpam] Initialized successfully.");
  }

  /**
   * MutationObserver callback — re-attaches listeners when YouTube
   * replaces DOM subtrees during SPA navigation or Polymer upgrades.
   */
  function handleDOMChanges(mutations) {
    let hasAddedNodes = false;
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) { hasAddedNodes = true; break; }
    }
    if (!hasAddedNodes) return;

    // If we haven't finished init yet, attempt it now
    if (!initComplete) {
      init();
      return;
    }

    // Re-attach anything that was torn down during SPA navigation
    const btn = getSendButton();
    if (btn && !btn._attentionSpamListened) {
      attachSendButtonListeners();
    }

    const input = getChatInput();
    if (input && !input._attentionSpamObserved) {
      attachInputObserver();
    }

    // Re-inject the hint banner if the DOM replaced it
    if (!document.getElementById("attentionspam-hint")) {
      hintBanner = null;
      injectHintBanner();
      if (isLooping) showHint("looping");
    }
  }

  /* ---------------------------------------------------------
     Start MutationObserver immediately — anchor to
     documentElement so we catch mutations even before <body>
     is appended (Polymer upgrades happen in early microtasks).
     --------------------------------------------------------- */
  const domObserver = new MutationObserver(handleDOMChanges);

  function startObserver() {
    // Prefer body for tighter subtree scope; fall back to documentElement
    const root = document.body || document.documentElement;
    domObserver.observe(root, { childList: true, subtree: true });
  }

  startObserver();

  // If body wasn't available yet, re-anchor once it appears
  if (!document.body) {
    const bodyWatcher = new MutationObserver(() => {
      if (document.body) {
        bodyWatcher.disconnect();
        // Re-observe with the now-available body as root
        domObserver.disconnect();
        startObserver();
      }
    });
    bodyWatcher.observe(document.documentElement, { childList: true });
  }

  /* ---------------------------------------------------------
     Polymer customElements.whenDefined() — precise upgrade hook.
     Fires the exact moment YouTube's chat input component is
     upgraded from HTMLElement to its full Polymer class, which
     is when shadow DOM / contenteditable children become queryable.
     --------------------------------------------------------- */
  if (typeof customElements !== "undefined" && customElements !== null && customElements.whenDefined) {
    // Primary component containing the contenteditable input
    customElements.whenDefined("yt-live-chat-text-input-field").then(() => {
      console.info(
        "[AttentionSpam] yt-live-chat-text-input-field upgraded — running init."
      );
      // Small rAF delay to let Polymer finish rendering its shadow DOM
      requestAnimationFrame(() => requestAnimationFrame(init));
    }).catch(() => {});

    // Secondary component (some YouTube builds use this wrapper)
    customElements.whenDefined("yt-live-chat-message-input-renderer").then(() => {
      requestAnimationFrame(() => requestAnimationFrame(init));
    }).catch(() => {});
  }

  /* ---------------------------------------------------------
     Belt-and-suspenders: setInterval poll as final fallback
     in case both the observer and whenDefined path miss the
     window (e.g., component already upgraded before script ran).
     --------------------------------------------------------- */
  initPollId = setInterval(init, INIT_POLL_INTERVAL_MS);

  // Attempt immediately — succeeds if elements are already in the DOM
  init();
})();
