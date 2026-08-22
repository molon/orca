import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { colors } from '../theme/mobile-theme'
import { deletePushChannel, loadPushChannel } from '../notifications/push-channel-store'
import { unsubscribeFromPushChannel } from '../notifications/push-channel-subscription'
import { loadChannelIdForHost, saveChannelIdForHost } from '../notifications/push-channel-index'
import { attachPushChannel, describeAttachResult } from '../notifications/push-channel-attach'

/**
 * Where a machine's pairing string is pasted.
 *
 * Why it lives on a host's page rather than in global settings: the string
 * cannot carry which host it belongs to — the machine that printed it has no
 * idea what this phone calls it — so the page it is pasted into is what
 * supplies that, and what makes a tapped notification land in the right place.
 */
export function PushChannelSection({ hostId }: { hostId: string }): React.JSX.Element {
  const router = useRouter()
  const [blob, setBlob] = useState('')
  const [channelId, setChannelId] = useState<string | null>(null)
  // Why a kind and not just text: "saved" and "could not reach the server" read
  // the same in grey, and the user is left guessing which one happened.
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // On focus, not once on mount: the scanner attaches the channel on its own
  // screen, so coming back from it is exactly when this is out of date.
  useFocusEffect(
    useCallback(() => {
      void loadChannelIdForHost(hostId).then(setChannelId)
    }, [hostId])
  )

  const save = async (): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      const result = await attachPushChannel({ blob, hostId })
      if (result.kind !== 'unrecognized') {
        setChannelId(result.channelId)
        setBlob('')
      }
      setStatus(describeAttachResult(result))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!channelId) {
      return
    }
    setBusy(true)
    try {
      const stored = await loadPushChannel(channelId)
      if (stored) {
        // Told explicitly because APNs would never report a still-valid token
        // as gone — the server has to be asked to stop.
        await unsubscribeFromPushChannel({
          provider: stored.provider,
          keyB64: stored.pushKeyB64,
          channelId,
          authToken: stored.authToken
        })
      }
      await deletePushChannel(channelId)
      await saveChannelIdForHost(hostId, null)
      setChannelId(null)
      setStatus({ kind: 'ok', text: 'Removed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.section}>
      <Text style={styles.label}>Remote notifications</Text>
      {channelId ? (
        <View>
          <View style={styles.connectedRow}>
            <View style={styles.connectedDot} />
            <Text style={styles.connectedText}>Connected · channel {channelId.slice(0, 8)}</Text>
          </View>
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => void remove()}
            disabled={busy}
          >
            <Text style={styles.removeText}>Remove</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View>
          {/* Scanning first, because it is the path that does not involve moving
              a 200-character string between two machines by hand. */}
          <TouchableOpacity
            style={styles.saveButton}
            onPress={() => router.push(`/push-channel-scan?hostId=${encodeURIComponent(hostId)}`)}
            disabled={busy}
          >
            <Text style={styles.saveText}>Scan the code from setup</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={blob}
            onChangeText={setBlob}
            placeholder="…or paste the string instead"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
          />
          <TouchableOpacity
            style={styles.pasteButton}
            onPress={() => void save()}
            disabled={busy || blob.trim().length === 0}
          >
            {busy ? (
              <ActivityIndicator color={colors.textSecondary} />
            ) : (
              <Text style={styles.pasteText}>Connect</Text>
            )}
          </TouchableOpacity>
        </View>
      )}
      <Text style={styles.hint}>
        Notifications are encrypted on that machine, so the server they travel through cannot read
        them.
      </Text>
      {status ? (
        <Text style={status.kind === 'ok' ? styles.statusOk : styles.status}>{status.text}</Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { marginTop: 24, gap: 8 },
  label: { color: colors.textPrimary, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.bgPanel,
    borderRadius: 10,
    color: colors.textPrimary,
    fontSize: 13,
    marginTop: 8,
    minHeight: 72,
    padding: 12,
    textAlignVertical: 'top'
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: colors.accentBlue,
    borderRadius: 10,
    marginTop: 8,
    paddingVertical: 12
  },
  saveText: { color: colors.textPrimary, fontSize: 14, fontWeight: '600' },
  pasteButton: { alignItems: 'center', marginTop: 8, paddingVertical: 8 },
  pasteText: { color: colors.textSecondary, fontSize: 14 },
  removeButton: { marginTop: 8, paddingVertical: 8 },
  removeText: { color: colors.textSecondary, fontSize: 14 },
  hint: { color: colors.textMuted, fontSize: 12, lineHeight: 17 },
  status: { color: colors.textSecondary, fontSize: 12, lineHeight: 17 },
  statusOk: { color: colors.statusGreen, fontSize: 12, lineHeight: 17 },
  connectedRow: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  connectedDot: {
    backgroundColor: colors.statusGreen,
    borderRadius: 4,
    height: 8,
    width: 8
  },
  connectedText: { color: colors.textPrimary, fontSize: 13 }
})
