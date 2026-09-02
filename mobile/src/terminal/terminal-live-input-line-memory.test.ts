import { createElement, type RefObject } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { forgetAllTerminalLiveInputLines } from './terminal-live-input-line-store'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

const DEL = ''

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

type Harness = {
  readonly captures: string[]
  readonly fieldWrites: string[]
  readonly sent: string[]
  readonly type: (text: string) => void
  readonly switchTo: (handle: string) => void
  readonly submit: () => Promise<void>
  readonly remount: () => void
  readonly restore: () => void
}

/** Two terminals, one field — the shape the memory has to survive. */
function createHarness(): Harness {
  forgetAllTerminalLiveInputLines()
  const activeHandleRef: RefObject<string | null> = { current: 'terminal-a' }
  const activeSessionTabTypeRef: RefObject<string | null> = { current: 'terminal' }
  const handles = new Set(['terminal-a', 'terminal-b'])
  const liveInputTerminalHandlesRef: RefObject<Set<string>> = { current: handles }
  const captures: string[] = []
  const fieldWrites: string[] = []
  const sent: string[] = []
  const liveInputRef = {
    current: {
      setNativeProps: ({ text }: { text: string }) => {
        fieldWrites.push(text)
      }
    }
  } as unknown as RefObject<TextInput | null>
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sent.push(bytes)
      return true
    }
  }

  let handlers: Handlers | null = null
  let renderer: ReactTestRenderer | null = null

  function Component(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle: activeHandleRef.current,
      activeHandleRef,
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef,
      connected: true,
      liveInputRef,
      liveInputTerminalHandles: handles,
      liveInputTerminalHandlesRef,
      sendLiveTerminalInputRef,
      setLiveInputCapture: (text) => captures.push(text)
    })
    return null
  }

  act(() => {
    renderer = create(createElement(Component))
  })

  return {
    captures,
    fieldWrites,
    sent,
    type: (text) => {
      act(() => {
        handlers?.handleLiveInputChange({ nativeEvent: { text, isComposing: false } })
      })
    },
    switchTo: (handle) => {
      activeHandleRef.current = handle
      act(() => {
        renderer?.update(createElement(Component))
      })
    },
    submit: async () => {
      await act(async () => {
        handlers?.handleLiveInputSubmit()
      })
    },
    remount: () => {
      act(() => renderer?.unmount())
      act(() => {
        renderer = create(createElement(Component))
      })
    },
    restore: () => {
      act(() => handlers?.restoreLiveInputLine())
    }
  }
}

describe('live input line memory', () => {
  it('shows the line again after leaving the terminal and coming back', () => {
    const harness = createHarness()
    harness.type('hello')

    harness.switchTo('terminal-b')
    expect(harness.captures.at(-1)).toBe('')

    harness.switchTo('terminal-a')
    // Both the status row and the field itself, so what the prompt holds and
    // what the user can edit agree.
    expect(harness.captures.at(-1)).toBe('hello')
    expect(harness.fieldWrites).toEqual(['hello'])
  })

  it('keeps the erase budget across the switch so a correction still deletes', () => {
    const harness = createHarness()
    harness.type('hello')
    harness.switchTo('terminal-b')
    harness.switchTo('terminal-a')

    harness.sent.length = 0
    harness.type('hell')

    // One delete, not a silent no-op: forgetting the line capped erases at zero,
    // so the first edit after a switch could only ever append.
    expect(harness.sent).toEqual([DEL])
  })

  it('survives the session screen going away and coming back', () => {
    const harness = createHarness()
    harness.type('hello')

    harness.fieldWrites.length = 0
    harness.remount()

    // Restored by the mount itself, no prompting. Leaving the route is the app forgetting, not the terminal: that prompt is
    // still holding the sentence, so a fresh mount must not face an empty field.
    expect(harness.captures.at(-1)).toBe('hello')
    expect(harness.fieldWrites).toEqual(['hello'])
  })

  it('restores the line after an in-place recovery, which changes no handle', () => {
    const harness = createHarness()
    harness.type('hello')
    harness.fieldWrites.length = 0

    harness.restore()

    expect(harness.fieldWrites).toEqual(['hello'])
  })

  it('forgets a line the terminal has already run', async () => {
    const harness = createHarness()
    harness.type('hello')
    await harness.submit()

    harness.fieldWrites.length = 0
    harness.switchTo('terminal-b')
    harness.switchTo('terminal-a')

    // Enter consumed it; restoring it would put an already-run sentence back in
    // front of the user as if the terminal had echoed it.
    expect(harness.captures.at(-1)).toBe('')
    expect(harness.fieldWrites).toEqual([])
  })
})
