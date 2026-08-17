import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { getMobilePushProviderSearchEntry } from './mobile-settings-search'

/**
 * Where the phone's notifications go when it is not connected.
 *
 * Why a provider the user runs rather than a service: the desktop seals every
 * notification for one device before it leaves, so the provider forwards
 * ciphertext it cannot read. That only holds if the user chooses who runs it.
 */
export function MobilePushProviderSection(): React.JSX.Element {
  const [url, setUrl] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [status, setStatus] = useState<'idle' | 'saved' | 'cleared' | 'invalid'>('idle')

  useEffect(() => {
    void window.api.mobile.getPushProvider().then((config) => {
      setUrl(config.url)
      setAuthToken(config.authToken)
    })
  }, [])

  const save = async (): Promise<void> => {
    const result = await window.api.mobile.setPushProvider({ url, authToken })
    if (!result.ok) {
      setStatus('invalid')
      return
    }
    setStatus(result.configured ? 'saved' : 'cleared')
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.MobilePushProviderSection.title',
        'Push Notification Provider'
      )}
      description={translate(
        'auto.components.settings.MobilePushProviderSection.description',
        'Deliver notifications to your phone while it is asleep or disconnected. Notifications are encrypted for each device before they leave this machine, so the provider only ever forwards ciphertext it cannot read. Leave blank to keep notifications on the direct connection only.'
      )}
      keywords={getMobilePushProviderSearchEntry().keywords}
      className="space-y-3 py-2"
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="push-provider-url">
            {translate(
              'auto.components.settings.MobilePushProviderSection.urlLabel',
              'Provider URL'
            )}
          </Label>
          <Input
            id="push-provider-url"
            value={url}
            placeholder="https://push.example.com:8443"
            onChange={(event) => {
              setUrl(event.target.value)
              setStatus('idle')
            }}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="push-provider-token">
            {translate(
              'auto.components.settings.MobilePushProviderSection.tokenLabel',
              'Access Token'
            )}
          </Label>
          <Input
            id="push-provider-token"
            type="password"
            value={authToken}
            onChange={(event) => {
              setAuthToken(event.target.value)
              setStatus('idle')
            }}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button size="sm" onClick={() => void save()}>
            {translate('auto.components.settings.MobilePushProviderSection.save', 'Save')}
          </Button>
          {status !== 'idle' ? (
            <span
              className={
                status === 'invalid' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'
              }
            >
              {status === 'saved'
                ? translate(
                    'auto.components.settings.MobilePushProviderSection.saved',
                    'Saved. Paired phones register on their next connection.'
                  )
                : status === 'cleared'
                  ? translate(
                      'auto.components.settings.MobilePushProviderSection.cleared',
                      'Cleared. Notifications use the direct connection only.'
                    )
                  : translate(
                      'auto.components.settings.MobilePushProviderSection.invalid',
                      'The URL must start with http:// or https://.'
                    )}
            </span>
          ) : null}
        </div>
      </div>
    </SearchableSetting>
  )
}
