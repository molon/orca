// Why: a removed agent id outlives its code inside saved profiles. Most readers
// guard with isTuiAgent(), but `defaultTuiAgent` preselects the launch target
// verbatim and Source Control AI copies its `agentId` into every action recipe
// without validating it — both would point at an agent that no longer exists.
// Scrub the profile once at the load boundary so no downstream reader has to.

import type { PersistedState } from '../shared/types'

/** Agent ids Orca no longer ships. Keep an entry until profiles predating its removal are gone. */
const RETIRED_TUI_AGENT_IDS: readonly string[] = ['gemini']

/** Status-bar providers Orca no longer publishes usage for. */
const RETIRED_STATUS_BAR_ITEM_IDS: readonly string[] = ['gemini', 'antigravity']

/** GlobalSettings keys owned solely by a retired agent. */
const RETIRED_SETTINGS_KEYS: readonly string[] = ['geminiCliOAuthEnabled']

type MutableRecord = Record<string, unknown>

function asRecord(value: unknown): MutableRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as MutableRecord)
    : null
}

function isRetiredAgent(value: unknown): boolean {
  return typeof value === 'string' && RETIRED_TUI_AGENT_IDS.includes(value)
}

/** Drops retired agent ids used as keys of an agent-keyed record. */
function dropRetiredAgentKeys(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  let changed = false
  for (const key of Object.keys(record)) {
    if (isRetiredAgent(key)) {
      delete record[key]
      changed = true
    }
  }
  return changed
}

/** Same, one level deeper: host key -> agent-keyed record. */
function dropRetiredAgentKeysByHost(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  let changed = false
  for (const perHost of Object.values(record)) {
    changed = dropRetiredAgentKeys(perHost) || changed
  }
  return changed
}

/** Clears a retired `agentId` to null, which every reader treats as "fall back to the default". */
function clearRetiredAgentId(value: unknown): boolean {
  const record = asRecord(value)
  if (!record || !isRetiredAgent(record.agentId)) {
    return false
  }
  record.agentId = null
  return true
}

function cleanModelSelections(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  let changed = dropRetiredAgentKeys(record.selectedModelByAgent)
  changed = dropRetiredAgentKeysByHost(record.selectedModelByAgentByHost) || changed
  changed = dropRetiredAgentKeys(record.discoveredModelsByAgent) || changed
  changed = dropRetiredAgentKeysByHost(record.discoveredModelsByAgentByHost) || changed
  return changed
}

function cleanActionRecipes(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  let changed = false
  for (const recipe of Object.values(record)) {
    changed = clearRetiredAgentId(recipe) || changed
  }
  return changed
}

/** Covers both GlobalSettings.sourceControlAi and the per-repo override shape. */
function cleanSourceControlAi(value: unknown): boolean {
  const record = asRecord(value)
  if (!record) {
    return false
  }
  let changed = clearRetiredAgentId(record)
  changed = cleanModelSelections(record) || changed
  changed = cleanActionRecipes(record.actions) || changed
  changed = cleanActionRecipes(record.launchActionDefaults) || changed
  changed = cleanActionRecipes(record.actionOverrides) || changed
  const modelOverrides = asRecord(record.modelOverridesByOperation)
  for (const override of Object.values(modelOverrides ?? {})) {
    changed = cleanModelSelections(override) || changed
  }
  return changed
}

function cleanSettings(value: unknown): boolean {
  const settings = asRecord(value)
  if (!settings) {
    return false
  }
  let changed = false
  for (const key of RETIRED_SETTINGS_KEYS) {
    if (key in settings) {
      delete settings[key]
      changed = true
    }
  }
  if (isRetiredAgent(settings.defaultTuiAgent)) {
    settings.defaultTuiAgent = null
    changed = true
  }
  if (Array.isArray(settings.disabledTuiAgents)) {
    const kept = settings.disabledTuiAgents.filter((agent) => !isRetiredAgent(agent))
    if (kept.length !== settings.disabledTuiAgents.length) {
      settings.disabledTuiAgents = kept
      changed = true
    }
  }
  changed = dropRetiredAgentKeys(settings.agentCmdOverrides) || changed
  changed = dropRetiredAgentKeys(settings.agentDefaultArgs) || changed
  changed = dropRetiredAgentKeys(settings.agentDefaultEnv) || changed
  changed = clearRetiredAgentId(settings.commitMessageAi) || changed
  changed = cleanModelSelections(settings.commitMessageAi) || changed
  changed = cleanSourceControlAi(settings.sourceControlAi) || changed
  return changed
}

function cleanUi(value: unknown): boolean {
  const ui = asRecord(value)
  if (!ui || !Array.isArray(ui.statusBarItems)) {
    return false
  }
  const kept = ui.statusBarItems.filter(
    (item) => typeof item !== 'string' || !RETIRED_STATUS_BAR_ITEM_IDS.includes(item)
  )
  if (kept.length === ui.statusBarItems.length) {
    return false
  }
  ui.statusBarItems = kept
  return true
}

/**
 * Rewrites `state` in place. Returns true when anything changed, so the caller
 * can flag the profile for a re-save.
 */
export function cleanRetiredAgentReferences(state: PersistedState): boolean {
  let changed = cleanSettings(state.settings)
  changed = cleanUi(state.ui) || changed
  for (const repo of state.repos ?? []) {
    changed = cleanSourceControlAi(repo?.sourceControlAi) || changed
  }
  for (const setup of state.projectHostSetups ?? []) {
    changed = cleanSourceControlAi(setup?.sourceControlAi) || changed
  }
  return changed
}
