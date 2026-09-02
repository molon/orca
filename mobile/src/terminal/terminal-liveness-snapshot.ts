/*
Freezes the diagnostic trail on demand.

The rolling log is a ring: it holds the last stretch of activity and everything
older is gone. That is fine while a fault can be reproduced on request and
useless when it cannot — by the time a fault is noticed, described, and the
phone is back within reach, the evidence has usually been overwritten by
ordinary use. This copies the ring to a file of its own, so the moment the user
saw is kept whether or not it is ever reproduced again.
*/

import { readTerminalLivenessEntries, describeTerminalLivenessState } from './terminal-liveness-log'

const SNAPSHOT_PREFIX = 'orca-terminal-snapshot'
const MAX_SNAPSHOTS = 20

export type TerminalSnapshotResult = {
  readonly fileName: string
  /** Absolute file:// URI, so the caller can hand it to a share sheet. A build
   *  distributed through TestFlight has no get-task-allow, which means its
   *  container cannot be read from a paired Mac — sharing is the only way a
   *  snapshot ever leaves a tester's phone. */
  readonly uri: string
  readonly lineCount: number
}

/** Written by the caller, which knows the screen; this module only knows the log. */
export type TerminalSnapshotContext = Record<string, string | number | boolean | null>

function renderContext(context: TerminalSnapshotContext): string {
  return Object.entries(context)
    .map(([key, value]) => `  ${key}=${String(value)}`)
    .join('\n')
}

/**
 * Writes the current ring plus a state dump to its own file.
 *
 * Never throws: this runs from a button the user presses when something is
 * already wrong, and a failure to record that must not become a second fault on
 * top of the first.
 */
export async function snapshotTerminalLiveness(
  context: TerminalSnapshotContext
): Promise<TerminalSnapshotResult | null> {
  // Read before the first await, so the caller can repair the terminal the
  // moment this returns a promise. Recovering changes every number here, and a
  // snapshot taken after the repair describes the repair, not the fault.
  const entries = readTerminalLivenessEntries()
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
  const body = [
    `# snapshot ${stamp}`,
    renderContext(context),
    describeTerminalLivenessState(),
    '# trail',
    ...entries
  ].join('\n')
  try {
    const { File: FsFile, Directory, Paths } = await import('expo-file-system')
    const fileName = `${SNAPSHOT_PREFIX}-${stamp}.log`
    const file = new FsFile(Paths.document, fileName)
    file.create()
    file.write(`${body}\n`)
    pruneOldSnapshots(new Directory(Paths.document))
    return { fileName, uri: file.uri, lineCount: entries.length }
  } catch {
    return null
  }
}

/** Bounded so a habit of tapping the button cannot fill the user's storage. */
function pruneOldSnapshots(documents: {
  list: () => { name: string; delete: () => void }[]
}): void {
  try {
    const snapshots = documents
      .list()
      .filter((entry) => entry.name.startsWith(SNAPSHOT_PREFIX))
      // Names carry an ISO stamp, so lexical order is chronological.
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const stale of snapshots.slice(0, Math.max(0, snapshots.length - MAX_SNAPSHOTS))) {
      stale.delete()
    }
  } catch {
    // A snapshot that was written but not pruned is still the useful outcome.
  }
}
