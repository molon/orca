// Why a three-state setting rather than a boolean: remote push is an addition,
// not a replacement. A user with no push server configured — which includes
// everyone until they set one up — must keep exactly today's behavior, and a
// user diagnosing "which path delivered this?" needs to pin one path.
export type NotificationDeliveryMode = 'auto' | 'local-only' | 'push-only'

export const NOTIFICATION_DELIVERY_MODES: readonly NotificationDeliveryMode[] = [
  'auto',
  'local-only',
  'push-only'
]

export function resolveNotificationDeliveryMode(
  saved: string | null | undefined
): NotificationDeliveryMode {
  return saved === 'local-only' || saved === 'push-only' ? saved : 'auto'
}

type DeliveryDecisionInput = {
  readonly mode: NotificationDeliveryMode
  /** True once this device has a push key and token registered with the host. */
  readonly pushRegistered: boolean
}

export type NotificationDeliveryDecision = {
  /** Whether the desktop should seal and send this event through the push server. */
  readonly usePush: boolean
  /** Whether the live stream should schedule a local notification. */
  readonly useLocal: boolean
}

/**
 * Why push-only still refuses to send when unregistered: with no key there is
 * nothing to seal for, so "push" would silently deliver nothing. Reporting the
 * mode as unsatisfiable is the caller's cue to surface it, which beats a
 * setting that quietly drops every notification.
 */
export function decideNotificationDelivery(
  input: DeliveryDecisionInput
): NotificationDeliveryDecision {
  switch (input.mode) {
    case 'local-only':
      return { usePush: false, useLocal: true }
    case 'push-only':
      return { usePush: input.pushRegistered, useLocal: false }
    case 'auto':
      // Push when it is actually available, local otherwise. Never both: two
      // paths delivering one event is how duplicate banners happen.
      return input.pushRegistered
        ? { usePush: true, useLocal: false }
        : { usePush: false, useLocal: true }
    default:
      input.mode satisfies never
      return { usePush: false, useLocal: true }
  }
}

/** True when the chosen mode cannot deliver anything, so the UI can say so
 *  instead of leaving the user wondering why notifications stopped. */
export function isNotificationDeliveryUnsatisfiable(input: DeliveryDecisionInput): boolean {
  const decision = decideNotificationDelivery(input)
  return !decision.usePush && !decision.useLocal
}
