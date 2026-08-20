import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const sessionRouteSource = readFileSync(
  join(__dirname, '../../app/h/[hostId]/session/[worktreeId].tsx'),
  'utf8'
)

/**
 * Source assertions, because the behaviour is a wiring fact with no seam: iOS
 * restores the keyboard on resume without a show event, so the inset comes back
 * zero and the layout only snaps into place on the next tap.
 *
 * They earn their keep for a duller reason too — this wiring was once removed by
 * a bad revert and re-added by a text replacement that matched nothing, so it
 * shipped absent while looking present in the diff.
 */
describe('terminal keyboard background dismissal', () => {
  it('closes the keyboard when the app is backgrounded', () => {
    expect(sessionRouteSource).toContain("if (next === 'background') {")
    expect(sessionRouteSource).toContain('closeKeyboard()')
    expect(sessionRouteSource).toContain('Keyboard.dismiss()')
  })

  it('settles a keyboard that came back with a zero inset', () => {
    expect(sessionRouteSource).toContain("next === 'active' &&")
    expect(sessionRouteSource).toContain('keyboardHeightRef.current <= 0 &&')
    expect(sessionRouteSource).toContain('liveInputRef.current?.isFocused() === true')
  })

  it('keeps the ref the resume check reads in step with the keyboard events', () => {
    expect(sessionRouteSource).toContain('keyboardHeightRef.current = height')
    expect(sessionRouteSource).toContain('keyboardHeightRef.current = 0')
  })
})
