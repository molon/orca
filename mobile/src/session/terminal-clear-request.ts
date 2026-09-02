import type { RpcClient } from '../transport/rpc-client'
import type { TerminalWebViewHandle } from '../terminal/terminal-webview-contract'

/**
 * Clears one terminal on both sides.
 *
 * The local xterm is cleared first and unconditionally: it is the half the user
 * is looking at, and leaving it full while the host clears would read as the
 * command having done nothing.
 */
export async function clearTerminalOnHostAndPane(
  client: Pick<RpcClient, 'sendRequest'> | null,
  handle: string,
  getTerminalRef: (handle: string) => TerminalWebViewHandle | undefined,
  showToast: (message: string, durationMs?: number) => void
): Promise<void> {
  if (!client) {
    return
  }
  getTerminalRef(handle)?.clear()
  try {
    await client.sendRequest('terminal.clearBuffer', { terminal: handle })
    showToast('Terminal cleared')
  } catch {
    showToast("Couldn't clear terminal", 1500)
  }
}
