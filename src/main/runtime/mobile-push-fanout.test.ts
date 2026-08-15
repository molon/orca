import { describe, expect, it, vi } from 'vitest'
import {
  generateMobilePushKey,
  mobilePushKeyToBase64,
  openMobilePushEnvelope,
  type MobilePushPayload
} from './mobile-push-envelope'
import { fanOutMobilePush, type MobilePushSendRequest } from './mobile-push-fanout'
import { pruneMobilePushRegistrations, type MobilePushRegistration } from './mobile-push-registry'

const payload: MobilePushPayload = {
  source: 'agent-task-complete',
  title: 'Agent finished',
  body: 'claude · mobile/terminal',
  notificationId: 'n-1'
}

function registration(deviceId: string, keyB64: string): MobilePushRegistration {
  return {
    deviceId,
    deviceToken: `token-${deviceId}`,
    pushKeyB64: keyB64,
    registeredAtMs: 1
  }
}

describe('mobile push fan-out', () => {
  it('seals separately for each device, so each opens only with its own key', async () => {
    const keyA = generateMobilePushKey()
    const keyB = generateMobilePushKey()
    const sent: MobilePushSendRequest[] = []
    await fanOutMobilePush(
      [
        registration('a', mobilePushKeyToBase64(keyA)),
        registration('b', mobilePushKeyToBase64(keyB))
      ],
      payload,
      async (request) => {
        sent.push(request)
        return { kind: 'sent' }
      }
    )

    expect(sent).toHaveLength(2)
    const toA = sent.find((request) => request.deviceId === 'a')!
    const toB = sent.find((request) => request.deviceId === 'b')!
    expect(openMobilePushEnvelope(toA.envelope, keyA)).toEqual(payload)
    expect(openMobilePushEnvelope(toB.envelope, keyB)).toEqual(payload)
    expect(() => openMobilePushEnvelope(toA.envelope, keyB)).toThrow()
  })

  it('carries the notification id as the collapse id so a push and a replay collapse', async () => {
    const sent: MobilePushSendRequest[] = []
    await fanOutMobilePush(
      [registration('a', mobilePushKeyToBase64(generateMobilePushKey()))],
      payload,
      async (request) => {
        sent.push(request)
        return { kind: 'sent' }
      }
    )
    expect(sent[0]!.collapseId).toBe('n-1')
  })

  it('omits the collapse id when the event has no notification id', async () => {
    const sent: MobilePushSendRequest[] = []
    await fanOutMobilePush(
      [registration('a', mobilePushKeyToBase64(generateMobilePushKey()))],
      { source: 'terminal-bell', title: 'Bell', body: '' },
      async (request) => {
        sent.push(request)
        return { kind: 'sent' }
      }
    )
    expect(sent[0]!.collapseId).toBeUndefined()
  })

  // Why: one dead phone must not silence the user's other phones.
  it('still delivers to healthy devices when one send fails', async () => {
    const keyB64 = mobilePushKeyToBase64(generateMobilePushKey())
    const outcome = await fanOutMobilePush(
      [registration('a', keyB64), registration('b', keyB64), registration('c', keyB64)],
      payload,
      async (request) =>
        request.deviceId === 'b' ? { kind: 'failed', reason: 'network' } : { kind: 'sent' }
    )
    expect(outcome.sentDeviceIds).toEqual(['a', 'c'])
    expect(outcome.failedDeviceIds).toEqual(['b'])
  })

  it('does not reject when a sender throws, and keeps the other devices', async () => {
    const keyB64 = mobilePushKeyToBase64(generateMobilePushKey())
    const outcome = await fanOutMobilePush(
      [registration('a', keyB64), registration('b', keyB64)],
      payload,
      async (request) => {
        if (request.deviceId === 'a') {
          throw new Error('sender exploded')
        }
        return { kind: 'sent' }
      }
    )
    expect(outcome.sentDeviceIds).toEqual(['b'])
    expect(outcome.failedDeviceIds).toEqual(['a'])
  })

  // A corrupt stored key is not an APNs verdict, so the device keeps its
  // registration — re-registering is what repairs it.
  it('reports a device with an unreadable key as failed, not unregistered', async () => {
    const send = vi.fn(async () => ({ kind: 'sent' }) as const)
    const outcome = await fanOutMobilePush([registration('a', 'not-a-key')], payload, send)
    expect(outcome.failedDeviceIds).toEqual(['a'])
    expect(outcome.unregisteredDeviceIds.size).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  // Why only this outcome prunes: a transient failure must not cost a device
  // its registration, or a flaky network would silently unsubscribe phones.
  it('reports only permanent rejections as unregistered, ready for pruning', async () => {
    const keyB64 = mobilePushKeyToBase64(generateMobilePushKey())
    const registrations = [
      registration('gone', keyB64),
      registration('flaky', keyB64),
      registration('ok', keyB64)
    ]
    const outcome = await fanOutMobilePush(registrations, payload, async (request) => {
      if (request.deviceId === 'gone') {
        return { kind: 'unregistered' }
      }
      return request.deviceId === 'flaky' ? { kind: 'failed', reason: 'timeout' } : { kind: 'sent' }
    })

    expect([...outcome.unregisteredDeviceIds]).toEqual(['gone'])
    const pruned = pruneMobilePushRegistrations(
      { v: 1, registrations },
      outcome.unregisteredDeviceIds
    )
    expect(pruned.registrations.map((entry) => entry.deviceId)).toEqual(['flaky', 'ok'])
  })

  it('does nothing and reports nothing when no device is registered', async () => {
    const send = vi.fn(async () => ({ kind: 'sent' }) as const)
    const outcome = await fanOutMobilePush([], payload, send)
    expect(send).not.toHaveBeenCalled()
    expect(outcome.sentDeviceIds).toEqual([])
    expect(outcome.unregisteredDeviceIds.size).toBe(0)
  })

  it('sends the device token verbatim, since only the sender interprets it', async () => {
    const sent: MobilePushSendRequest[] = []
    await fanOutMobilePush(
      [registration('a', mobilePushKeyToBase64(generateMobilePushKey()))],
      payload,
      async (request) => {
        sent.push(request)
        return { kind: 'sent' }
      }
    )
    expect(sent[0]!.deviceToken).toBe('token-a')
  })
})
