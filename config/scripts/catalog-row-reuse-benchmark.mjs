#!/usr/bin/env node
import { performance } from 'node:perf_hooks'
import { reuseEqualCatalogRows } from '../../src/renderer/src/store/slices/worktree-catalog-reconciliation.ts'

const ITERATIONS = 10
const WARMUPS = 3

function makeRow(id, seed) {
  return {
    id,
    agent: seed % 2 === 0 ? 'claude' : 'codex',
    sessionId: `session-${seed}`,
    filePath: `/Users/dev/.claude/projects/repo-${seed % 7}/session-${seed}.jsonl`,
    executionHostId: seed % 3 === 0 ? 'local' : `ssh:host-${seed % 3}`,
    title: `Investigate flaky reconnect path ${seed}`,
    updatedAt: `2026-08-13T0${seed % 10}:12:00.000Z`,
    previewMessages: [
      { role: 'user', text: `why does the relay drop frame ${seed}` },
      { role: 'assistant', text: `because the decoder skips unknown opcode ${seed}` }
    ],
    subagent: seed % 5 === 0 ? { name: 'reviewer', model: 'opus' } : undefined
  }
}

const SCENARIOS = [
  {
    label: 'unique unchanged n=200',
    build: () => {
      const current = Array.from({ length: 200 }, (_, index) => makeRow(`row-${index}`, index))
      return { current, incoming: structuredClone(current) }
    }
  },
  {
    label: 'unique unchanged n=1000',
    build: () => {
      const current = Array.from({ length: 1000 }, (_, index) => makeRow(`row-${index}`, index))
      return { current, incoming: structuredClone(current) }
    }
  },
  {
    label: 'unique unchanged n=2000',
    build: () => {
      const current = Array.from({ length: 2000 }, (_, index) => makeRow(`row-${index}`, index))
      return { current, incoming: structuredClone(current) }
    }
  },
  {
    label: 'duplicate head-aligned k=500',
    build: () => {
      const current = Array.from({ length: 500 }, (_, index) => makeRow('dup', index))
      return { current, incoming: structuredClone(current) }
    }
  },
  {
    label: 'duplicate head-aligned k=2000',
    build: () => {
      const current = Array.from({ length: 2000 }, (_, index) => makeRow('dup', index))
      return { current, incoming: structuredClone(current) }
    }
  },
  {
    label: 'duplicate reversed k=500',
    build: () => {
      const current = Array.from({ length: 500 }, (_, index) => makeRow('dup', index))
      return { current, incoming: structuredClone(current.toReversed()) }
    }
  },
  {
    label: 'duplicate reversed k=1000',
    build: () => {
      const current = Array.from({ length: 1000 }, (_, index) => makeRow('dup', index))
      return { current, incoming: structuredClone(current.toReversed()) }
    }
  },
  {
    label: 'duplicate no-match k=500',
    build: () => {
      const current = Array.from({ length: 500 }, (_, index) => makeRow('dup', index))
      const incoming = Array.from({ length: 500 }, (_, index) => makeRow('dup', index + 10_000))
      return { current, incoming }
    }
  },
  {
    label: 'duplicate no-match k=1000',
    build: () => {
      const current = Array.from({ length: 1000 }, (_, index) => makeRow('dup', index))
      const incoming = Array.from({ length: 1000 }, (_, index) => makeRow('dup', index + 10_000))
      return { current, incoming }
    }
  }
]

function measure(scenario) {
  const samples = []
  for (let iteration = 0; iteration < WARMUPS + ITERATIONS; iteration += 1) {
    const { current, incoming } = scenario.build()
    const startedAt = performance.now()
    const reconciled = reuseEqualCatalogRows(current, incoming)
    const elapsedMs = performance.now() - startedAt
    if (reconciled.length !== incoming.length) {
      throw new Error(`Scenario ${scenario.label} produced the wrong row count`)
    }
    if (iteration >= WARMUPS) {
      samples.push(elapsedMs)
    }
  }
  return samples.sort((left, right) => left - right)[Math.floor(samples.length / 2)]
}

console.log('Catalog row reuse (median of 10 runs after 3 warm-ups)')
for (const scenario of SCENARIOS) {
  console.log(`${scenario.label.padEnd(28)} ${measure(scenario).toFixed(3)}ms`)
}
