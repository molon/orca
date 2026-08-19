type TerminalLiveMirrorSender = (handle: string, payload: string) => Promise<boolean>

/** An edit to the terminal's input line: drop this many trailing code points, then type this. */
export type TerminalLiveMirrorEdit = {
  readonly eraseCount: number
  readonly appendText: string
}

type TerminalLivePendingRequest = {
  readonly resolve: (sent: boolean) => void
}

type TerminalLivePendingBatch = {
  readonly handle: string
  edit: TerminalLiveMirrorEdit
  readonly requests: TerminalLivePendingRequest[]
  readonly sender: TerminalLiveMirrorSender
}

const TERMINAL_DEL_BYTE = '\x7f'

/**
 * The single edit equivalent to `first` then `second`.
 *
 * Why compose rather than concatenate the bytes: dictation revises its own
 * transcript several times a second, and every revision that lands while a send
 * is in flight would otherwise be replayed on the terminal — each intermediate
 * guess drawn and erased. Composing them means only states the text actually
 * reached are ever drawn.
 */
export function composeTerminalLiveMirrorEdits(
  first: TerminalLiveMirrorEdit,
  second: TerminalLiveMirrorEdit
): TerminalLiveMirrorEdit {
  const appended = Array.from(first.appendText)
  // The second edit erases what the first typed before it can reach the line.
  const fromAppended = Math.min(second.eraseCount, appended.length)
  return {
    eraseCount: first.eraseCount + (second.eraseCount - fromAppended),
    appendText: appended.slice(0, appended.length - fromAppended).join('') + second.appendText
  }
}

export function buildTerminalLiveMirrorEditPayload(edit: TerminalLiveMirrorEdit): string {
  return TERMINAL_DEL_BYTE.repeat(edit.eraseCount) + edit.appendText
}

export type TerminalLivePendingFlushState = {
  current: Promise<boolean> | null
  activeRequests: TerminalLivePendingRequest[]
  generation: number
  pendingBatches: TerminalLivePendingBatch[]
}

export function createTerminalLivePendingFlushState(): TerminalLivePendingFlushState {
  return {
    current: null,
    activeRequests: [],
    generation: 0,
    pendingBatches: []
  }
}

export function waitForTerminalLivePendingFlush(
  state: TerminalLivePendingFlushState
): Promise<boolean> {
  return state.current ?? Promise.resolve(true)
}

export function cancelTerminalLivePendingFlush(state: TerminalLivePendingFlushState): void {
  state.generation += 1
  const requests = [
    ...state.activeRequests,
    ...state.pendingBatches.flatMap((batch) => batch.requests)
  ]
  state.activeRequests = []
  state.pendingBatches = []
  state.current = null
  requests.forEach(({ resolve }) => resolve(false))
}

async function drainTerminalLiveMirrorSends(
  state: TerminalLivePendingFlushState,
  generation: number
): Promise<boolean> {
  let allSent = true
  while (state.generation === generation) {
    const batch = state.pendingBatches.shift()
    if (!batch) {
      state.current = null
      return allSent
    }

    state.activeRequests = batch.requests
    const sent = await batch
      .sender(batch.handle, buildTerminalLiveMirrorEditPayload(batch.edit))
      .catch(() => false)
    if (state.generation !== generation) {
      return false
    }

    state.activeRequests = []
    batch.requests.forEach(({ resolve }) => resolve(sent))
    allSent &&= sent
  }
  return false
}

// Mirror deltas are ordered PTY edits; composing pending ones avoids an RTT per
// keystroke and keeps intermediate text off the terminal entirely.
export function queueTerminalLiveMirrorSend(
  state: TerminalLivePendingFlushState,
  handle: string,
  edit: TerminalLiveMirrorEdit,
  sender: TerminalLiveMirrorSender
): Promise<boolean> {
  let resolveRequest: (sent: boolean) => void = () => {}
  const request = new Promise<boolean>((resolve) => {
    resolveRequest = resolve
  })
  const pendingTail = state.pendingBatches.at(-1)
  if (pendingTail?.handle === handle && pendingTail.sender === sender) {
    pendingTail.edit = composeTerminalLiveMirrorEdits(pendingTail.edit, edit)
    pendingTail.requests.push({ resolve: resolveRequest })
  } else {
    state.pendingBatches.push({
      handle,
      edit,
      requests: [{ resolve: resolveRequest }],
      sender
    })
  }

  if (!state.current) {
    const generation = state.generation
    const drain = drainTerminalLiveMirrorSends(state, generation).catch(() => false)
    state.current = drain
    void drain.then(() => {
      if (state.current === drain) {
        state.current = null
      }
    })
  }
  return request
}
