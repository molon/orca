import { flog } from './viewport-transform'
import { applyTerminalTheme } from './terminal-theme'
import type { TerminalDocumentScope, TerminalDocumentWebglAddon } from './document-scope'
import { pumpWrites } from './write-queue'

export function refreshTerminalSurface(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  try {
    scope.term.refresh(0, Math.max(0, scope.term.rows - 1))
  } catch {}
}

export function cancelWebglContextRecovery(scope: TerminalDocumentScope) {
  if (!scope.webglRecoveryTimer) {
    return
  }
  clearTimeout(scope.webglRecoveryTimer)
  scope.webglRecoveryTimer = null
}

export function attachWebglAddon(scope: TerminalDocumentScope, allowRecovery: boolean) {
  if (!scope.term) {
    return false
  }
  let addon: TerminalDocumentWebglAddon | null = null
  try {
    addon = scope.createWebglAddon()
    // Why: no addon is the DOM renderer, which is a fallback rather than a failure; the
    // catch below is for an engine that has one and threw building it.
    if (!addon) {
      return false
    }
    scope.webglAddon = addon
    if (addon.onContextLoss) {
      addon.onContextLoss(function () {
        if (scope.webglAddon !== addon) {
          return
        }
        flog(scope, 'webgl-context-loss', { retry: allowRecovery })
        scope.webglAddon = null
        try {
          addon!.dispose()
        } catch {}
        refreshTerminalSurface(scope)
        if (!allowRecovery) {
          return
        }
        // Why: one delayed retry handles transient iOS context loss without
        // entering a GPU crash loop; a second loss stays on the DOM renderer.
        cancelWebglContextRecovery(scope)
        const recoveryTerm = scope.term
        const recoveryGeneration = scope.terminalGeneration
        scope.webglRecoveryTimer = setTimeout(function () {
          scope.webglRecoveryTimer = null
          if (scope.term !== recoveryTerm || scope.terminalGeneration !== recoveryGeneration) {
            return
          }
          attachWebglAddon(scope, false)
        }, 100)
      })
    }
    scope.term.loadAddon(addon)
    if (!allowRecovery) {
      try {
        if (addon.clearTextureAtlas) {
          addon.clearTextureAtlas()
        }
      } catch {}
      refreshTerminalSurface(scope)
    }
    return true
  } catch (e) {
    flog(scope, 'webgl-attach-failed', { retry: !allowRecovery, message: String(e) })
    if (scope.webglAddon === addon) {
      scope.webglAddon = null
    }
    try {
      if (addon) {
        addon.dispose()
      }
    } catch {}
    refreshTerminalSurface(scope)
    return false
  }
}

/**
 * Everything the visibility path does, plus a nudge to the write queue, since a stuck queue and
 * dropped GPU pixels look identical from outside. Safe on a healthy terminal — pumpWrites releases
 * a drain only once it is stalled — which is what lets the app run it on every activation.
 */
export function forceTerminalRepaint(scope: TerminalDocumentScope) {
  pumpWrites(scope, scope.terminalGeneration)
  applyTerminalTheme(scope, scope.terminalThemeInput)
  try {
    if (scope.webglAddon && scope.webglAddon.clearTextureAtlas) {
      scope.webglAddon.clearTextureAtlas()
    }
  } catch {}
  refreshTerminalSurface(scope)
  flog(scope, 'forced-repaint', {
    gen: scope.terminalGeneration,
    queued: scope.writeQueue.length - scope.writeQueueHead
  })
}

function onDocumentVisibilityChange(scope: TerminalDocumentScope) {
  if (document.visibilityState !== 'visible') {
    return
  }
  // Why: iOS may restore the xterm model while discarding GPU pixels/theme
  // paint state, so visibility must rebuild the atlas and repaint every row.
  applyTerminalTheme(scope, scope.terminalThemeInput)
  try {
    if (scope.webglAddon && scope.webglAddon.clearTextureAtlas) {
      scope.webglAddon.clearTextureAtlas()
    }
  } catch {}
  refreshTerminalSurface(scope)
}

export function startWebglRecovery(scope: TerminalDocumentScope) {
  const onVisibilityChange = () => onDocumentVisibilityChange(scope)
  document.addEventListener('visibilitychange', onVisibilityChange)
  scope.removeWebglRecovery = () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export function stopWebglRecovery(scope: TerminalDocumentScope) {
  if (scope.removeWebglRecovery) {
    scope.removeWebglRecovery()
    scope.removeWebglRecovery = null
  }
  cancelWebglContextRecovery(scope)
}
