import { beforeEach, describe, expect, it, vi } from 'vitest'

/*
The four steps of attaching a channel, checked together because the failure this
guards against is one of them being skipped: a channel saved without its host
index decrypts fine and routes every tap to nowhere, and nothing about that
looks wrong until a notification is tapped.
*/

const saved: Array<{ channelId: string; hostId: string }> = []
const indexed: Array<{ hostId: string; channelId: string | null }> = []
let subscribeResult: { kind: string; reason?: string } = { kind: 'subscribed' }

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: async (_algorithm: string, value: string) => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }
}))
vi.mock('./push-channel-store', () => ({
  savePushChannel: async (channel: { channelId: string }, hostId: string) => {
    saved.push({ channelId: channel.channelId, hostId })
  }
}))
vi.mock('./push-channel-index', () => ({
  saveChannelIdForHost: async (hostId: string, channelId: string | null) => {
    indexed.push({ hostId, channelId })
  }
}))
vi.mock('./push-channel-subscription', () => ({
  subscribeToPushChannel: async () => subscribeResult
}))

const { attachPushChannel, describeAttachResult } = await import('./push-channel-attach')

const KEY_B64 = Buffer.alloc(32, 3).toString('base64')
const BARE = Buffer.from(
  JSON.stringify({ provider: 'https://push.example', key: KEY_B64, authToken: 'tok' })
).toString('base64')

beforeEach(() => {
  saved.length = 0
  indexed.length = 0
  subscribeResult = { kind: 'subscribed' }
})

describe('attachPushChannel', () => {
  it('stores, indexes and subscribes what the scanner read', async () => {
    const result = await attachPushChannel({
      blob: `orca://push-channel?code=${BARE}`,
      hostId: 'host-1'
    })
    expect(result.kind).toBe('connected')
    expect(saved).toEqual([{ channelId: expect.any(String), hostId: 'host-1' }])
    expect(indexed).toEqual([{ hostId: 'host-1', channelId: saved[0]!.channelId }])
  })

  it('keeps the key when the server cannot be reached, so a relaunch retries', async () => {
    subscribeResult = { kind: 'failed', reason: 'timeout' }
    const result = await attachPushChannel({ blob: BARE, hostId: 'host-1' })
    expect(result.kind).toBe('saved-not-subscribed')
    expect(saved).toHaveLength(1)
    expect(describeAttachResult(result).text).toContain('timeout')
  })

  it('writes nothing at all for a string that is not a channel', async () => {
    const result = await attachPushChannel({ blob: 'orca://pair?code=nope', hostId: 'host-1' })
    expect(result.kind).toBe('unrecognized')
    expect(saved).toEqual([])
    expect(indexed).toEqual([])
  })
})
