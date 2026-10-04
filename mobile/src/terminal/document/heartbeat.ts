import type { TerminalDocumentScope } from './document-scope'
import { notify } from './host-notify'
import { pumpWrites, WRITE_DRAIN_STALL_MS, writeDrainStalledMs } from './write-queue'

/*
Diagnostics: proof of life from inside the document, carrying the state that decides whether it
can paint. A WebView iOS has stopped rendering still runs setInterval, so the tick keeps arriving,
writes keep parsing and the buffer keeps updating while the screen holds its last frame — the
exact shape of the fault this exists to catch.
*/
const HEARTBEAT_MS = 2000

export type TerminalHeartbeatState = {
  timer: ReturnType<typeof setInterval>
  seq: number
  rafTicks: number
  rafPending: boolean
  rafRequestedAt: number
  renders: number
  renderTerm: unknown
  lastApplied: number
  lastRenders: number
  renderStall: number
}

/** What xterm holds around the cursor: text here but not on screen is a painting fault. */
function describeCursorRows(scope: TerminalDocumentScope) {
  const term = scope.term
  if (!term || !term.buffer || !term.buffer.active) {
    return 'no-buffer'
  }
  const buf = term.buffer.active
  const y = buf.cursorY
  // vp moving while the screen does not is the scroll half of the fault; gl says which renderer.
  let out =
    'y=' +
    y +
    ' x=' +
    (buf.cursorX ?? -1) +
    ' base=' +
    buf.baseY +
    ' len=' +
    buf.length +
    ' vp=' +
    buf.viewportY +
    ' gl=' +
    (scope.webglAddon ? 1 : 0)
  for (let r = Math.max(0, y - 1); r <= y + 1; r++) {
    const line = buf.getLine(buf.baseY + r)
    const text = line ? line.translateToString(true) : ''
    if (text.length > 0) {
      out += ' [' + r + ']' + text.slice(0, 44)
    }
  }
  return out
}

/*
One frame requested per tick, not chained frame to frame: a self-renewing chain keeps the page
painting (changing what is measured). Reported as the age of an outstanding request, since one
probe per 2s tick makes time-since-last-frame read ~2000 even when every frame arrives.
*/
function probeAnimationFrame(hb: TerminalHeartbeatState) {
  if (hb.rafPending) {
    return
  }
  hb.rafPending = true
  hb.rafRequestedAt = Date.now()
  requestAnimationFrame(function () {
    hb.rafPending = false
    hb.rafTicks += 1
  })
}

/** rAF firing proves the page rendered; onRender proves xterm used it. */
function trackTerminalRenders(scope: TerminalDocumentScope, hb: TerminalHeartbeatState) {
  const term = scope.term
  if (!term || term === hb.renderTerm || !term.onRender) {
    return
  }
  hb.renderTerm = term
  try {
    term.onRender(function () {
      hb.renders += 1
    })
  } catch {}
}

/** Output landing in the buffer while nothing paints, counted in ticks so one busy parse is not a stall. */
function trackRenderStall(scope: TerminalDocumentScope, hb: TerminalHeartbeatState) {
  const painted = hb.renders !== hb.lastRenders
  const wrote = scope.writesApplied !== hb.lastApplied
  hb.renderStall = wrote && !painted ? hb.renderStall + 1 : 0
  hb.lastApplied = scope.writesApplied
  hb.lastRenders = hb.renders
}

function tick(scope: TerminalDocumentScope, hb: TerminalHeartbeatState) {
  hb.seq += 1
  trackTerminalRenders(scope, hb)
  trackRenderStall(scope, hb)
  probeAnimationFrame(hb)
  // The tick doubles as the nudge: nothing else calls pumpWrites once the queue has stalled.
  const stalledMs = writeDrainStalledMs(scope)
  if (stalledMs > WRITE_DRAIN_STALL_MS) {
    pumpWrites(scope, scope.terminalGeneration)
  }
  notify(scope, {
    type: 'heartbeat',
    seq: hb.seq,
    stalledMs: stalledMs,
    rows: scope.term ? scope.term.rows : -1,
    cursorLine: describeCursorRows(scope),
    rafMs: hb.rafPending ? Date.now() - hb.rafRequestedAt : 0,
    rafs: hb.rafTicks,
    renders: hb.renders,
    applied: scope.writesApplied,
    renderStall: hb.renderStall,
    vis: document.visibilityState,
    ready: !!scope.ready,
    gen: scope.terminalGeneration,
    queued: scope.writeQueue.length - scope.writeQueueHead,
    draining: !!scope.writesDraining
  })
}

export function startHeartbeat(scope: TerminalDocumentScope) {
  const hb: TerminalHeartbeatState = {
    timer: setInterval(function () {
      tick(scope, hb)
    }, HEARTBEAT_MS),
    seq: 0,
    rafTicks: 0,
    rafPending: false,
    rafRequestedAt: 0,
    renders: 0,
    renderTerm: null,
    lastApplied: 0,
    lastRenders: 0,
    renderStall: 0
  }
  scope.heartbeat = hb
}

export function stopHeartbeat(scope: TerminalDocumentScope) {
  if (scope.heartbeat) {
    clearInterval(scope.heartbeat.timer)
    scope.heartbeat = null
  }
}
