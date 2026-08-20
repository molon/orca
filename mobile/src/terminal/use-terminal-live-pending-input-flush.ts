import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import {
  computeTerminalLiveMirrorStep,
  TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS
} from './terminal-live-preedit-mirror'
import {
  cancelTerminalLivePendingFlush,
  createTerminalLivePendingFlushState,
  queueTerminalLiveMirrorSend,
  waitForTerminalLivePendingFlush
} from './terminal-live-pending-flush-state'

type TerminalLivePendingInputFlushOptions<TTabType extends string> = {
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveFieldReport = {
  readonly composing?: boolean
  readonly dictating?: boolean
}

type RunTerminalLiveMirrorStep = (
  handle: string,
  fieldText: string,
  commitHeld: boolean,
  report?: TerminalLiveFieldReport
) => Promise<boolean>

type TerminalLivePendingInputFlush = {
  readonly applyLiveInputMirror: (
    handle: string,
    fieldText: string,
    report?: TerminalLiveFieldReport
  ) => void
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly heldLiveInputTextRef: RefObject<string>
  readonly mirroredFieldTextRef: RefObject<string>
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLivePendingInputFlush<TTabType extends string>({
  activeHandleRef,
  activeSessionTabTypeRef,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLivePendingInputFlushOptions<TTabType>): TerminalLivePendingInputFlush {
  const heldCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingLiveInputFlushRef = useRef(createTerminalLivePendingFlushState())
  const heldLiveInputTextRef = useRef('')
  /**
   * What the field last reported, minus any preedit tail.
   *
   * Only ever written from a report, never reset to force the field somewhere:
   * JS cannot make the field empty on demand — iOS skips a text write while
   * native change events are in flight, and it reports nothing back — so a reset
   * here would be a guess about the field, and a wrong guess makes the next diff
   * re-send a whole sentence or erase one.
   */
  const mirroredFieldTextRef = useRef('')
  /**
   * What we put on the terminal's current input line.
   *
   * Separate from the field because Enter consumes the line while the field
   * keeps its text. Every erase is bounded by this, so a field that still holds
   * an already-run sentence can never reach back and eat the new line.
   */
  const ptyLineTextRef = useRef('')
  const pendingLiveInputHandleRef = useRef<string | null>(null)
  const runMirrorStepRef = useRef<RunTerminalLiveMirrorStep>(async () => false)

  const clearHeldCommitTimer = useCallback(() => {
    if (heldCommitTimerRef.current) {
      clearTimeout(heldCommitTimerRef.current)
      heldCommitTimerRef.current = null
    }
  }, [])

  const clearPendingLiveInputCommit = useCallback(() => {
    // The line is gone — Enter ran it, the terminal changed, or the connection
    // dropped. The field is deliberately left alone; what it holds stays true,
    // and the next report diffs against it as usual.
    clearHeldCommitTimer()
    cancelTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
    ptyLineTextRef.current = ''
    pendingLiveInputHandleRef.current = null
    setLiveInputCapture('')
  }, [clearHeldCommitTimer, setLiveInputCapture])

  const waitForPendingLiveInputFlush = useCallback(async (): Promise<boolean> => {
    return waitForTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
  }, [])

  const sendQueuedMirrorPayload = useCallback(
    (handle: string, payload: string): Promise<boolean> =>
      sendLiveTerminalInputRef.current(handle, payload),
    [sendLiveTerminalInputRef]
  )

  const runMirrorStep = useCallback<RunTerminalLiveMirrorStep>(
    async (handle, fieldText, commitHeld, report) => {
      if (
        handle !== activeHandleRef.current ||
        (activeSessionTabTypeRef.current != null &&
          activeSessionTabTypeRef.current !== 'terminal') ||
        !liveInputTerminalHandlesRef.current.has(handle)
      ) {
        // Why: a stale handle must not keep line state alive — the next active
        // terminal would inherit wrong erase counts. A null tab type is
        // "unknown" during tab-list lag, not "left the terminal", so it must not trip.
        clearPendingLiveInputCommit()
        return false
      }

      const step = computeTerminalLiveMirrorStep(mirroredFieldTextRef.current, fieldText, {
        commitHeld,
        composing: report?.composing,
        dictating: report?.dictating
      })
      mirroredFieldTextRef.current = step.nextSentText
      heldLiveInputTextRef.current = step.heldText

      // The field outlives the line, so an edit near its start can ask for more
      // erases than the line has characters. Spend only what is there.
      const lineCodePoints = Array.from(ptyLineTextRef.current)
      const eraseCount = Math.min(step.eraseCount, lineCodePoints.length)
      const nextLineText =
        lineCodePoints.slice(0, lineCodePoints.length - eraseCount).join('') + step.appendText
      ptyLineTextRef.current = nextLineText
      // The status row shows the line, not the field: the field still carries
      // sentences the terminal already ran, and showing those reads as if they
      // came back.
      setLiveInputCapture(nextLineText + step.heldText)

      pendingLiveInputHandleRef.current =
        step.heldText.length > 0 || nextLineText.length > 0 ? handle : null

      clearHeldCommitTimer()
      // Why: text the platform positively marked as preedit is not text yet, so
      // no idle timer may commit it. Only an unreported hold is a guess that has
      // to settle on its own.
      if (step.heldText.length > 0 && report?.composing === undefined) {
        heldCommitTimerRef.current = setTimeout(() => {
          heldCommitTimerRef.current = null
          const heldField = mirroredFieldTextRef.current + heldLiveInputTextRef.current
          void runMirrorStepRef.current(handle, heldField, true)
        }, TERMINAL_LIVE_HELD_PREEDIT_COMMIT_DELAY_MS)
      }

      if (eraseCount === 0 && step.appendText.length === 0) {
        return waitForPendingLiveInputFlush()
      }
      return queueTerminalLiveMirrorSend(
        pendingLiveInputFlushRef.current,
        handle,
        { eraseCount, appendText: step.appendText },
        sendQueuedMirrorPayload
      )
    },
    [
      activeHandleRef,
      activeSessionTabTypeRef,
      clearHeldCommitTimer,
      clearPendingLiveInputCommit,
      liveInputTerminalHandlesRef,
      sendQueuedMirrorPayload,
      waitForPendingLiveInputFlush
    ]
  )
  // Why: assigning during render is not replay-safe. The only read is inside a
  // held-commit timer, which fires long after commit, so an effect is soon enough.
  useEffect(() => {
    runMirrorStepRef.current = runMirrorStep
  }, [runMirrorStep])

  const applyLiveInputMirror = useCallback(
    (handle: string, fieldText: string, report?: TerminalLiveFieldReport): void => {
      void runMirrorStep(handle, fieldText, false, report)
    },
    [runMirrorStep]
  )

  const flushPendingLiveInputText = useCallback(
    async (expectedHandle: string | null): Promise<boolean> => {
      const handle = pendingLiveInputHandleRef.current
      if (!handle) {
        return waitForPendingLiveInputFlush()
      }
      if (expectedHandle !== null && handle !== expectedHandle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }

      const heldText = heldLiveInputTextRef.current
      const result =
        heldText.length > 0
          ? await runMirrorStep(handle, mirroredFieldTextRef.current + heldText, true)
          : await waitForPendingLiveInputFlush()

      // Why: an explicit flush ends the line — the echoed pty text stays and the
      // caller is about to run it — so line state restarts from empty.
      clearPendingLiveInputCommit()
      return result
    },
    [clearPendingLiveInputCommit, runMirrorStep, waitForPendingLiveInputFlush]
  )

  useEffect(() => {
    return () => {
      if (heldCommitTimerRef.current) {
        clearTimeout(heldCommitTimerRef.current)
        heldCommitTimerRef.current = null
      }
      heldLiveInputTextRef.current = ''
      mirroredFieldTextRef.current = ''
      ptyLineTextRef.current = ''
      pendingLiveInputHandleRef.current = null
      cancelTerminalLivePendingFlush(pendingLiveInputFlushRef.current)
    }
  }, [])

  return {
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    mirroredFieldTextRef,
    pendingLiveInputHandleRef,
    waitForPendingLiveInputFlush
  }
}
