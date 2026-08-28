import { AppState, type AppStateStatus } from 'react-native'

/*
A diagnostic trail for a terminal that stops responding: output stops painting
and touch stops scrolling at the same moment, and leaving the session is the
only thing that brings it back.

The two symptoms together point at the WebView's document being dead while the
app still believes it is ready — the app posts writes into a document that
cannot paint them, and touch lands on a page with no JS to handle it. Nothing
detects that today: readiness is only ever re-checked on mount, on load start,
on the content-process-terminate callback (which Apple does not deliver for a
merely wedged page), and on returning from the background.

So the file records what can distinguish that from every other explanation:
how long since the WebView last said anything, against how many messages were
posted into it in the meantime. A document that is alive answers; one that is
dead goes quiet while the posts keep climbing.

Written to Documents so it can be pulled off the device over the network with
`devicectl device copy from` — no cable, and nothing for the user to copy by
hand. It holds counters, flags and lengths; never terminal content.
*/

const MAX_ENTRIES = 500
const FLUSH_INTERVAL_MS = 3000
const SAMPLE_INTERVAL_MS = 5000
const FILE_NAME = 'orca-terminal-liveness.log'
const PREVIOUS_FILE_NAME = 'orca-terminal-liveness.prev.log'

type Fields = Record<string, string | number | boolean | null | undefined>

const entries: string[] = []
let dirty = false
let flushTimer: ReturnType<typeof setInterval> | null = null
let sampleTimer: ReturnType<typeof setInterval> | null = null
let started = false

/** Counters the sampler reads. Kept as plain numbers so the hot paths that bump
 *  them — every message in or out of a WebView delivering ~200 frames/s — cost
 *  an increment and nothing else. */
const counters = {
  posted: 0,
  received: 0,
  postedSinceReceived: 0,
  lastReceivedAt: 0,
  lastHeartbeatAt: 0,
  heartbeats: 0,
  ready: false,
  connState: 'unknown' as string,
  appState: 'unknown' as string
}

function stamp(): string {
  return new Date().toISOString().slice(11, 23)
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

/** A message arrived from a WebView document. This is the liveness signal: a
 *  wedged or dead document stops producing these while everything else looks
 *  normal. */
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
export function noteTerminalHeartbeat(): void {
  counters.heartbeats += 1
  counters.lastHeartbeatAt = Date.now()
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

function sample(): void {
  const sinceReceivedMs = counters.lastReceivedAt === 0 ? -1 : Date.now() - counters.lastReceivedAt
  logTerminalLiveness('sample', {
    ready: counters.ready,
    // The decisive one: over ~2s means at least one document stopped ticking.
    sinceHbMs: counters.lastHeartbeatAt === 0 ? -1 : Date.now() - counters.lastHeartbeatAt,
    heartbeats: counters.heartbeats,
    sinceWebMsgMs: sinceReceivedMs,
    postedSinceWebMsg: counters.postedSinceReceived,
    posted: counters.posted,
    received: counters.received,
    app: counters.appState,
    conn: counters.connState
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
  counters.appState = AppState.currentState
  AppState.addEventListener('change', (next: AppStateStatus) => {
    counters.appState = next
    logTerminalLiveness('appstate', { state: next })
    // Flush on the way out: a session that never returns still leaves its trail.
    flush()
  })
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS)
  sampleTimer = setInterval(sample, SAMPLE_INTERVAL_MS)
}

export function stopTerminalLivenessLog(): void {
  if (flushTimer) {
    clearInterval(flushTimer)
    flushTimer = null
  }
  if (sampleTimer) {
    clearInterval(sampleTimer)
    sampleTimer = null
  }
  flush()
  started = false
}
