import type { HostStackRouteTarget } from '../navigation/host-stack-navigation'

/**
 * Whether the screen a notification points at is already the one on top.
 *
 * Why this matters for a tap and not just for tidiness: navigating pushes
 * another copy of the session onto the stack, so tapping a notification for the
 * session you are already reading leaves you with two of them and a back button
 * that goes nowhere useful.
 *
 * Compared by route name and the params that identify the thing, not by the
 * whole params object: a screen carries incidental params — a display name, a
 * scroll anchor — that say nothing about which session is open.
 */
export function isNotificationRouteAlreadyOpen(
  target: HostStackRouteTarget,
  current: { segments: readonly string[]; params: Record<string, unknown> | null }
): boolean {
  // Segments carry the group the host stack lives under; a route target names
  // the screen inside it. Comparing them raw never matches, and the failure is
  // invisible — every tap simply navigates as it did before.
  if (current.segments.join('/') !== `h/${target.name}`) {
    return false
  }
  const identifying = ['hostId', 'worktreeId'] as const
  return identifying.every((key) => {
    const wanted = target.params?.[key]
    // A target that does not name one of these is not specific enough to call
    // "already open" — the screen could be showing anything.
    return typeof wanted === 'string' && current.params?.[key] === wanted
  })
}
