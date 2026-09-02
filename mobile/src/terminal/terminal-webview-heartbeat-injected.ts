export const TERMINAL_HEARTBEAT_JS = String.raw`
  // Diagnostics: proof of life from inside the document, carrying the state that
  // decides whether it can paint. Geometry, queue depth and byte delivery are
  // already answered: the buffer holds the typed text, the queue drains, and the
  // box fits every row. What is left is whether the page repaints at all.
  // (No backticks in this file: it is one template literal.)
  function describeCursorRows() {
    if (!term || !term.buffer || !term.buffer.active) return 'no-buffer';
    var buf = term.buffer.active;
    var y = buf.cursorY;
    // vp is where the viewport is scrolled to and gl says which renderer is
    // live: a vp that moves while the screen does not is the scroll half of the
    // same fault, and a lost WebGL context is one way to arrive at it.
    var out = 'y=' + y + ' x=' + buf.cursorX + ' base=' + buf.baseY + ' len=' + buf.length +
      ' vp=' + buf.viewportY + ' gl=' + (webglAddon ? 1 : 0);
    for (var r = Math.max(0, y - 1); r <= y + 1; r++) {
      var line = buf.getLine(buf.baseY + r);
      var text = line ? line.translateToString(true) : '';
      if (text.length > 0) out += ' [' + r + ']' + text.slice(0, 44);
    }
    return out;
  }

  // xterm paints from a rAF callback. A WebView iOS has stopped rendering still
  // runs setInterval, so the heartbeat keeps arriving, writes keep parsing and
  // the buffer keeps updating while the screen holds its last frame — the exact
  // shape of the fault. One frame is requested per heartbeat and its age says
  // how long the page has gone unrendered: while frames stop coming the pending
  // request never resolves and the age keeps climbing.
  //
  // Requested per tick rather than chained frame to frame on purpose. A
  // self-renewing chain sits in the frame queue forever, which both keeps the
  // page painting — changing the thing being measured — and displaces the
  // callbacks everything else schedules there.
  //
  // Reported as the age of an *outstanding* request, not as time since the last
  // frame. One probe per two-second tick means time-since-last-frame reads ~2000
  // even when every frame arrives, which drowns a real stall in false ones.
  var orcaRafTicks = 0;
  var orcaRafPending = false;
  var orcaRafRequestedAt = 0;
  function probeAnimationFrame() {
    if (orcaRafPending) return;
    orcaRafPending = true;
    orcaRafRequestedAt = Date.now();
    requestAnimationFrame(function() {
      orcaRafPending = false;
      orcaRafTicks += 1;
    });
  }

  // The other half: rAF firing proves the page is rendered, this proves xterm
  // used it. onRender fires once per painted batch of rows.
  var orcaRenders = 0;
  var orcaRenderTerm = null;
  function trackTerminalRenders() {
    if (!term || term === orcaRenderTerm) return;
    orcaRenderTerm = term;
    try { term.onRender(function() { orcaRenders += 1; }); } catch (e) {}
  }

  // The freeze as the user describes it: output keeps landing in the buffer and
  // the screen keeps showing the old frame. Counted in ticks so a single busy
  // parse between two frames does not read as a stall.
  var orcaLastApplied = 0;
  var orcaLastRenders = 0;
  var orcaRenderStall = 0;
  function trackRenderStall() {
    var painted = orcaRenders !== orcaLastRenders;
    var wrote = writesApplied !== orcaLastApplied;
    orcaRenderStall = wrote && !painted ? orcaRenderStall + 1 : 0;
    orcaLastApplied = writesApplied;
    orcaLastRenders = orcaRenders;
  }

  var orcaHeartbeatSeq = 0;
  setInterval(function() {
    orcaHeartbeatSeq += 1;
    trackTerminalRenders();
    trackRenderStall();
    probeAnimationFrame();
    // The tick doubles as the nudge: nothing else calls pumpWrites once the
    // queue has stalled, so without this the recovery above would never run.
    var stalledMs = writeDrainStalledMs();
    if (stalledMs > WRITE_DRAIN_STALL_MS) pumpWrites(terminalGeneration);
    notify({
      type: 'heartbeat',
      seq: orcaHeartbeatSeq,
      stalledMs: stalledMs,
      rows: term ? term.rows : -1,
      // What xterm actually holds around the cursor: text here but not on screen
      // is a painting fault, no text here means the writes never took effect.
      cursorLine: describeCursorRows(),
      rafMs: orcaRafPending ? Date.now() - orcaRafRequestedAt : 0,
      rafs: orcaRafTicks,
      renders: orcaRenders,
      applied: writesApplied,
      renderStall: orcaRenderStall,
      vis: document.visibilityState,
      ready: !!ready,
      gen: terminalGeneration,
      queued: writeQueue.length - writeQueueHead,
      draining: !!writesDraining
    });
  }, 2000);
`
