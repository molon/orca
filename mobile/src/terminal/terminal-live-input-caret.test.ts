import { createElement, type RefObject } from 'react'
import { act, create } from 'react-test-renderer'
import type { TextInput } from 'react-native'
import { describe, expect, it } from 'vitest'
import type { TerminalLiveInputSender } from './terminal-live-input-sender'
import { forgetAllTerminalLiveInputLines } from './terminal-live-input-line-store'
import { useTerminalLiveInputCommit } from './use-terminal-live-input-commit'

/*
Input methods that pair punctuation insert both halves and park the caret between them. The field
is hidden, so the terminal's cursor is the only caret anyone sees: it has to sit where the field's
does, or everything typed next lands somewhere the user cannot see.
*/

type Handlers = ReturnType<typeof useTerminalLiveInputCommit<string>>

/** A readline-style input line: DEL erases before the cursor, arrows move it, text inserts at it. */
function createTerminalLine() {
  let chars: string[] = []
  let cursor = 0
  return {
    apply(bytes: string) {
      let rest = bytes
      while (rest.length > 0) {
        if (rest.startsWith('\x1b[D')) {
          cursor = Math.max(0, cursor - 1)
          rest = rest.slice(3)
        } else if (rest.startsWith('\x1b[C')) {
          cursor = Math.min(chars.length, cursor + 1)
          rest = rest.slice(3)
        } else if (rest.startsWith('\x7f')) {
          if (cursor > 0) {
            chars.splice(cursor - 1, 1)
            cursor -= 1
          }
          rest = rest.slice(1)
        } else if (rest.startsWith('\r')) {
          chars = []
          cursor = 0
          rest = rest.slice(1)
        } else {
          const [char] = Array.from(rest)
          chars.splice(cursor, 0, char!)
          cursor += 1
          rest = rest.slice(char!.length)
        }
      }
    },
    /** The line with `|` at the cursor. */
    get view() {
      return [...chars.slice(0, cursor), '|', ...chars.slice(cursor)].join('')
    }
  }
}

function createHarness() {
  forgetAllTerminalLiveInputLines()
  const handle = 'terminal-a'
  const handles = new Set([handle])
  const line = createTerminalLine()
  const sends: string[] = []
  const selectionWrites: number[] = []
  const liveInputRef = {
    // Only the view command moves a Fabric caret; a `selection` native prop is dropped.
    current: {
      setNativeProps: () => {},
      setSelection: (_start: number, end: number) => {
        selectionWrites.push(end)
      }
    }
  } as unknown as RefObject<TextInput | null>
  const sendLiveTerminalInputRef: RefObject<TerminalLiveInputSender> = {
    current: async (_handle, bytes) => {
      sends.push(bytes)
      line.apply(bytes)
      return true
    }
  }
  let handlers: Handlers | null = null
  function Component(): null {
    handlers = useTerminalLiveInputCommit({
      activeHandle: handle,
      activeHandleRef: { current: handle },
      activeSessionTabType: 'terminal',
      activeSessionTabTypeRef: { current: 'terminal' },
      connected: true,
      liveInputRef,
      liveInputTerminalHandles: handles,
      liveInputTerminalHandlesRef: { current: handles },
      sendLiveTerminalInputRef,
      setLiveInputCapture: () => {}
    })
    return null
  }
  act(() => {
    create(createElement(Component))
  })
  return {
    line,
    selectionWrites,
    change: async (text: string, isComposing = false) => {
      await act(async () => {
        handlers?.handleLiveInputChange({ nativeEvent: { text, isComposing } })
      })
    },
    /** A caret the field moved on its own, reported in UTF-16 units like the native event. */
    select: async (text: string, caret: number, isComposing = false) => {
      await act(async () => {
        handlers?.handleLiveInputSelectionChange({
          nativeEvent: { text, isComposing, selection: { start: caret, end: caret } }
        })
      })
    },
    submit: async () => {
      await act(async () => {
        await handlers?.handleLiveInputSubmit()
      })
    },
    sends,
    key: async (bytes: string) => {
      await act(async () => {
        await handlers?.handleLiveInputAccessoryBytes({ bytes })
      })
    },
    release: () => {
      act(() => {
        handlers?.releaseLiveInputCaret()
      })
    },
    backspace: async () => {
      await act(async () => {
        await handlers?.handleLiveInputAccessoryBytes({ bytes: '\x7f', localEdit: 'backspace' })
      })
    }
  }
}

describe('live input with the caret inside the field', () => {
  it('puts the terminal cursor between a pair the input method inserted', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    expect(h.line.view).toBe('“|”')
  })

  it('types a composed word inside the pair and keeps the cursor before the closer', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    await h.change('“ni”', true)
    // The reading is not text yet; nothing outside it moves.
    expect(h.line.view).toBe('“|”')
    await h.change('“你”')
    expect(h.line.view).toBe('“你|”')
    await h.change('“你好”')
    expect(h.line.view).toBe('“你好|”')
  })

  it('erases the character before the caret, not the closer', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    await h.change('“你好”')
    await h.backspace()
    expect(h.line.view).toBe('“你|”')
  })

  it('counts the caret in code points, so astral characters before it move it once', async () => {
    const h = createHarness()
    await h.change('😀()')
    // UTF-16: the emoji is two units, so the caret between the brackets sits at 3.
    await h.select('😀()', 3)
    expect(h.line.view).toBe('😀(|)')
  })

  it('returns the field caret to the end once the line is run', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    await h.change('“你”')
    await h.submit()
    expect(h.selectionWrites.at(-1)).toBe(Array.from('“你”').length)
    // The next line starts at the field's end, so nothing of the old one is retyped.
    await h.select('“你”', 3)
    await h.change('“你”a')
    expect(h.line.view).toBe('a|')
  })

  // Esc, arrows, a click: the terminal's line and cursor are no longer the mirror's to place.
  it('stops re-typing the closer once a key went to the terminal around the field', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    await h.change('“abc”')
    await h.key('\x1b')
    expect(h.selectionWrites.at(-1)).toBe('“abc”'.length)
    h.sends.length = 0
    await h.select('“abc”', 5)
    await h.change('“abc”x')
    expect(h.sends).toEqual(['x'])
  })

  it('lets a click in the terminal take the cursor without the field pulling it back', async () => {
    const h = createHarness()
    await h.change('“”')
    await h.select('“”', 1)
    await h.change('“abc”')
    h.release()
    h.sends.length = 0
    await h.select('“abc”', 5)
    await h.change('“abc”x')
    expect(h.sends).toEqual(['x'])
  })
})
