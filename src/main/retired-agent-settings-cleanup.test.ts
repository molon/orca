import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../shared/types'
import { cleanRetiredAgentReferences } from './retired-agent-settings-cleanup'

// Retired ids are gone from the TuiAgent union, so profiles are built untyped here.
function profile(overrides: Record<string, unknown>): PersistedState {
  return {
    repos: [],
    projectHostSetups: [],
    settings: {},
    ui: {},
    ...overrides
  } as unknown as PersistedState
}

describe('cleanRetiredAgentReferences', () => {
  it('leaves a profile without retired agents untouched', () => {
    const state = profile({
      settings: { defaultTuiAgent: 'claude', agentCmdOverrides: { codex: 'codex-next' } }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(false)
    expect(state.settings.defaultTuiAgent).toBe('claude')
    expect(state.settings.agentCmdOverrides).toEqual({ codex: 'codex-next' })
  })

  it('resets defaultTuiAgent so the composer does not preselect a missing agent', () => {
    const state = profile({ settings: { defaultTuiAgent: 'gemini' } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings.defaultTuiAgent).toBeNull()
  })

  it('preserves blank as an explicit shell-only preference', () => {
    const state = profile({ settings: { defaultTuiAgent: 'blank' } })
    expect(cleanRetiredAgentReferences(state)).toBe(false)
    expect(state.settings.defaultTuiAgent).toBe('blank')
  })

  it('drops retired keys from agent-keyed launch settings', () => {
    const state = profile({
      settings: {
        disabledTuiAgents: ['gemini', 'droid'],
        agentCmdOverrides: { gemini: '/usr/local/bin/gemini', claude: 'claude' },
        agentDefaultArgs: { gemini: '--yolo' },
        agentDefaultEnv: { gemini: { GEMINI_API_KEY: 'x' }, codex: { A: '1' } }
      }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings.disabledTuiAgents).toEqual(['droid'])
    expect(state.settings.agentCmdOverrides).toEqual({ claude: 'claude' })
    expect(state.settings.agentDefaultArgs).toEqual({})
    expect(state.settings.agentDefaultEnv).toEqual({ codex: { A: '1' } })
  })

  it('clears the Source Control AI agent before it is copied into action recipes', () => {
    const state = profile({
      settings: {
        sourceControlAi: {
          agentId: 'gemini',
          selectedModelByAgent: { gemini: 'gemini-3-pro', claude: 'opus' },
          selectedModelByAgentByHost: { 'ssh:box': { gemini: 'gemini-3-pro' } },
          discoveredModelsByAgent: { gemini: [] },
          actions: {
            commitMessage: { agentId: 'gemini', commandInputTemplate: '{diff}' },
            pullRequest: { agentId: 'claude' }
          },
          launchActionDefaults: { fixCommitFailure: { agentId: 'gemini' } },
          modelOverridesByOperation: { commitMessage: { selectedModelByAgent: { gemini: 'x' } } }
        }
      }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    const ai = state.settings.sourceControlAi as unknown as Record<string, unknown>
    expect(ai).toEqual({
      agentId: null,
      selectedModelByAgent: { claude: 'opus' },
      selectedModelByAgentByHost: { 'ssh:box': {} },
      discoveredModelsByAgent: {},
      actions: {
        commitMessage: { agentId: null, commandInputTemplate: '{diff}' },
        pullRequest: { agentId: 'claude' }
      },
      launchActionDefaults: { fixCommitFailure: { agentId: null } },
      modelOverridesByOperation: { commitMessage: { selectedModelByAgent: {} } }
    })
  })

  it('clears the legacy commitMessageAi agent', () => {
    const state = profile({
      settings: { commitMessageAi: { agentId: 'gemini', selectedModelByAgent: { gemini: 'x' } } }
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings.commitMessageAi).toEqual({ agentId: null, selectedModelByAgent: {} })
  })

  it('drops the removed Gemini CLI OAuth toggle', () => {
    const state = profile({ settings: { geminiCliOAuthEnabled: true, terminalFontSize: 13 } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.settings).toEqual({ terminalFontSize: 13 })
  })

  it('drops status-bar entries for providers that no longer report usage', () => {
    const state = profile({ ui: { statusBarItems: ['claude', 'gemini', 'antigravity', 'ports'] } })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.ui.statusBarItems).toEqual(['claude', 'ports'])
  })

  it('cleans repo and project-host-setup overrides', () => {
    const state = profile({
      repos: [{ sourceControlAi: { actionOverrides: { commitMessage: { agentId: 'gemini' } } } }],
      projectHostSetups: [
        { sourceControlAi: { actionOverrides: { pullRequest: { agentId: 'gemini' } } } }
      ]
    })
    expect(cleanRetiredAgentReferences(state)).toBe(true)
    expect(state.repos[0].sourceControlAi?.actionOverrides?.commitMessage?.agentId).toBeNull()
    expect(
      state.projectHostSetups[0].sourceControlAi?.actionOverrides?.pullRequest?.agentId
    ).toBeNull()
  })

  it('tolerates a profile missing every optional collection', () => {
    expect(cleanRetiredAgentReferences({} as PersistedState)).toBe(false)
  })
})
