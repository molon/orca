/*
Diagnostics for a terminal that stops painting and stops scrolling together,
which only leaving the session clears.

Records what separates the possible causes: whether the document still ticks,
whether writes reached it, what its own render state says, and what its buffer
holds. Written to Documents so it can be pulled with `devicectl device copy
from` — no cable, nothing for the user to copy by hand.
*/

/* Two thousand, because the first capture taught the lesson the hard way: at one
 * line per keystroke the ring held about a hundred seconds, and the failure it
 * was built to catch had already scrolled out of it by the time it was read. */
const MAX_ENTRIES = 4000
const SAMPLE_INTERVAL_MS = 5000
const FILE_NAME = 'orca-terminal-liveness.log'
const PREVIOUS_FILE_NAME = 'orca-terminal-liveness.prev.log'

type Fields = Record<string, string | number | boolean | null | undefined>

const entries: string[] = []
let dirty = false
let started = false

/** Plain numbers: the hot paths bumping them run at ~200 frames/s. */
const counters = {
  posted: 0,
  received: 0,
  postedSinceReceived: 0,
  lastReceivedAt: 0,
  lastHeartbeatAt: 0,
  heartbeats: 0,
  ready: false,
  sends: 0,
  sendsAccepted: 0,
  sendsFailed: 0,
  connState: 'unknown' as string,
  appState: 'unknown' as string
}

