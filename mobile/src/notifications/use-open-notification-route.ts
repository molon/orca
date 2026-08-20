import { useCallback } from 'react'
import { useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router'
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
  // Global, not local: this hook is used from the root layout, where the local
  // params belong to the root route and never carry the open session's ids. The
  // comparison then never matches and every tap navigates as if the check were
  // not there — which is exactly how it failed the first time.
  const params = useGlobalSearchParams()
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
