export const TERMINAL_WRITE_DRAIN_RECOVERY_JS = String.raw`
  // Why: pumpWrites hands a chunk to term.write() and waits for its callback
  // before sending the next one. That callback can simply never arrive — a
  // surface swap disposes the term that owed it — and writesDraining then stays
  // true for the life of the document. Every later chunk queues behind it, so
  // output stops painting while the page looks perfectly healthy: it answers
  // messages, reports ready, and accepts writes it will never show. Leaving the
  // session and coming back was the only cure, because that built a new
  // document.
  //
  // Recovery rather than prevention: a lost callback has several possible
  // sources and one shared symptom, and a stall that clears itself in a second
  // is worth more than knowing which one it was.
  // 250ms, polled every 100ms while a drain is outstanding. The first version
  // recovered from the 2s heartbeat, which turned a hang into a crawl: ten
  // chunks took eighteen seconds, and output that arrives that late is still
  // "it does not work". The poll costs nothing when nothing is stuck, because
  // it only runs between a write starting and its callback returning.
  var WRITE_DRAIN_STALL_MS = 250;
  var WRITE_DRAIN_POLL_MS = 100;
  var writeDrainStartedAt = 0;
  var writeDrainPoll = null;

  function noteWriteDrainStarted() {
    writeDrainStartedAt = Date.now();
    if (writeDrainPoll !== null) return;
    writeDrainPoll = setInterval(function() {
      if (!writesDraining) {
        clearInterval(writeDrainPoll);
        writeDrainPoll = null;
        return;
      }
      if (writeDrainStalledMs() > WRITE_DRAIN_STALL_MS) pumpWrites(terminalGeneration);
    }, WRITE_DRAIN_POLL_MS);
  }

  // Chunks xterm has finished parsing. Paired against the repaint count it says
  // whether output that landed in the buffer ever reached the screen.
  var writesApplied = 0;

  function noteWriteDrainFinished() {
    writesApplied++;
    writeDrainStartedAt = 0;
    if (writeDrainPoll !== null) {
      clearInterval(writeDrainPoll);
      writeDrainPoll = null;
    }
  }

  function writeDrainStalledMs() {
    if (!writesDraining || writeDrainStartedAt === 0) return 0;
    return Date.now() - writeDrainStartedAt;
  }

  // Returns true when a stalled drain was released, so the caller can pump again.
  function releaseStalledWriteDrain() {
    if (writeDrainStalledMs() <= WRITE_DRAIN_STALL_MS) return false;
    writesDraining = false;
    writeDrainStartedAt = 0;
    return true;
  }
`