function stamp(): string {
  // Local time, not UTC: the person reading this lives in one timezone and
  // reports "it just happened", and making them add hours in their head to line
  // that up against the log is a step where mistakes get made.
  const now = new Date()
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(
    now.getMilliseconds(),
    3
  )}`
}

function push(line: string): void {
  entries.push(line)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  dirty = true
}

export function logTerminalLiveness(event: string, fields?: Fields): void {
  const rendered = fields
    ? Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
    : ''
  push(`${stamp()} ${event}${rendered ? ` ${rendered}` : ''}`)
}

/** Any message from a document — the coarse liveness signal. */
export function noteTerminalWebViewMessage(): void {
  counters.received += 1
  counters.postedSinceReceived = 0
  counters.lastReceivedAt = Date.now()
}

export function noteTerminalWebViewPost(): void {
  counters.posted += 1
  counters.postedSinceReceived += 1
}

/** A tick from inside a document. Unlike an ordinary message this one is not
 *  conditional on anything happening, so a gap in it means the page stopped
 *  running — the one reading a silent WebView otherwise does not have. */
/* Per document, because the global count could not answer the question that
 * decides the fix: iOS throttles timers in a WebView it is not showing, so a
 * hidden pane going quiet is expected and harmless. Only the visible one
 * falling silent is the bug the user sees. */
const HEARTBEAT_GAP_MS = 4000

export type TerminalPageState = {
  cursorLine: string
  /** Age of a frame the page asked for and has not been given. xterm paints
   *  from one, so this climbing while heartbeats keep arriving is the fault. */
  rafMs: number
  renders: number
  applied: number
  renderStall: number
  ready: boolean
  gen: number
  queued: number
  draining: boolean
}
type DocumentTick = {
  at: number
  active: boolean
  gapReported: boolean
  page?: TerminalPageState
}
const documents = new Map<string, DocumentTick>()

function samePageState(a: TerminalPageState | undefined, b: TerminalPageState): boolean {
  return (
    a !== undefined &&
    a.ready === b.ready &&
    a.cursorLine === b.cursorLine &&
    a.gen === b.gen &&
    a.queued === b.queued &&
    a.draining === b.draining
  )
}

/* A page that has stopped painting still runs its timers, so this needs its own
 * line rather than a field on a sample: the samples get crowded out of the ring
 * by output, a handful of stall markers do not.
 *
 * Two ways to arrive at a frozen screen, one marker. rafMs catches a page iOS
 * has stopped giving frames to; renderStall catches xterm parsing chunk after
 * chunk without repainting, which is the freeze as the user sees it — output
 * lands in the buffer and the screen keeps the old picture. */
const RAF_STALL_MS = 1500
const RENDER_STALL_TICKS = 2
const paintStalled = new Set<string>()

function notePaintStall(handle: string, active: boolean, page: TerminalPageState): void {
  const stalled = page.rafMs > RAF_STALL_MS || page.renderStall >= RENDER_STALL_TICKS
  if (stalled === paintStalled.has(handle)) {
    return
  }
  paintStalled[stalled ? 'add' : 'delete'](handle)
  const { rafMs, renders, applied, renderStall } = page
  const event = stalled ? 'paint-stall' : 'paint-resumed'
  const h = handle.slice(-8)
  logTerminalLiveness(event, { handle: h, active, rafMs, renders, applied, renderStall })
}

/** Coerced here, not at the call site: that file is at its line limit. */
function readPageState(raw: Record<string, unknown>): TerminalPageState {
  const num = (value: unknown): number => (typeof value === 'number' ? value : -1)
  return {
    cursorLine: typeof raw.cursorLine === 'string' ? raw.cursorLine : '',
    rafMs: num(raw.rafMs),
    renders: num(raw.renders),
    applied: num(raw.applied),
    renderStall: num(raw.renderStall),
    ready: raw.ready === true,
    gen: num(raw.gen),
    queued: num(raw.queued),
    draining: raw.draining === true
  }
}

export function noteTerminalHeartbeat(
  handle: string,
  active: boolean,
  raw?: Record<string, unknown>
): void {
  const page = raw ? readPageState(raw) : undefined
  const now = Date.now()
  const previous = documents.get(handle)
  // A gap gets its own line so the evidence outlives the ring: samples can be
  // crowded out, a handful of gap markers cannot.
  if (previous && now - previous.at > HEARTBEAT_GAP_MS) {
    logTerminalLiveness('hb-gap-ended', {
      handle,
      active: previous.active,
      silentMs: now - previous.at
    })
  }
  // A change in what the page says about itself is the event worth a line:
  // `ready` going false and never coming back is the failure being hunted.
  if (page) {
    notePaintStall(handle, active, page)
  }
  if (page && !samePageState(previous?.page, page)) {
    logTerminalLiveness('page-state', {
      handle: handle.slice(-8),
      active,
      cursor: JSON.stringify(page.cursorLine),
      rafMs: page.rafMs,
      renders: page.renders,
      applied: page.applied,
      ready: page.ready,
      gen: page.gen,
      queued: page.queued,
      draining: page.draining
    })
  }
  documents.set(handle, { at: now, active, gapReported: false, page })
  counters.heartbeats += 1
  counters.lastHeartbeatAt = now
}

/** Counted rather than written per keystroke: one line each way per key filled
 *  the whole ring in under two minutes and evicted the failure. Only a send
 *  that did not land is worth a line of its own. */
export function noteTerminalSend(outcome: 'attempt' | 'accepted' | 'failed'): void {
  if (outcome === 'attempt') {
    counters.sends += 1
  } else if (outcome === 'accepted') {
    counters.sendsAccepted += 1
  } else {
    counters.sendsFailed += 1
  }
}

/** Bytes delivered per terminal, to tell the on-screen one from the rest. */
const writesByHandle = new Map<string, { bytes: number; chunks: number; active: boolean }>()

/* Small chunks only. Logging every chunk cost two thirds of the ring and left
 * it holding three minutes; skipping the big ones keeps what matters, because a
 * full-screen TUI repaint is never the chunk in question — a keystroke echo is
 * a few dozen bytes, and whether it carries the typed character is the whole
 * difference between the host not echoing and the page not showing. */
const ECHO_LOG_MAX_BYTES = 400

export function noteTerminalWrite(
  handle: string,
  active: boolean,
  bytes: number,
  data?: string
): void {
  const entry = writesByHandle.get(handle) ?? { bytes: 0, chunks: 0, active }
  entry.bytes += bytes
  entry.chunks += 1
  entry.active = active
  writesByHandle.set(handle, entry)
  if (active && data && bytes <= ECHO_LOG_MAX_BYTES) {
    logTerminalLiveness('echo', {
      handle: handle.slice(-8),
      len: bytes,
      data: JSON.stringify(data)
    })
  }
}

/** What the on-screen document says about its own ability to paint. */
function renderActivePage(): string {
  for (const [handle, tick] of documents) {
    if (tick.active && tick.page) {
      const p = tick.page
      return `${handle.slice(-8)} rafMs=${p.rafMs} renders=${p.renders} applied=${
        p.applied
      } stall=${p.renderStall} ready=${p.ready} gen=${p.gen} queued=${p.queued} draining=${
        p.draining
      }`
    }
  }
  return 'none'
}

export function noteTerminalReadiness(ready: boolean): void {
  counters.ready = ready
}

export function noteTerminalConnState(state: string): void {
  if (counters.connState !== state) {
    counters.connState = state
    logTerminalLiveness('conn', { state })
  }
}

/** Compact per-terminal write tally, marking which one is on screen. */
function renderWrites(): string {
  const parts: string[] = []
  for (const [handle, entry] of writesByHandle) {
    parts.push(`${handle.slice(-8)}${entry.active ? '*' : ''}:${entry.chunks}/${entry.bytes}`)
  }
  return parts.length > 0 ? parts.join(',') : 'none'
}

function sample(): void {
  // Report an ongoing gap once per document, while it is still open — the end
  // marker only arrives if that document ever comes back.
  const now = Date.now()
  for (const [handle, tick] of documents) {
    if (now - tick.at > HEARTBEAT_GAP_MS && !tick.gapReported) {
      tick.gapReported = true
      logTerminalLiveness('hb-gap-open', {
        handle,
        active: tick.active,
        silentMs: now - tick.at
      })
    }
  }
  const sinceReceivedMs = counters.lastReceivedAt === 0 ? -1 : Date.now() - counters.lastReceivedAt
  logTerminalLiveness('sample', {
    ready: counters.ready,
    sinceHbMs: counters.lastHeartbeatAt === 0 ? -1 : Date.now() - counters.lastHeartbeatAt,
    heartbeats: counters.heartbeats,
    sends: counters.sends,
    accepted: counters.sendsAccepted,
    failed: counters.sendsFailed,
    sinceWebMsgMs: sinceReceivedMs,
    postedSinceWebMsg: counters.postedSinceReceived,
    posted: counters.posted,
    received: counters.received,
    app: counters.appState,
    conn: counters.connState,
    writes: renderWrites(),
    page: renderActivePage()
  })
}

/* Loaded on first write rather than imported at the top: expo-file-system pulls
 * in expo-modules-core, which needs a React Native runtime to even evaluate. A
 * top-level import makes every unit test that transitively reaches this file
 * fail on `__DEV__ is not defined`, for a module those tests never call. */
let fileSystem: Promise<typeof import('expo-file-system')> | null = null

async function writeEntries(): Promise<void> {
  try {
    fileSystem ??= import('expo-file-system')
    const { File: FsFile, Paths } = await fileSystem
    const file = new FsFile(Paths.document, FILE_NAME)
    if (!file.exists) {
      file.create()
    }
    file.write(`${entries.join('\n')}\n`)
  } catch {
    // Diagnostics must never take the app down with them; a full disk or a
    // sandbox refusal is not worth a crash in the path being diagnosed.
  }
}

function flush(): void {
  if (!dirty) {
    return
  }
  dirty = false
  void writeEntries()
}

/**
 * Begins recording. Safe to call more than once.
 *
 * The previous run's file is kept alongside: a freeze that ends in the app
 * being force-quit would otherwise erase the only evidence of it.
 */
export function startTerminalLivenessLog(): void {
  if (started) {
    return
  }
  started = true
  void (async () => {
    try {
      fileSystem ??= import('expo-file-system')
      const { File: FsFile, Paths } = await fileSystem
      const current = new FsFile(Paths.document, FILE_NAME)
      if (current.exists) {
        const previous = new FsFile(Paths.document, PREVIOUS_FILE_NAME)
        if (previous.exists) {
          previous.delete()
        }
        current.move(previous)
      }
    } catch {
      // A missing or unmovable previous file is not a reason to skip logging.
    }
  })()
  logTerminalLiveness('start', { file: FILE_NAME })
  // App state arrives from the caller instead of being read here. This module
  // keeps no top-level imports — plain logic modules import it, and their tests
  // run without the React Native transform — but importing react-native
  // *dynamically* was worse than either: doing that while RN is still starting
  // crashed the app on launch.
  // No periodic flush. Rewriting the whole ring every few seconds cost about
  // 160KB/s of writes for the entire time a terminal was busy — affordable on a
  // debug build being watched, not on one somebody else is carrying around all
  // day. The trail is written when it is wanted (the snapshot button) and when
  // the app is about to stop running (below), which is the only moment it could
  // otherwise be lost without anyone asking for it.
  setInterval(sample, SAMPLE_INTERVAL_MS)
}

/** Fed by whoever already holds an AppState subscription, so this module never
 *  has to reach for react-native itself. */
export function noteTerminalAppState(state: string): void {
  counters.appState = state
  logTerminalLiveness('appstate', { state })
  // Flush on the way out: a session that never returns still leaves its trail.
  flush()
}

/** The ring itself, for a snapshot that has to outlive it. */
export function readTerminalLivenessEntries(): string[] {
  return entries.slice()
}

/** Every counter and per-document tick, dumped whole rather than summarised:
 *  a snapshot is read once, long after the fault, with no chance to ask again. */
export function describeTerminalLivenessState(): string {
  return [
    '# state',
    `  writes=${renderWrites()}`,
    `  page=${renderActivePage()}`,
    `  counters=${JSON.stringify(counters)}`,
    `  documents=${JSON.stringify([...documents])}`
  ].join('\n')
}
