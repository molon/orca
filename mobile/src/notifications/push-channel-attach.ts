import { parsePushChannelBlob } from './push-channel'
import { savePushChannel } from './push-channel-store'
import { subscribeToPushChannel } from './push-channel-subscription'
import { saveChannelIdForHost } from './push-channel-index'

export type AttachPushChannelResult =
  | { kind: 'unrecognized' }
  | { kind: 'connected'; channelId: string }
  | { kind: 'saved-not-subscribed'; channelId: string; reason: string }
  | { kind: 'saved-unsupported'; channelId: string }

/**
 * Stores a channel against a host and subscribes this phone to it.
 *
 * Shared by the paste field and the scanner because the two differ only in
 * where the string came from; duplicating the four steps is how one of them
 * ends up forgetting to write the host index and routing taps nowhere.
 *
 * Saved even when subscribing fails: the key is what decrypts, and a phone that
 * could not reach the server now subscribes again on its next launch.
 */
export async function attachPushChannel(args: {
  blob: string
  hostId: string
}): Promise<AttachPushChannelResult> {
  const channel = await parsePushChannelBlob(args.blob)
  if (!channel) {
    return { kind: 'unrecognized' }
  }
  await savePushChannel(channel, args.hostId)
  await saveChannelIdForHost(args.hostId, channel.channelId)
  const result = await subscribeToPushChannel(channel)
  if (result.kind === 'subscribed') {
    return { kind: 'connected', channelId: channel.channelId }
  }
  if (result.kind === 'unsupported') {
    return { kind: 'saved-unsupported', channelId: channel.channelId }
  }
  return { kind: 'saved-not-subscribed', channelId: channel.channelId, reason: result.reason }
}

/** One place deciding how each outcome reads, so the scanner and the paste
 *  field cannot describe the same result differently. */
export function describeAttachResult(result: AttachPushChannelResult): {
  kind: 'ok' | 'warn'
  text: string
} {
  switch (result.kind) {
    case 'unrecognized':
      return { kind: 'warn', text: 'That is not a channel code. Run setup again on that machine.' }
    case 'connected':
      return { kind: 'ok', text: 'Connected — notifications from that machine will arrive here.' }
    case 'saved-unsupported':
      return { kind: 'warn', text: 'Saved, but this build cannot receive push.' }
    case 'saved-not-subscribed':
      return {
        kind: 'warn',
        text: `Saved, but the server did not answer (${result.reason}). It will retry on next launch.`
      }
  }
}
