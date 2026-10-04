import { useEffect, useRef, type RefObject } from 'react'
import { AppState, Keyboard, type AppStateStatus, type TextInput } from 'react-native'

/**
 * iOS puts the keyboard back on resume without a show event, so the layout returns un-inset and
 * snaps into place only on the next tap. Closing it on the way out leaves nothing to restore.
 */
export function useKeyboardBackgroundDismiss(
  liveInputRef: RefObject<TextInput | null>,
  commandInputRef: RefObject<TextInput | null>,
  keyboardHeight: number
): void {
  const keyboardHeightRef = useRef(0)
  keyboardHeightRef.current = keyboardHeight
  useEffect(() => {
    const closeKeyboard = (): void => {
      liveInputRef.current?.blur()
      commandInputRef.current?.blur()
      Keyboard.dismiss()
    }
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        closeKeyboard()
        return
      }
      // Focus held while the inset reads zero is that broken state itself; iOS may suspend JS
      // before the dismissal above runs, so settle it here too.
      if (
        next === 'active' &&
        keyboardHeightRef.current <= 0 &&
        (liveInputRef.current?.isFocused() === true ||
          commandInputRef.current?.isFocused() === true)
      ) {
        closeKeyboard()
      }
    })
    return () => sub.remove()
  }, [commandInputRef, liveInputRef])
}
