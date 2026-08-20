import {
  readPushNotificationsPreference,
  savePushNotificationsEnabled
} from '../storage/preferences'
import { getNotificationPermissionState } from './mobile-notifications'

export async function shouldPresentNotificationOptIn(): Promise<boolean> {
  const preference = await readPushNotificationsPreference()
  if (!preference.loaded || preference.value !== null) {
    return false
  }

  try {
    const permission = await getNotificationPermissionState()
    if (permission.granted) {
      if (!permission.authorizationReflectsUserChoice) {
        return true
      }
      // Why false rather than true: permission is already granted, so remote
      // push can show. Turning local delivery on as well would double up on a
      // phone that has push, and this screen is not where that is decided.
      await savePushNotificationsEnabled(false)
      return false
    }
    if (permission.status === 'denied' || !permission.canAskAgain) {
      // Why: iOS cannot show its authorization prompt again, so a blocking
      // onboarding screen would be a dead end; Settings remains the recovery.
      await savePushNotificationsEnabled(false)
      return false
    }
    return permission.status === 'undetermined'
  } catch {
    // Why: permission or persistence failures must not trap startup behind a
    // decision screen whose result cannot be applied reliably.
    return false
  }
}
