// Why: a dispatch seals the notification once per device, because each device
// holds its own key. One device failing must not cost the others their push,
// and only a permanent APNs rejection may cost a device its registration.
import { sealMobilePushEnvelope, type MobilePushPayload } from './mobile-push-envelope'
import { mobilePushKeyFromBase64 } from './mobile-push-envelope'
import type { MobilePushRegistration } from './mobile-push-registry'

export type MobilePushSendResult =
  | { readonly kind: 'sent' }
  // The token is permanently invalid — app uninstalled, or APNs 410 Gone. Only
  // this outcome prunes; anything else may be a transient network fault.
  | { readonly kind: 'unregistered' }
  | { readonly kind: 'failed'; readonly reason: string }

export type MobilePushSendRequest = {
  readonly deviceId: string
  readonly deviceToken: string
  readonly envelope: string
  readonly collapseId?: string
}

export type MobilePushSender = (request: MobilePushSendRequest) => Promise<MobilePushSendResult>

export type MobilePushFanoutOutcome = {
  readonly sentDeviceIds: readonly string[]
  readonly failedDeviceIds: readonly string[]
  /** Why kept: without it a push that never leaves the machine looks identical
   *  to one that was never configured. The reason names the hop that failed —
   *  an unreachable provider, a rejected credential — and never the envelope. */
  readonly failureReasons: readonly string[]
  /** Feed straight into pruneMobilePushRegistrations. */
  readonly unregisteredDeviceIds: ReadonlySet<string>
}

/**
 * Seals and sends one payload to every registration.
 *
 * Why every send is isolated: a dead token, an unreadable key, or a thrown
 * sender must not stop the remaining devices from being notified. A rejected
 * promise here would mean one broken phone silences the user's other phones.
 */
export async function fanOutMobilePush(
  registrations: readonly MobilePushRegistration[],
  payload: MobilePushPayload,
  send: MobilePushSender
): Promise<MobilePushFanoutOutcome> {
  const results = await Promise.all(
    registrations.map(async (registration) => {
      try {
        const key = mobilePushKeyFromBase64(registration.pushKeyB64)
        const result = await send({
          deviceId: registration.deviceId,
          deviceToken: registration.deviceToken,
          envelope: sealMobilePushEnvelope(payload, key),
          // Why notificationId: it is the same identity the local path dedups
          // on, so a push and a catch-up replay of one event collapse instead
          // of stacking two banners.
          ...(payload.notificationId ? { collapseId: payload.notificationId } : {})
        })
        return { deviceId: registration.deviceId, result }
      } catch (error) {
        // A corrupt stored key lands here. It is not an APNs verdict, so the
        // registration survives — re-registering is what repairs it.
        return {
          deviceId: registration.deviceId,
          result: { kind: 'failed', reason: String(error) } as const
        }
      }
    })
  )

  const sentDeviceIds: string[] = []
  const failedDeviceIds: string[] = []
  const failureReasons: string[] = []
  const unregisteredDeviceIds = new Set<string>()
  for (const { deviceId, result } of results) {
    if (result.kind === 'sent') {
      sentDeviceIds.push(deviceId)
    } else if (result.kind === 'unregistered') {
      unregisteredDeviceIds.add(deviceId)
    } else {
      failedDeviceIds.push(deviceId)
      failureReasons.push(result.reason)
    }
  }
  return { sentDeviceIds, failedDeviceIds, failureReasons, unregisteredDeviceIds }
}
