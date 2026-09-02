/*
What each terminal's prompt is still holding, remembered outside React.

Module scope on purpose. The sentence lives in the terminal, not in the app —
it sits in that prompt whether or not the pane is on screen, whether or not the
session route is mounted. Keeping the record inside the screen meant leaving and
coming back destroyed it while the thing it described was still there, and the
field came back empty in front of a prompt that was not.

Cleared only by the two things that really end a line: running it, or losing
track of what reached the pty.
*/

/** Terminals per session are few; this only guards against a very long-lived
 *  app accumulating handles that closed without notice. */
const MAX_REMEMBERED_LINES = 64

const lines = new Map<string, string>()

export function readTerminalLiveInputLine(handle: string): string {
  return lines.get(handle) ?? ''
}

export function writeTerminalLiveInputLine(handle: string, text: string): void {
  if (text.length === 0) {
    lines.delete(handle)
    return
  }
  // Re-insert so eviction below drops the least recently typed into.
  lines.delete(handle)
  lines.set(handle, text)
  for (const stale of [...lines.keys()].slice(0, Math.max(0, lines.size - MAX_REMEMBERED_LINES))) {
    lines.delete(stale)
  }
}

export function forgetTerminalLiveInputLine(handle: string): void {
  lines.delete(handle)
}

/** Drops every remembered line. The store outlives the screen deliberately, so
 *  anything starting from a clean slate — a different host, a test — has to say
 *  so rather than rely on a mount to have wiped it. */
export function forgetAllTerminalLiveInputLines(): void {
  lines.clear()
}
