import { describe, expect, it } from 'vitest'
import {
  MobilePushEnvelopeError,
  generateMobilePushKey,
  mobilePushKeyFromBase64,
  mobilePushKeyToBase64,
  openMobilePushEnvelope,
  sealMobilePushEnvelope,
  type MobilePushPayload
} from './mobile-push-envelope'

const payload: MobilePushPayload = {
  source: 'agent-task-complete',
  hostId: 'host-1',
  title: 'Agent finished',
  body: 'claude · mobile/terminal',
  worktreeId: 'worktree-1',
  notificationId: 'n-1'
}

describe('mobile push envelope', () => {
  it('round-trips a payload through seal and open', () => {
    const key = generateMobilePushKey()
    expect(openMobilePushEnvelope(sealMobilePushEnvelope(payload, key), key)).toEqual(payload)
  })

  it('survives a base64 key round-trip, so both sides can persist it as text', () => {
    const key = generateMobilePushKey()
    const restored = mobilePushKeyFromBase64(mobilePushKeyToBase64(key))
    expect(openMobilePushEnvelope(sealMobilePushEnvelope(payload, key), restored)).toEqual(payload)
  })

  it('never emits the same ciphertext twice for one payload', () => {
    const key = generateMobilePushKey()
    expect(sealMobilePushEnvelope(payload, key)).not.toBe(sealMobilePushEnvelope(payload, key))
  })

  // Why: fan-out gives every device its own key, so a push sealed for one device
  // must be unreadable by another even though both are paired to this desktop.
  it('cannot be opened with another device key', () => {
    const sealed = sealMobilePushEnvelope(payload, generateMobilePushKey())
    expect(() => openMobilePushEnvelope(sealed, generateMobilePushKey())).toThrow(
      MobilePushEnvelopeError
    )
  })

  it('rejects a tampered ciphertext rather than returning altered content', () => {
    const key = generateMobilePushKey()
    const sealed = sealMobilePushEnvelope(payload, key)
    const bytes = atob(sealed)
    const flipped =
      bytes.slice(0, -1) + String.fromCharCode(bytes.charCodeAt(bytes.length - 1) ^ 0x01)
    expect(() => openMobilePushEnvelope(btoa(flipped), key)).toThrow(MobilePushEnvelopeError)
  })

  it('rejects an envelope too short to hold a nonce', () => {
    expect(() => openMobilePushEnvelope(btoa('short'), generateMobilePushKey())).toThrow(
      MobilePushEnvelopeError
    )
  })

  it('rejects input that is not base64', () => {
    expect(() => openMobilePushEnvelope('not base64!!', generateMobilePushKey())).toThrow(
      MobilePushEnvelopeError
    )
  })

  it('rejects a key of the wrong length instead of silently padding it', () => {
    expect(() => mobilePushKeyFromBase64(btoa('too short'))).toThrow(MobilePushEnvelopeError)
  })

  // Why: APNs drops payloads over 4 KiB, and the envelope is only part of the
  // body. Failing at seal time surfaces the truncation decision to the sender.
  it('refuses to seal a payload past the size limit', () => {
    const key = generateMobilePushKey()
    // Every field is within its own limit; only the total exceeds the cap.
    const oversized: MobilePushPayload = {
      source: 's'.repeat(64),
      hostId: 'h'.repeat(128),
      title: 't'.repeat(512),
      body: 'b'.repeat(1024),
      worktreeId: 'w'.repeat(256),
      notificationId: 'n'.repeat(128)
    }
    expect(() => sealMobilePushEnvelope(oversized, key)).toThrow(MobilePushEnvelopeError)
  })

  it('reports a malformed payload as an envelope error, not a raw schema error', () => {
    expect(() =>
      sealMobilePushEnvelope(
        { source: 'x' } as unknown as MobilePushPayload,
        generateMobilePushKey()
      )
    ).toThrow(MobilePushEnvelopeError)
  })

  // Why: desktop and phone update independently. A newer desktop adding an
  // optional field must not make an older phone reject the envelope outright.
  it('ignores unknown fields instead of rejecting the envelope', () => {
    const key = generateMobilePushKey()
    const sealed = sealMobilePushEnvelope(
      { ...payload, addedByANewerDesktop: 'nope' } as unknown as MobilePushPayload,
      key
    )
    expect(openMobilePushEnvelope(sealed, key)).toEqual(payload)
  })

  it('keeps an optional-field-free payload valid, since not every source has a worktree', () => {
    const key = generateMobilePushKey()
    const minimal: MobilePushPayload = {
      source: 'terminal-bell',
      hostId: 'host-1',
      title: 'Bell',
      body: ''
    }
    expect(openMobilePushEnvelope(sealMobilePushEnvelope(minimal, key), key)).toEqual(minimal)
  })
})
