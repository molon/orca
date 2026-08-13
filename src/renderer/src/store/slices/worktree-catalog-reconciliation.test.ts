import { describe, expect, it } from 'vitest'
import { catalogRowsEqual, reuseEqualCatalogRows } from './worktree-catalog-reconciliation'

describe('reuseEqualCatalogRows', () => {
  it('does not traverse a catalog already reconciled by identity', () => {
    const current = [
      {
        get id(): string {
          throw new Error('catalog row was traversed')
        }
      }
    ]

    expect(catalogRowsEqual(current, current)).toBe(true)
  })

  it('reuses rows with equivalent nested catalog data', () => {
    const current = [
      { id: 'a', nested: { labels: ['one', 'two'] }, optional: undefined },
      { id: 'b', nested: { labels: ['three'] } }
    ]
    const incoming = [
      { id: 'a', nested: { labels: ['one', 'two'] } },
      { id: 'b', nested: { labels: ['three'] } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).toBe(current)
    expect(catalogRowsEqual(current, incoming)).toBe(true)
  })

  it('reuses unaffected rows while publishing nested changes', () => {
    const current = [
      { id: 'a', nested: { value: 1 } },
      { id: 'b', nested: { value: 2 } }
    ]
    const incoming = [
      { id: 'a', nested: { value: 3 } },
      { id: 'b', nested: { value: 2 } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled[0]).toBe(incoming[0])
    expect(reconciled[1]).toBe(current[1])
  })

  it('does not hide host ownership changes', () => {
    const current = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-a' }]
    const incoming = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-b' }]

    expect(reuseEqualCatalogRows(current, incoming)[0]).toBe(incoming[0])
  })

  it('reuses same-ID rows from different hosts independently', () => {
    const current = [
      { id: 'repo::/same/path', hostId: 'ssh:a' },
      { id: 'repo::/same/path', hostId: 'ssh:b' }
    ]
    const equivalent = structuredClone(current)

    expect(reuseEqualCatalogRows(current, equivalent)).toBe(current)

    const incoming = structuredClone(current.toReversed())
    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled.map((row) => row.hostId)).toEqual(['ssh:b', 'ssh:a'])
    expect(reconciled[0]).toBe(current[1])
    expect(reconciled[1]).toBe(current[0])
  })
})

type TaggedRow = { id: string; tag: string }

// Counting the deep-compare reads is the only observable difference between the
// linear scan and the fingerprint join; the accessor keeps Object.prototype so
// the row still reads as a plain record.
function countingRow(id: string, tag: string, reads: { count: number }): TaggedRow {
  const row = { id } as TaggedRow
  Object.defineProperty(row, 'tag', {
    enumerable: true,
    get: () => {
      reads.count += 1
      return tag
    }
  })
  return row
}

describe('duplicate catalog ids', () => {
  it('stops rescanning a duplicate-id bucket for every incoming row', () => {
    const reads = { count: 0 }
    const current = Array.from({ length: 200 }, (_, index) =>
      countingRow('dup', `row-${index}`, reads)
    )
    const incoming = Array.from({ length: 200 }, (_, index) => ({
      id: 'dup',
      tag: `other-${index}`
    }))

    const reconciled = reuseEqualCatalogRows(current, incoming)
    const readCount = reads.count

    expect(reconciled.every((row, index) => row === incoming[index])).toBe(true)
    expect(readCount).toBeLessThan(1000)
  })

  it('reuses reordered duplicate-id rows without rescanning', () => {
    const reads = { count: 0 }
    const current = Array.from({ length: 200 }, (_, index) =>
      countingRow('dup', `row-${index}`, reads)
    )
    const incoming = Array.from({ length: 200 }, (_, index) => ({
      id: 'dup',
      tag: `row-${199 - index}`
    }))

    const reconciled = reuseEqualCatalogRows(current, incoming)
    const readCount = reads.count

    expect(reconciled.every((row, index) => row === current[199 - index])).toBe(true)
    expect(readCount).toBeLessThan(1000)
  })

  it('compares each unique-id row once', () => {
    const reads = { count: 0 }
    const current = Array.from({ length: 200 }, (_, index) =>
      countingRow(`row-${index}`, `tag-${index}`, reads)
    )
    const incoming = Array.from({ length: 200 }, (_, index) => ({
      id: `row-${index}`,
      tag: `tag-${index}`
    }))

    const reconciled = reuseEqualCatalogRows(current, incoming)
    const readCount = reads.count

    expect(reconciled).toBe(current)
    expect(readCount).toBe(200)
  })

  it('consumes each duplicate-id row at most once', () => {
    const current = Array.from({ length: 12 }, (_, index) => ({ id: 'dup', seq: index % 3 }))
    const incoming = Array.from({ length: 12 }, () => ({ id: 'dup', seq: 0 }))

    const reconciled = reuseEqualCatalogRows(current, incoming)
    const reused = reconciled.filter((row) => current.includes(row))

    expect(reused).toHaveLength(4)
    expect(new Set(reused).size).toBe(4)
    expect(reconciled.filter((row) => incoming.includes(row))).toHaveLength(8)
  })

  it('reuses duplicate-id rows whose only difference is an undefined-valued key', () => {
    const current = Array.from({ length: 12 }, (_, index) => ({
      id: 'dup',
      seq: index,
      optional: undefined
    }))
    const incoming = Array.from({ length: 12 }, (_, index) => ({ id: 'dup', seq: 11 - index }))

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled.every((row, index) => row === current[11 - index])).toBe(true)
  })

  it('treats NaN as reusable and -0 as changed inside a duplicate bucket', () => {
    const current = Array.from({ length: 12 }, (_, index) => ({
      id: 'dup',
      seq: index,
      score: Number.NaN,
      ratio: 0
    }))
    const incoming = Array.from({ length: 12 }, (_, index) => ({
      id: 'dup',
      seq: 11 - index,
      score: Number.NaN,
      ratio: index === 0 ? -0 : 0
    }))

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled[0]).toBe(incoming[0])
    expect(reconciled.slice(1).every((row, index) => row === current[10 - index])).toBe(true)
  })

  it('does not reuse structurally equal non-plain values in a duplicate bucket', () => {
    const current = Array.from({ length: 12 }, (_, index) => ({
      id: 'dup',
      seq: index,
      stamp: new Date(0)
    }))
    const incoming = Array.from({ length: 12 }, (_, index) => ({
      id: 'dup',
      seq: 11 - index,
      stamp: new Date(0)
    }))

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled.every((row, index) => row === incoming[index])).toBe(true)
  })

  it('reconciles adds, removals and reorders for unique ids', () => {
    const current = [
      { id: 'a', value: 1 },
      { id: 'b', value: 2 },
      { id: 'c', value: 3 }
    ]

    const removed = reuseEqualCatalogRows(current, structuredClone([current[0], current[2]]))
    expect(removed).toHaveLength(2)
    expect(removed[0]).toBe(current[0])
    expect(removed[1]).toBe(current[2])

    const added = structuredClone([...current, { id: 'd', value: 4 }])
    const grown = reuseEqualCatalogRows(current, added)
    expect(grown).not.toBe(current)
    expect(grown.slice(0, 3).every((row, index) => row === current[index])).toBe(true)
    expect(grown[3]).toBe(added[3])

    const reordered = reuseEqualCatalogRows(
      current,
      structuredClone([current[2], current[0], current[1]])
    )
    expect(reordered).not.toBe(current)
    expect(reordered[0]).toBe(current[2])
    expect(reordered[1]).toBe(current[0])
    expect(reordered[2]).toBe(current[1])
  })

  it('reports duplicate-id equality unchanged through catalogRowsEqual', () => {
    const current = Array.from({ length: 12 }, (_, index) => ({ id: 'dup', seq: index }))

    expect(catalogRowsEqual(current, structuredClone(current))).toBe(true)

    const mutated = structuredClone(current)
    mutated[7] = { id: 'dup', seq: 99 }
    expect(catalogRowsEqual(current, mutated)).toBe(false)
  })
})
