// Why: a removed agent id outlives its code inside saved profiles. Most readers
// guard with isTuiAgent(), but `defaultTuiAgent` preselects the launch target
// verbatim, Source Control AI copies its `agentId` into every action recipe,
// and automations dispatch with a raw agentId — all would point at an agent
// that no longer exists. Scrub the profile once at the load boundary so no
// downstream reader has to.

import type { PersistedState } from '../shared/types'

/** Agent ids Orca no longer ships. Keep an entry until profiles predating its removal are gone. */
const RETIRED_AGENTS: readonly unknown[] = ['gemini']

/** Status-bar providers Orca no longer publishes usage for. */
const RETIRED_STATUS_BAR_ITEMS: readonly unknown[] = ['gemini', 'antigravity']

/** GlobalSettings keys owned solely by a retired agent. */
const RETIRED_KEYS: readonly string[] = ['geminiCliOAuthEnabled']

/** Single-agent fields. null reads as "fall back to the default" everywhere. */
const AGENT_ID_KEYS: readonly string[] = ['agentId', 'defaultTuiAgent']

// Why: named explicitly rather than detected, so a repo, host, or worktree
// literally called "gemini" is never mistaken for an agent-keyed map.
const AGENT_KEYED_MAPS: readonly string[] = [
  'agentCmdOverrides',
  'agentDefaultArgs',
  'agentDefaultEnv',
  'selectedModelByAgent',
  'discoveredModelsByAgent'
]
const AGENT_KEYED_MAPS_BY_HOST: readonly string[] = [
  'selectedModelByAgentByHost',
  'discoveredModelsByAgentByHost'
]

type Rec = Record<string, unknown>

function asRecord(value: unknown): Rec | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Rec) : null
}

function dropRetiredKeys(value: unknown): void {
  const record = asRecord(value)
  for (const key of Object.keys(record ?? {})) {
    if (RETIRED_AGENTS.includes(key)) {
      delete record![key]
    }
  }
}

/**
 * One depth-first pass over the profile. Every shape that stores an agent id
 * does it under one of the key names above, at some nesting depth that differs
 * per shape (settings, per-repo overrides, action recipes, automations), so
 * matching on the key rather than the path covers them all.
 */
function scrub(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(scrub)
    return
  }
  const record = asRecord(node)
  if (!record) {
    return
  }
  for (const [key, value] of Object.entries(record)) {
    if (RETIRED_KEYS.includes(key)) {
      delete record[key]
    } else if (AGENT_ID_KEYS.includes(key) && RETIRED_AGENTS.includes(value)) {
      record[key] = null
    } else if (key === 'createdWithAgent' && RETIRED_AGENTS.includes(value)) {
      delete record[key]
    } else if (key === 'disabledTuiAgents' && Array.isArray(value)) {
      record[key] = value.filter((agent) => !RETIRED_AGENTS.includes(agent))
    } else if (key === 'statusBarItems' && Array.isArray(value)) {
      record[key] = value.filter((item) => !RETIRED_STATUS_BAR_ITEMS.includes(item))
    } else if (AGENT_KEYED_MAPS.includes(key)) {
      dropRetiredKeys(value)
    } else if (AGENT_KEYED_MAPS_BY_HOST.includes(key)) {
      Object.values(asRecord(value) ?? {}).forEach(dropRetiredKeys)
    } else {
      scrub(value)
    }
  }
}

/**
 * Rewrites `state` in place. Returns true when anything changed, so the caller
 * can flag the profile for a re-save.
 */
export function cleanRetiredAgentReferences(state: PersistedState): boolean {
  const before = JSON.stringify(state)
  // Why: automations dispatch without the isTuiAgent() guard most readers apply,
  // so clearing the id alone would let them run on whatever agent is default.
  // Scoped to automations on purpose — commitMessageAi also has an `enabled`
  // flag, but there a cleared agent must not switch the whole feature off.
  for (const automation of state.automations ?? []) {
    if (automation && RETIRED_AGENTS.includes(automation.agentId)) {
      automation.enabled = false
    }
  }
  scrub(state)
  return JSON.stringify(state) !== before
}
