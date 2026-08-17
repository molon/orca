import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMobilePushProviderSender,
  loadMobilePushProviderConfig,
  MOBILE_PUSH_PROVIDER_FILENAME
} from './mobile-push-provider-sender'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-provider-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeConfig(contents: string): void {
  writeFileSync(join(dir, MOBILE_PUSH_PROVIDER_FILENAME), contents, 'utf8')
}

const REQUEST = {
  deviceId: 'dev-1',
  deviceToken: 'token-1',
  envelope: 'sealed',
  collapseId: 'wt-42'
}

describe('mobile push provider config', () => {
  // Why null and not a throw: no provider is the normal state, and refusing to
  // start over a file the user never wrote would break the local path too.
  it('reports no provider when nothing is configured', () => {
    expect(loadMobilePushProviderConfig(dir)).toBeNull()
  })

  it('reads a configured relay', () => {
    writeConfig(JSON.stringify({ url: 'https://provider.example:8443', authToken: 'secret' }))
    expect(loadMobilePushProviderConfig(dir)).toEqual({
      url: 'https://provider.example:8443',
      authToken: 'secret'
    })
  })

  it('drops a trailing slash so the path is not doubled', () => {
    writeConfig(JSON.stringify({ url: 'https://provider.example/', authToken: 'secret' }))
    expect(loadMobilePushProviderConfig(dir)?.url).toBe('https://provider.example')
  })

  // Each of these would otherwise produce a sender that fails on every push,
  // which reads as "push is broken" rather than "push is not configured".
  it.each([
    ['not json', 'not json at all'],
    ['no url', JSON.stringify({ authToken: 'secret' })],
    ['no token', JSON.stringify({ url: 'https://provider.example' })],
    ['empty token', JSON.stringify({ url: 'https://provider.example', authToken: '' })],
    ['non-http url', JSON.stringify({ url: 'ftp://provider.example', authToken: 'secret' })]
  ])('treats %s as unconfigured', (_name, contents) => {
    writeConfig(contents)
    expect(loadMobilePushProviderConfig(dir)).toBeNull()
  })
})

describe('mobile push relay sender', () => {
  const config = { url: 'https://provider.example', authToken: 'secret' }

  it('posts the sealed envelope with the provider credential', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    const result = await createMobilePushProviderSender(config, fetchImpl as never)(REQUEST)

    expect(result).toEqual({ kind: 'sent' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://provider.example/push')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer secret')
    expect(JSON.parse(init.body as string)).toEqual({
      deviceToken: 'token-1',
      deviceId: 'dev-1',
      envelope: 'sealed',
      collapseId: 'wt-42'
    })
  })

  // Why only 410: it is APNs reporting the token permanently gone. Anything
  // else may be a provider restart or a flaky link, and unregistering on those
  // would silence phones that are working.
  it('unregisters the device only on 410', async () => {
    for (const [status, kind] of [
      [410, 'unregistered'],
      [502, 'failed'],
      [401, 'failed'],
      [500, 'failed']
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response(null, { status }))
      const result = await createMobilePushProviderSender(config, fetchImpl as never)(REQUEST)
      expect(result.kind).toBe(kind)
    }
  })

  it('reports an unreachable relay as a transient failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    const result = await createMobilePushProviderSender(config, fetchImpl as never)(REQUEST)
    expect(result).toEqual({ kind: 'failed', reason: 'ECONNREFUSED' })
  })

  // The envelope is the one thing this path exists to keep unreadable, so a
  // failure must not carry it into a log line.
  it('keeps the envelope out of the failure reason', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 500 }))
    const result = await createMobilePushProviderSender(config, fetchImpl as never)(REQUEST)
    expect(JSON.stringify(result)).not.toContain('sealed')
  })

  it('omits collapseId when there is none', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }))
    await createMobilePushProviderSender(
      config,
      fetchImpl as never
    )({ ...REQUEST, collapseId: undefined })
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('collapseId')
  })
})
