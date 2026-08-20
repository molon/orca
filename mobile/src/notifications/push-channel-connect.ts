import { listPairedChannels } from './push-channel-index'
import { loadPushChannel } from './push-channel-store'
import { subscribeToPushChannel } from './push-channel-subscription'

/**
 * Re-subscribes every paired channel on launch.
 *
 * Why unconditionally rather than only when something changed: an APNs token
 * rotates without warning — a restore, a reinstall, an OS update — and the
 * server has no way to notice. Re-subscribing on every launch is what turns
 * that from an outage into a non-event, and the server treats a repeat as a
 * no-op.
 */
export async function resubscribePairedChannels(): Promise<void> {
  try {
    const paired = await listPairedChannels()
    for (const { channelId } of paired) {
      const stored = await loadPushChannel(channelId)
      if (!stored) {
        continue
      }
      await subscribeToPushChannel({
        provider: stored.provider,
        keyB64: stored.pushKeyB64,
        channelId,
        authToken: stored.authToken
      })
    }
  } catch {
    // Push is an addition to a direct connection that already delivers; a
    // failure here must not surface on the launch path.
  }
}
