import type { RefObject } from 'react'
import type { TextInput } from 'react-native'

/**
 * The field is controlled, so this is for the case React has no commit to make: an unchanged
 * `value` prop leaves whatever an interrupted IME composition put there. The `.web.ts` sibling
 * exists because on RN Web the ref is the DOM node, where this call is a `TypeError`.
 */
export function writeTerminalLiveInputText(
  ref: RefObject<TextInput | null>,
  text: string,
  caret?: number
): void {
  ref.current?.setNativeProps({ text })
  if (caret !== undefined) {
    writeTerminalLiveInputCaret(ref, caret)
  }
}

/**
 * Moves the caret alone, in UTF-16 units; the text is left exactly as the field holds it.
 * `setSelection`, not `setNativeProps`: Fabric's TextInput has no `selection` prop, so that write is
 * silently dropped and only the view command reaches the native field.
 */
export function writeTerminalLiveInputCaret(ref: RefObject<TextInput | null>, caret: number): void {
  ref.current?.setSelection(caret, caret)
}
