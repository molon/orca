// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MobilePushProviderSection } from './MobilePushProviderSection'

const getPushProvider = vi.fn(async () => ({ url: '', authToken: '' }))
const setPushProvider = vi.fn(async () => ({ ok: true, configured: true }))

function field(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement
}

beforeEach(() => {
  vi.clearAllMocks()
  getPushProvider.mockResolvedValue({ url: '', authToken: '' })
  setPushProvider.mockResolvedValue({ ok: true, configured: true })
  ;(window as unknown as { api: unknown }).api = {
    mobile: { getPushProvider, setPushProvider }
  }
})

afterEach(() => {
  cleanup()
})

describe('MobilePushProviderSection', () => {
  // Why the token is shown rather than write-only: the user cannot otherwise
  // answer "is this the same token my provider is running with?".
  it('shows what is already configured', async () => {
    getPushProvider.mockResolvedValue({ url: 'https://push.example', authToken: 'secret' })
    render(<MobilePushProviderSection />)

    await vi.waitFor(() => expect(field('push-provider-url').value).toBe('https://push.example'))
    expect(field('push-provider-token').value).toBe('secret')
  })

  // The token is a secret the user may be reading off a screen share.
  it('masks the token', async () => {
    render(<MobilePushProviderSection />)
    await vi.waitFor(() => expect(field('push-provider-token')).toBeTruthy())
    expect(field('push-provider-token').type).toBe('password')
  })

  it('saves both fields together', async () => {
    render(<MobilePushProviderSection />)
    await userEvent.type(field('push-provider-url'), 'https://push.example')
    await userEvent.type(field('push-provider-token'), 'secret')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    expect(setPushProvider).toHaveBeenCalledWith({
      url: 'https://push.example',
      authToken: 'secret'
    })
    await screen.findByText(/paired phones register/i)
  })

  // Clearing is the documented way to turn push off, so it has to read as a
  // successful change rather than a failed save.
  it('reports that clearing turns push off', async () => {
    setPushProvider.mockResolvedValue({ ok: true, configured: false })
    render(<MobilePushProviderSection />)
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await screen.findByText(/direct connection only/i)
  })

  it('surfaces a rejected url instead of looking saved', async () => {
    setPushProvider.mockResolvedValue({ ok: false, configured: false })
    render(<MobilePushProviderSection />)
    await userEvent.type(field('push-provider-url'), 'push.example')
    await userEvent.click(screen.getByRole('button', { name: /save/i }))

    await screen.findByText(/must start with http/i)
  })
})
