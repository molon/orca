import { useCallback, useEffect, useRef, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import { reportedLiveInputComposing } from '../platform/live-input-composing-range'
import { getTerminalLiveSpecialKeyDecision } from './terminal-live-text-commit'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { normalizeTerminalTextInput } from './terminal-text-input-normalization'
import { useTerminalLivePendingInputFlush } from './use-terminal-live-pending-input-flush'
import {
  useTerminalLiveAccessoryInputCommit,
  type TerminalLiveAccessoryInputCommitResult
} from './use-terminal-live-accessory-input-commit'

type TerminalLiveInputKeyPressEvent = {
  readonly nativeEvent: {
    readonly key: string
  }
}

/** `isComposing` is the text system's marked-text range, forwarded by the pinned
 *  react-native patch on iOS; `onChangeText` would drop the payload entirely.
 *  Absent means the platform reports no range — not "not composing". */
type TerminalLiveInputChangeEvent = {
  readonly nativeEvent: {
    readonly text: string
    readonly isComposing?: boolean
    /** Dictation marks its transcript like an IME marks a reading; only this tells them apart. */
    readonly isDictating?: boolean
  }
}

/** The caret the field reports after it moves; `text` rides along on the native event. */
type TerminalLiveInputSelectionChangeEvent = {
  readonly nativeEvent: {
    readonly text?: string
    readonly selection: { readonly start: number; readonly end: number }
    readonly isComposing?: boolean
    readonly isDictating?: boolean
  }
}

type TerminalLiveInputCommitOptions<TTabType extends string> = {
  readonly activeHandle: string | null
  readonly activeHandleRef: RefObject<string | null>
  readonly activeSessionTabType: TTabType | null | undefined
  readonly activeSessionTabTypeRef: RefObject<TTabType | null>
  readonly connected: boolean
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly liveInputTerminalHandlesRef: RefObject<Set<string>>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly setLiveInputCapture: (text: string) => void
}

type TerminalLiveInputCommitHandlers = {
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputBeforeExternalSend: (handle: string) => Promise<boolean>
  readonly getLiveInputInteractionGeneration: () => number
  readonly handleLiveInputAccessoryBytes: (
    input: TerminalLiveAccessoryInput
  ) => Promise<TerminalLiveAccessoryInputCommitResult>
  readonly handleLiveInputChange: (event: TerminalLiveInputChangeEvent) => void
  readonly handleLiveInputKeyPress: (event: TerminalLiveInputKeyPressEvent) => void
  readonly handleLiveInputSelectionChange: (event: TerminalLiveInputSelectionChangeEvent) => void
  readonly handleLiveInputSubmit: () => Promise<boolean>
  /** Puts the remembered line back in the field after an in-place recovery,
   *  which repairs the pane without ever changing the active handle. */
  readonly restoreLiveInputLine: () => void
}

export function useTerminalLiveInputCommit<TTabType extends string>({
  activeHandle,
  activeHandleRef,
  activeSessionTabType,
  activeSessionTabTypeRef,
  connected,
  liveInputRef,
  liveInputTerminalHandles,
  liveInputTerminalHandlesRef,
  sendLiveTerminalInputRef,
  setLiveInputCapture
}: TerminalLiveInputCommitOptions<TTabType>): TerminalLiveInputCommitHandlers {
  const liveInputInteractionGenerationRef = useRef(0)
  const advanceLiveInputInteractionGeneration = useCallback(() => {
    liveInputInteractionGenerationRef.current += 1
  }, [])
  const {
    adoptLiveInputLine,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    parkLiveInputLine,
    readLiveInputLine,
    heldLiveInputTextRef,
    fieldTextRef,
    fieldCaretBackRef,
    liveInputComposingRef,
    mirroredFieldTextRef,
    pendingLiveInputHandleRef,
    waitForPendingLiveInputFlush
  } = useTerminalLivePendingInputFlush({
    activeHandleRef,
    activeSessionTabTypeRef,
    liveInputRef,
    liveInputTerminalHandlesRef,
    sendLiveTerminalInputRef,
    setLiveInputCapture
  })

  useEffect(() => {
    // Why: what reached the PTY is unknowable across an outage — stale mirror state corrupts the first post-reconnect send.
    if (!connected) {
      clearPendingLiveInputCommit()
    }
  }, [connected, clearPendingLiveInputCommit])

  const restoreLiveInputLine = useCallback((): void => {
    const handle = activeHandleRef.current
    if (!handle || !liveInputTerminalHandlesRef.current.has(handle)) {
      return
    }
    const restored = readLiveInputLine(handle)
    if (restored.length === 0) {
      return
    }
    writeTerminalLiveInputText(liveInputRef, restored)
    adoptLiveInputLine(handle, restored)
  }, [
    activeHandleRef,
    adoptLiveInputLine,
    liveInputRef,
    liveInputTerminalHandlesRef,
    readLiveInputLine
  ])

  useEffect(() => {
    const pendingHandle = pendingLiveInputHandleRef.current
    // Why: a lagging mobile tab list briefly yields no active tab object; a
    // null/undefined type is "unknown", not "left the terminal" — flush guards
    // still block sends if the tab truly changed.
    const onTerminal =
      activeHandle != null &&
      (activeSessionTabType == null || activeSessionTabType === 'terminal') &&
      liveInputTerminalHandles.has(activeHandle)
    if (pendingHandle && (!onTerminal || pendingHandle !== activeHandle)) {
      // Parked, not cleared: the sentence is still in the terminal it was typed
      // into, so leaving the tab must not forget it — coming back used to show
      // an empty field for a prompt that was not empty.
      parkLiveInputLine()
    }
    if (!onTerminal || pendingLiveInputHandleRef.current === activeHandle) {
      return
    }
    restoreLiveInputLine()
  }, [
    activeHandle,
    activeSessionTabType,
    liveInputTerminalHandles,
    parkLiveInputLine,
    restoreLiveInputLine
  ])

  const flushPendingLiveInputBeforeExternalSend = useCallback(
    async (handle: string): Promise<boolean> => {
      advanceLiveInputInteractionGeneration()
      const pendingHandle = pendingLiveInputHandleRef.current
      if (pendingHandle && pendingHandle !== handle) {
        clearPendingLiveInputCommit()
        return waitForPendingLiveInputFlush()
      }
      // Why: external bytes (dictation/paste) land after the field's echo on the
      // PTY; the field session must fully end or later diffs would erase them.
      if (pendingHandle === handle) {
        return flushPendingLiveInputText(handle)
      }
      return waitForPendingLiveInputFlush()
    },
    [
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputChangeEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        clearPendingLiveInputCommit()
        return
      }
      // Nothing is written back to the field here — a write that lands mid
      // dictation ends the session, and one that does not land is invisible.
      // The mirror publishes the capture from the line it maintains.
      advanceLiveInputInteractionGeneration()
      void applyLiveInputMirror(activeHandle, normalizeTerminalTextInput(nativeEvent.text), {
        composing: reportedLiveInputComposing(nativeEvent.isComposing),
        dictating: nativeEvent.isDictating,
        fieldLength: nativeEvent.text.length
      })
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      applyLiveInputMirror,
      clearPendingLiveInputCommit,
      liveInputTerminalHandles
    ]
  )

  // An input method that pairs punctuation inserts both halves, then moves the caret between them
  // with no text change; this is the only report of that move.
  const handleLiveInputSelectionChange = useCallback(
    ({ nativeEvent }: TerminalLiveInputSelectionChangeEvent) => {
      const { text, selection } = nativeEvent
      if (
        !activeHandle ||
        !liveInputTerminalHandles.has(activeHandle) ||
        typeof text !== 'string'
      ) {
        return
      }
      void applyLiveInputMirror(activeHandle, normalizeTerminalTextInput(text), {
        composing: reportedLiveInputComposing(nativeEvent.isComposing),
        dictating: nativeEvent.isDictating,
        caretBack: Array.from(normalizeTerminalTextInput(text.slice(selection.end))).length,
        fieldLength: text.length
      })
    },
    [activeHandle, applyLiveInputMirror, liveInputTerminalHandles]
  )

  const getLiveInputInteractionGeneration = useCallback(
    () => liveInputInteractionGenerationRef.current,
    []
  )

  const handleLiveInputKeyPress = useCallback(
    (event: TerminalLiveInputKeyPressEvent) => {
      if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
        return
      }
      advanceLiveInputInteractionGeneration()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const decision = getTerminalLiveSpecialKeyDecision({
        key: event.nativeEvent.key,
        heldText: ownsPendingState ? heldLiveInputTextRef.current : '',
        sentText: ownsPendingState ? mirroredFieldTextRef.current : ''
      })
      switch (decision.kind) {
        case 'ignore':
        case 'local-edit':
          return
        case 'send-now':
          void sendTerminalLiveControlAfterPendingFlush(waitForPendingLiveInputFlush, () =>
            sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        case 'commit-held-then-send':
          void sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return
        default:
          decision satisfies never
      }
    },
    [
      activeHandle,
      advanceLiveInputInteractionGeneration,
      clearPendingLiveInputCommit,
      flushPendingLiveInputText,
      liveInputTerminalHandles,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )

  const handleLiveInputAccessoryBytes = useTerminalLiveAccessoryInputCommit({
    activeHandle,
    applyLiveInputMirror,
    clearPendingLiveInputCommit,
    flushPendingLiveInputText,
    heldLiveInputTextRef,
    fieldTextRef,
    fieldCaretBackRef,
    liveInputComposingRef,
    liveInputRef,
    liveInputTerminalHandles,
    onInteraction: advanceLiveInputInteractionGeneration,
    pendingLiveInputHandleRef,
    mirroredFieldTextRef,
    sendLiveTerminalInputRef,
    waitForPendingLiveInputFlush
  })

  const handleLiveInputSubmit = useCallback((): Promise<boolean> => {
    if (!activeHandle || !liveInputTerminalHandles.has(activeHandle)) {
      return Promise.resolve(false)
    }
    advanceLiveInputInteractionGeneration()
    return sendTerminalLiveControlAfterPendingFlush(
      () => flushPendingLiveInputText(activeHandle),
      () => sendLiveTerminalInputRef.current(activeHandle, '\r')
    )
  }, [
    activeHandle,
    advanceLiveInputInteractionGeneration,
    flushPendingLiveInputText,
    liveInputTerminalHandles,
    sendLiveTerminalInputRef
  ])

  return {
    clearPendingLiveInputCommit,
    flushPendingLiveInputBeforeExternalSend,
    getLiveInputInteractionGeneration,
    handleLiveInputAccessoryBytes,
    handleLiveInputChange,
    handleLiveInputKeyPress,
    handleLiveInputSelectionChange,
    handleLiveInputSubmit,
    restoreLiveInputLine
  }
}
