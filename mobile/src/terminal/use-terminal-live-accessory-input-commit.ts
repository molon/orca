import { useCallback, type RefObject } from 'react'
import type { TextInput } from 'react-native'
import {
  getTerminalLiveAccessoryBytesDecision,
  getTerminalLiveAccessoryLocalEditText,
  terminalLiveAccessoryInputEndsLine
} from './terminal-live-text-commit'
import type { TerminalLiveAccessoryInput } from './terminal-live-accessory-input'
import { sendTerminalLiveControlAfterPendingFlush } from './terminal-live-control-send-order'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { writeTerminalLiveInputText } from './terminal-live-input-text-write'

export type TerminalLiveAccessoryInputCommitResult =
  | { readonly kind: 'allow-raw' }
  | { readonly kind: 'handled' }
  | { readonly kind: 'suppress-raw' }

export async function getTerminalLiveAccessoryInactiveInputCommitResult(
  waitForPendingLiveInputFlush: () => Promise<boolean>
): Promise<TerminalLiveAccessoryInputCommitResult> {
  return (await waitForPendingLiveInputFlush()) ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
}

type TerminalLiveAccessoryInputCommitOptions = {
  readonly activeHandle: string | null
  readonly applyLiveInputMirror: (
    handle: string,
    fieldText: string,
    report?: {
      readonly composing?: boolean
      readonly caretBack?: number
      readonly fieldLength?: number
    }
  ) => Promise<boolean>
  readonly clearPendingLiveInputCommit: () => void
  readonly flushPendingLiveInputText: (expectedHandle: string | null) => Promise<boolean>
  readonly heldLiveInputTextRef: RefObject<string>
  readonly fieldTextRef: RefObject<string>
  readonly fieldCaretBackRef: RefObject<number>
  readonly liveInputComposingRef: RefObject<boolean | undefined>
  readonly liveInputRef: RefObject<TextInput | null>
  readonly liveInputTerminalHandles: ReadonlySet<string>
  readonly onInteraction: () => void
  readonly pendingLiveInputHandleRef: RefObject<string | null>
  readonly mirroredFieldTextRef: RefObject<string>
  readonly sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender>
  readonly waitForPendingLiveInputFlush: () => Promise<boolean>
}

export function useTerminalLiveAccessoryInputCommit({
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
  onInteraction,
  pendingLiveInputHandleRef,
  mirroredFieldTextRef,
  sendLiveTerminalInputRef,
  waitForPendingLiveInputFlush
}: TerminalLiveAccessoryInputCommitOptions): (
  input: TerminalLiveAccessoryInput
) => Promise<TerminalLiveAccessoryInputCommitResult> {
  return useCallback(
    async (input: TerminalLiveAccessoryInput): Promise<TerminalLiveAccessoryInputCommitResult> => {
      if (!activeHandle) {
        return { kind: 'allow-raw' }
      }
      if (!liveInputTerminalHandles.has(activeHandle)) {
        return getTerminalLiveAccessoryInactiveInputCommitResult(waitForPendingLiveInputFlush)
      }
      onInteraction()
      const ownsPendingState = pendingLiveInputHandleRef.current === activeHandle
      if (pendingLiveInputHandleRef.current && !ownsPendingState) {
        clearPendingLiveInputCommit()
      }
      const heldText = ownsPendingState ? heldLiveInputTextRef.current : ''
      const sentText = ownsPendingState ? mirroredFieldTextRef.current : ''
      const decision = getTerminalLiveAccessoryBytesDecision({ ...input, heldText, sentText })
      switch (decision.kind) {
        case 'send-now': {
          // Why: raw accessory bytes must wait behind any in-flight mirror send
          // so composed Hangul reaches the PTY before follow-up controls. A control
          // that ends the line ends the line state with the same call the
          // held-text branch below makes.
          const ready = terminalLiveAccessoryInputEndsLine(input.bytes)
            ? await flushPendingLiveInputText(activeHandle)
            : await waitForPendingLiveInputFlush()
          return ready ? { kind: 'allow-raw' } : { kind: 'suppress-raw' }
        }
        case 'local-edit': {
          // The edit happens at the caret, which a paired-punctuation IME leaves before the closer.
          const field = Array.from(ownsPendingState ? fieldTextRef.current : '')
          const caretAt = field.length - Math.min(fieldCaretBackRef.current, field.length)
          const afterCaret = field.slice(caretAt).join('')
          const editedBefore = getTerminalLiveAccessoryLocalEditText({
            localEdit: decision.localEdit,
            fieldText: field.slice(0, caretAt).join('')
          })
          const editedText = editedBefore + afterCaret
          // Why: accessory buttons do not emit native TextInput edits, so the
          // field is edited here and the mirror diff syncs the PTY echo. This is
          // the one write left, and it happens on a tap rather than mid
          // dictation; if iOS drops it, the next report diffs it back.
          writeTerminalLiveInputText(liveInputRef, editedText, editedBefore.length)
          // Preserve undefined so Android's heuristic hold still settles on its timer.
          const sent = await applyLiveInputMirror(activeHandle, editedText, {
            composing: liveInputComposingRef.current,
            caretBack: Array.from(afterCaret).length,
            fieldLength: editedText.length
          })
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
        }
        case 'commit-held-then-send': {
          const sent = await sendTerminalLiveControlAfterPendingFlush(
            () => flushPendingLiveInputText(activeHandle),
            () => sendLiveTerminalInputRef.current(activeHandle, decision.bytes)
          )
          return sent ? { kind: 'handled' } : { kind: 'suppress-raw' }
        }
        default:
          decision satisfies never
          return { kind: 'handled' }
      }
    },
    [
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
      onInteraction,
      pendingLiveInputHandleRef,
      mirroredFieldTextRef,
      sendLiveTerminalInputRef,
      waitForPendingLiveInputFlush
    ]
  )
}
