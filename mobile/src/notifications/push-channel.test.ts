import { describe, expect, it, vi } from 'vitest'
import { channelIdFor, parsePushChannelBlob } from './push-channel'

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: async (_algorithm: string, value: string) => {
    const { createHash } = await import('node:crypto')
    return createHash('sha256').update(value, 'utf8').digest('hex')
  }
}))

const KEY_B64 = Buffer.alloc(32, 7).toString('base64')

function blob(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64')
}

describe('push channel blob', () => {
  it('reads what setup printed', async () => {
    const channel = await parsePushChannelBlob(
      blob({ provider: 'https://push.example:8443', key: KEY_B64, authToken: 'server-secret' })
    )
    expect(channel).toEqual({
      provider: 'https://push.example:8443',
      keyB64: KEY_B64,
      channelId: await channelIdFor(KEY_B64),
      authToken: 'server-secret'
    })
  })

  // The publisher derives the same id from the same string; a mismatch here
  // means notifications go to a channel nobody listens on.
  it('derives the id the publisher will address', async () => {
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256').update(KEY_B64, 'utf8').digest('hex').slice(0, 32)
    expect(await channelIdFor(KEY_B64)).toBe(expected)
  })

  it('tolerates a trailing slash on the provider', async () => {
    const channel = await parsePushChannelBlob(
      blob({ provider: 'https://p.example/', key: KEY_B64 })
    )
    expect(channel?.provider).toBe('https://p.example')
  })

  // Why null everywhere rather than a reason: every one of these has the same
  // fix — copy the string again — and naming the broken byte invites repair by
  // hand.
  it.each([
    ['not base64', '!!!!'],
    ['not json', Buffer.from('hello').toString('base64')],
    ['no key', blob({ provider: 'https://p.example' })],
    ['no provider', blob({ key: KEY_B64 })],
    ['non-http provider', blob({ provider: 'ftp://p.example', key: KEY_B64 })],
    [
      'short key',
      blob({ provider: 'https://p.example', key: Buffer.alloc(16).toString('base64') })
    ],
    ['empty', '']
  ])('rejects %s', async (_name, value) => {
    expect(await parsePushChannelBlob(value)).toBeNull()
  })

  // An older setup that predates the credential still has to pair.
  it('accepts a blob without a credential', async () => {
    const channel = await parsePushChannelBlob(
      blob({ provider: 'https://p.example', key: KEY_B64 })
    )
    expect(channel?.authToken).toBe('')
  })
})
