import { useCallback } from 'react'
import { useLocalSearchParams, usePathname, useRouter, useSegments } from 'expo-router'
import { hostStackHostRoute } from '../navigation/host-stack-navigation'
import { useOpenHostStackRoute } from '../navigation/use-open-host-stack-route'
import {
  notificationCredentialRecoveryRoute,
  type NotificationNavigationTarget
} from './notification-routing'
import { isNotificationRouteAlreadyOpen } from './notification-route-already-open'

export function useOpenNotificationRoute(): (target: NotificationNavigationTarget) => void {
  const openHostStackRoute = useOpenHostStackRoute()
  const router = useRouter()
  const segments = useSegments()
  const params = useLocalSearchParams()
  const pathname = usePathname()

  return useCallback(
    (target) => {
      const recoveryRoute = notificationCredentialRecoveryRoute(target)
      if (recoveryRoute) {
        router.push(recoveryRoute)
        return
      }
      if (target.sessionTarget) {
        // Why a no-op rather than a push: tapping a notification for the
        // session already on screen would stack a second copy of it, leaving a
        // back button that appears to go nowhere.
        if (
          isNotificationRouteAlreadyOpen(target.sessionTarget, {
            segments,
            params: params as Record<string, unknown>
          })
        ) {
          return
        }
        openHostStackRoute(target.hostId, target.sessionTarget)
        return
      }
      const hostRoute = hostStackHostRoute(target.hostId)
      if (pathname === hostRoute) {
        return
      }
      router.push(hostRoute)
    },
    [openHostStackRoute, params, pathname, router, segments]
  )
}
