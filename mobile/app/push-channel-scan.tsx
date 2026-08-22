import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { ChevronLeft, QrCode } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'
import {
  attachPushChannel,
  describeAttachResult,
  type AttachPushChannelResult
} from '../src/notifications/push-channel-attach'

const RETICLE_SCALE = 0.62
const RETICLE_MAX_SIZE = 360

/**
 * Scans the QR code `orca-push` setup prints.
 *
 * Why a screen of its own rather than a camera inside the host's edit form: the
 * code is the size of a URL, so it needs most of the display to be read at arm's
 * length, and the edit form is a scrolling list of small fields.
 *
 * The host comes in as a parameter because a channel means nothing on its own —
 * the machine that printed the code cannot know what this phone calls it, so the
 * page the scan was started from is what supplies it.
 */
export default function PushChannelScanScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { hostId } = useLocalSearchParams<{ hostId?: string }>()
  const [permission, requestPermission] = useCameraPermissions()
  const [result, setResult] = useState<AttachPushChannelResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [bounds, setBounds] = useState({ width: 0, height: 0 })
  // A camera fires repeatedly while the code stays in frame; without this the
  // same code is attached and subscribed a dozen times over.
  const handledRef = useRef(false)

  const onScanned = useCallback(
    ({ data }: { data: string }) => {
      if (handledRef.current || !hostId) {
        return
      }
      handledRef.current = true
      setBusy(true)
      void attachPushChannel({ blob: data, hostId })
        .then((outcome) => {
          setResult(outcome)
          // Only a code that is not ours is worth another try without leaving:
          // anything else is stored, and rescanning would just repeat it.
          if (outcome.kind === 'unrecognized') {
            handledRef.current = false
          }
        })
        .finally(() => setBusy(false))
    },
    [hostId]
  )

  const padding = {
    paddingTop: insets.top + spacing.sm,
    paddingBottom: insets.bottom + spacing.sm
  }
  const reticleSize = Math.min(
    Math.round(Math.min(bounds.width, bounds.height) * RETICLE_SCALE),
    RETICLE_MAX_SIZE
  )

  if (!hostId) {
    return (
      <View style={[styles.container, padding]}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.centered}>
          <Text style={styles.subtitle}>Open this from a host to say which one it belongs to.</Text>
        </View>
      </View>
    )
  }

  if (!permission) {
    return (
      <View style={[styles.container, padding]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    )
  }

  if (!permission.granted) {
    const canAskAgain = permission.canAskAgain !== false
    return (
      <View style={[styles.container, padding]}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <View style={styles.centered}>
          <Text style={styles.title}>
            {canAskAgain ? 'Scan the channel code' : 'Camera access disabled'}
          </Text>
          <Text style={styles.subtitle}>
            {canAskAgain
              ? 'Run the setup command on that machine and point the camera at the code it prints.'
              : 'Enable camera access in Settings, or go back and paste the code instead.'}
          </Text>
          <Pressable
            style={styles.primaryButton}
            onPress={canAskAgain ? requestPermission : () => void Linking.openSettings()}
          >
            {canAskAgain ? <QrCode size={16} color={colors.bgBase} /> : null}
            <Text style={styles.primaryButtonText}>
              {canAskAgain ? 'Continue' : 'Open Settings'}
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  const described = result ? describeAttachResult(result) : null

  return (
    <View style={[styles.container, padding]}>
      <Pressable style={styles.backButton} onPress={() => router.back()}>
        <ChevronLeft size={22} color={colors.textSecondary} />
      </Pressable>
      <Text style={styles.title}>Scan the channel code</Text>
      <Text style={styles.subtitle}>
        Run the orca-push setup command on that machine; it prints this code in the terminal.
      </Text>

      {result && result.kind !== 'unrecognized' ? (
        <View style={styles.centered}>
          <Text style={described?.kind === 'ok' ? styles.resultOk : styles.resultWarn}>
            {described?.text}
          </Text>
          <Pressable style={styles.primaryButton} onPress={() => router.back()}>
            <Text style={styles.primaryButtonText}>Done</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.cameraWrap} onLayout={(event) => setBounds(event.nativeEvent.layout)}>
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
          <View style={styles.reticle} pointerEvents="none">
            <View style={[styles.reticleFrame, { width: reticleSize, height: reticleSize }]} />
          </View>
          {busy ? (
            <View style={styles.busyOverlay}>
              <ActivityIndicator color={colors.textPrimary} />
            </View>
          ) : null}
        </View>
      )}

      {described && result?.kind === 'unrecognized' ? (
        <Text style={styles.resultWarn}>{described.text}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { backgroundColor: colors.bgBase, flex: 1, paddingHorizontal: spacing.lg },
  backButton: { paddingVertical: spacing.sm, width: 40 },
  centered: { alignItems: 'center', flex: 1, gap: spacing.md, justifyContent: 'center' },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    marginTop: spacing.sm
  },
  subtitle: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    marginTop: spacing.xs
  },
  cameraWrap: {
    borderRadius: radii.camera,
    flex: 1,
    marginTop: spacing.lg,
    marginBottom: spacing.lg,
    overflow: 'hidden'
  },
  camera: { flex: 1 },
  reticle: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0
  },
  reticleFrame: {
    borderColor: colors.textPrimary,
    borderRadius: radii.camera,
    borderWidth: 2,
    opacity: 0.6
  },
  busyOverlay: {
    alignItems: 'center',
    bottom: 0,
    justifyContent: 'center',
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.textPrimary,
    borderRadius: radii.button,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm
  },
  primaryButtonText: { color: colors.bgBase, fontSize: typography.bodySize, fontWeight: '600' },
  resultOk: { color: colors.statusGreen, fontSize: typography.bodySize, lineHeight: 20 },
  resultWarn: { color: colors.textSecondary, fontSize: typography.bodySize, lineHeight: 20 }
})
