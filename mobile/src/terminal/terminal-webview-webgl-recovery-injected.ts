// WebGL loss and visibility recovery injected into the terminal WebView IIFE.
// It closes over term, terminalGeneration, theme state, and xterm's addon global.
export const TERMINAL_WEBGL_RECOVERY_JS = `
  function refreshTerminalSurface() {
    if (!term) return;
    try { term.refresh(0, Math.max(0, term.rows - 1)); } catch (e) {}
  }

  function cancelWebglContextRecovery() {
    if (!webglRecoveryTimer) return;
    clearTimeout(webglRecoveryTimer);
    webglRecoveryTimer = null;
  }

  function attachWebglAddon(allowRecovery) {
    if (!term || !window.WebglAddon || !window.WebglAddon.WebglAddon) return false;
    var addon = null;
    try {
      addon = new window.WebglAddon.WebglAddon();
      webglAddon = addon;
      if (addon.onContextLoss) addon.onContextLoss(function() {
        if (webglAddon !== addon) return;
        flog('webgl-context-loss', { retry: allowRecovery });
        webglAddon = null;
        try { addon.dispose(); } catch (e) {}
        refreshTerminalSurface();
        if (!allowRecovery) return;
        // Why: one delayed retry handles transient iOS context loss without
        // entering a GPU crash loop; a second loss stays on the DOM renderer.
        cancelWebglContextRecovery();
        var recoveryTerm = term;
        var recoveryGeneration = terminalGeneration;
        webglRecoveryTimer = setTimeout(function() {
          webglRecoveryTimer = null;
          if (term !== recoveryTerm || terminalGeneration !== recoveryGeneration) return;
          attachWebglAddon(false);
        }, 100);
      });
      term.loadAddon(addon);
      if (!allowRecovery) {
        try { if (addon.clearTextureAtlas) addon.clearTextureAtlas(); } catch (e) {}
        refreshTerminalSurface();
      }
      return true;
    } catch (e) {
      flog('webgl-attach-failed', { retry: !allowRecovery, message: String(e) });
      if (webglAddon === addon) webglAddon = null;
      try { if (addon) addon.dispose(); } catch (disposeError) {}
      refreshTerminalSurface();
      return false;
    }
  }

  // Everything the visibility path below does, plus a nudge to the write queue,
  // since a stuck queue and dropped GPU pixels look identical from the outside.
  //
  // Safe to call on a healthy terminal, which is what lets the app run it on
  // every activation rather than only from the recovery button: pumpWrites
  // releases a drain only once it has been stalled past the watchdog threshold,
  // so a write genuinely mid-parse is never raced by a second one.
  function forceTerminalRepaint() {
    pumpWrites(terminalGeneration);
    applyTerminalTheme(terminalThemeInput);
    try { if (webglAddon && webglAddon.clearTextureAtlas) webglAddon.clearTextureAtlas(); } catch (e) {}
    refreshTerminalSurface();
    flog('forced-repaint', { gen: terminalGeneration, queued: writeQueue.length - writeQueueHead });
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState !== 'visible') return;
    // Why: iOS may restore the xterm model while discarding GPU pixels/theme
    // paint state, so visibility must rebuild the atlas and repaint every row.
    applyTerminalTheme(terminalThemeInput);
    try { if (webglAddon && webglAddon.clearTextureAtlas) webglAddon.clearTextureAtlas(); } catch (e) {}
    refreshTerminalSurface();
  });
`
