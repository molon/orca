import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import type { RpcClient } from '../transport/rpc-client'
import { isTerminalSendRpcAccepted } from './terminal-send-rpc-response'
import { logTerminalLiveness } from './terminal-liveness-log'

type TerminalSubscriptionRegistry = {
  has: (handle: string) => boolean
}

type MobileTerminalQueryReplyOptions = {
  bytes: string
  client: Pick<RpcClient, 'sendRequest'> | null
  clientId: string | null
  connected: boolean
  handle: string
  hostSupportsQueryReplyInput: boolean
  subscribedTerminals: TerminalSubscriptionRegistry
}

export function sendMobileTerminalQueryReply({
  bytes,
  client,
  clientId,
  connected,
  handle,
  hostSupportsQueryReplyInput,
  subscribedTerminals
}: MobileTerminalQueryReplyOptions): Promise<boolean> {
  // Why: every subscribed mobile xterm suppresses main's responder, including
  // hidden panes, so ownership follows the subscription rather than focus.
  // Hosts without terminal.query-reply-input.v1 strip inputKind and would take
  // reply bytes as floor-stealing shell input, so drop (pre-fix behavior).
  if (
    !client ||
    !connected ||
    !hostSupportsQueryReplyInput ||
    !subscribedTerminals.has(handle) ||
    !isTerminalQueryReply(bytes)
  ) {
    return Promise.resolve(false)
  }

  return client
    .sendRequest('terminal.send', {
      terminal: handle,
      text: bytes,
      enter: false,
      inputKind: 'query-reply',
      ...(clientId ? { client: { id: clientId, type: 'mobile' as const } } : {})
    })
    .then(isTerminalSendRpcAccepted, () => false)
    .then((accepted) => {
      // Diagnostics: refused means nobody answered, because a subscribed mobile
      // xterm has already silenced main's responder. A program that probes the
      // terminal on startup then waits on a reply that is never coming.
      logTerminalLiveness('query-reply', {
        handle: handle.slice(-8),
        bytes: JSON.stringify(bytes),
        accepted
      })
      return accepted
    })
}
