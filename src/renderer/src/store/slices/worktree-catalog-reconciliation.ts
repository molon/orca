type CatalogRow = { id: string }

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function catalogValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    return left.every((value, index) => catalogValuesEqual(value, right[index]))
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)])
  for (const key of keys) {
    if (!catalogValuesEqual(left[key], right[key])) {
      return false
    }
  }
  return true
}

// Buckets this small stay cheaper to scan than to index; live catalogs only
// duplicate an id across hosts, so the shipped path never builds an index.
const LINEAR_DUPLICATE_SCAN_LIMIT = 8

type DuplicateIdIndex<T> = {
  fingerprint: (value: unknown) => string
  rowsByFingerprint: Map<string, T[]>
}

// Contract: values that are catalogValuesEqual must fingerprint identically.
// Collisions are free - every hit is still confirmed by catalogValuesEqual.
function createCatalogValueFingerprinter(): (value: unknown) => string {
  const identities = new WeakMap<object, string>()
  let nextIdentity = 0
  const fingerprint = (value: unknown): string => {
    if (Array.isArray(value)) {
      // Array.from materializes holes, which catalogValuesEqual skips over.
      return `[${Array.from(value, (entry) => fingerprint(entry)).join(',')}]`
    }
    if (isPlainRecord(value)) {
      const parts: string[] = []
      for (const key of Object.keys(value)) {
        const entry = value[key]
        if (entry === undefined) {
          continue // an undefined-valued key equals a missing key
        }
        parts.push(`${key}:${fingerprint(entry)}`)
      }
      return `{${parts.sort().join(',')}}`
    }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      let identity = identities.get(value)
      if (identity === undefined) {
        identity = `#${nextIdentity}` // non-plain values only ever match by reference
        nextIdentity += 1
        identities.set(value, identity)
      }
      return identity
    }
    return `${typeof value}:${String(value)}`
  }
  return fingerprint
}

function indexCatalogRowsByFingerprint<T>(rows: readonly T[]): DuplicateIdIndex<T> {
  const fingerprint = createCatalogValueFingerprinter()
  const rowsByFingerprint = new Map<string, T[]>()
  for (const row of rows) {
    const key = fingerprint(row)
    const bucket = rowsByFingerprint.get(key)
    if (bucket) {
      bucket.push(row)
    } else {
      rowsByFingerprint.set(key, [row])
    }
  }
  return { fingerprint, rowsByFingerprint }
}

function takeEqualCatalogRow<T>(candidates: T[], row: T): T | undefined {
  const index = candidates.findIndex((candidate) => catalogValuesEqual(candidate, row))
  return index === -1 ? undefined : candidates.splice(index, 1)[0]
}

function takeFingerprintedCatalogRow<T>(index: DuplicateIdIndex<T>, row: T): T | undefined {
  const bucket = index.rowsByFingerprint.get(index.fingerprint(row))
  return bucket ? takeEqualCatalogRow(bucket, row) : undefined
}

export function reuseEqualCatalogRows<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): T[] {
  if (!current) {
    return [...incoming]
  }
  const currentById = new Map<string, T[]>()
  for (const row of current) {
    const candidates = currentById.get(row.id)
    if (candidates) {
      candidates.push(row)
    } else {
      currentById.set(row.id, [row])
    }
  }
  // Why: a bucket of k same-id rows whose match is not at the head made the
  // linear scan O(k^2) deep compares; oversized buckets switch to a hash join.
  const indexedById = new Map<string, DuplicateIdIndex<T>>()
  const reconciled = incoming.map((row) => {
    const indexed = indexedById.get(row.id)
    if (indexed) {
      return takeFingerprintedCatalogRow(indexed, row) ?? row
    }
    const candidates = currentById.get(row.id)
    if (!candidates || candidates.length === 0) {
      return row
    }
    if (candidates.length <= LINEAR_DUPLICATE_SCAN_LIMIT) {
      return takeEqualCatalogRow(candidates, row) ?? row
    }
    if (catalogValuesEqual(candidates[0], row)) {
      return candidates.shift() ?? row // aligned duplicates keep today's single probe
    }
    const index = indexCatalogRowsByFingerprint(candidates)
    indexedById.set(row.id, index)
    currentById.delete(row.id)
    return takeFingerprintedCatalogRow(index, row) ?? row
  })
  return current.length === reconciled.length &&
    current.every((row, index) => row === reconciled[index])
    ? (current as T[])
    : reconciled
}

export function catalogRowsEqual<T extends CatalogRow>(
  current: readonly T[] | undefined,
  incoming: readonly T[]
): boolean {
  if (current === incoming) {
    return true
  }
  return reuseEqualCatalogRows(current, incoming) === current
}
