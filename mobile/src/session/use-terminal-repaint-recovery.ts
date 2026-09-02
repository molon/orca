/*
The manual way out of a terminal pane that has stopped updating, and the only
reliable way to capture one.

Both halves matter and their order is the whole point. A frozen pane is noticed,
described, and reported minutes apart from when it froze, by which time the
rolling log has moved on; and the act of unfreezing it destroys the state that
would have explained it. So the trail is captured first, synchronously, and the
repair runs against an already-recorded fault.
*/

import { useCallback, useRef, useState, type RefObject } from 'react'
import { Share } from 'react-native'
import { logTerminalLiveness } from '../terminal/terminal-liveness-log'
import {
  snapshotTerminalLiveness,
  type TerminalSnapshotContext
} from '../terminal/terminal-liveness-snapshot'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

type TerminalRepaintRecoveryOptions = {
  readonly activeHandleRef: RefObject<string | null>
  readonly getTerminalRef: (handle: string | null) => TerminalWebViewHandle | undefined
  readonly describeContext: () => TerminalSnapshotContext
  /** Re-runs the subscription — what leaving the session and returning does,
   *  which is the only cure the user has had so far. */
  readonly resubscribe: (handle: string) => void
  /** Recovery repairs the pane in place, so no handle changes and no effect
   *  re-runs — the field has to be told to show its line again. */
  readonly restoreLiveInputLine: () => void
  readonly showToast: (message: string, durationMs: number) => void
}

/** Shaped as the props the input bar takes, so both bars can spread it: the two
 *  actions and the busy flag only ever travel together. */
type TerminalRepaintRecovery = {
  readonly onRepaint: () => void
  /** Hands the last snapshot to the system share sheet.
   *
   *  The only way one ever leaves a TestFlight device: those builds are signed
   *  without get-task-allow, so their container cannot be read from a paired
   *  Mac the way a development build's can. Whoever hit the button has to be
   *  able to send the file themselves. */
  readonly onShareSnapshot: () => void
  readonly repaintBusy: boolean
}

export function useTerminalRepaintRecovery({
  activeHandleRef,
  getTerminalRef,
  describeContext,
  resubscribe,
  restoreLiveInputLine,
  showToast
}: TerminalRepaintRecoveryOptions): TerminalRepaintRecovery {
  const [repaintBusy, setRepaintBusy] = useState(false)
  const lastSnapshotUriRef = useRef<string | null>(null)

  const handleShareSnapshot = useCallback(() => {
    const uri = lastSnapshotUriRef.current
    if (!uri) {
      return
    }
    // Failure is silent on purpose: dismissing the sheet rejects, and that is
    // the ordinary outcome, not something to report as an error.
    void Share.share({ url: uri }).catch(() => {})
  }, [])

  const handleRepaint = useCallback(() => {
    if (repaintBusy) {
      return
    }
    setRepaintBusy(true)
    const handle = activeHandleRef.current
    const terminal = getTerminalRef(handle)
    logTerminalLiveness('repaint-requested', {
      handle: handle ? handle.slice(-8) : 'none',
      hasRef: terminal !== undefined
    })
    // Not awaited yet: the capture is done by the time this call returns, so
    // everything below runs against a fault that is already on disk.
    const pending = snapshotTerminalLiveness({ ...describeContext(), handle: handle ?? 'none' })

    // Cheapest first. A repaint fixes dropped GPU pixels and a stalled write
    // drain without disturbing the buffer, so a pane that only needed that keeps
    // its scroll position and its unsent input line.
    terminal?.repaint()
    if (handle) {
      resubscribe(handle)
    }

    void pending
      .then((snapshot) => {
        logTerminalLiveness('repaint-done', {
          snapshot: snapshot ? snapshot.fileName : 'write-failed',
          lines: snapshot ? snapshot.lineCount : -1
        })
        lastSnapshotUriRef.current = snapshot ? snapshot.uri : null
        restoreLiveInputLine()
        showToast(snapshot ? 'Redrawn, diagnostics saved' : 'Redrawn', 1500)
      })
      .finally(() => setRepaintBusy(false))
  }, [
    activeHandleRef,
    describeContext,
    getTerminalRef,
    repaintBusy,
    restoreLiveInputLine,
    resubscribe,
    showToast
  ])

  return { onRepaint: handleRepaint, onShareSnapshot: handleShareSnapshot, repaintBusy }
}
