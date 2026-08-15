// Why a secured file rather than plain JSON: every registration holds a push
// key, which is the secret that makes a sealed notification readable. It gets
// the same handling as the E2EE keypair next to it.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  createMobilePushRegistryState,
  readMobilePushRegistryState,
  type MobilePushRegistryState
} from './mobile-push-registry'

export const MOBILE_PUSH_REGISTRY_FILENAME = 'orca-push-devices.json'

// A registration is a few hundred bytes and the registry is capped at 32
// devices; anything larger is corrupt rather than legitimately big.
const MAX_REGISTRY_FILE_BYTES = 64 * 1024

function registryPath(userDataPath: string): string {
  return join(userDataPath, MOBILE_PUSH_REGISTRY_FILENAME)
}

/**
 * Reads the persisted registry, falling back to empty on anything unreadable.
 *
 * Why it never throws: push is an enhancement layered on a working local
 * notification path. Refusing to start the runtime over a corrupt push file
 * would be a far worse outcome than losing registrations the phones
 * re-establish on their next connection.
 */
export function loadMobilePushRegistry(userDataPath: string): MobilePushRegistryState {
  const filePath = registryPath(userDataPath)
  if (!existsSync(filePath)) {
    return createMobilePushRegistryState()
  }
  try {
    hardenExistingSecureFile(filePath)
    if (statSync(filePath).size > MAX_REGISTRY_FILE_BYTES) {
      return createMobilePushRegistryState()
    }
    return readMobilePushRegistryState(JSON.parse(readFileSync(filePath, 'utf-8')))
  } catch {
    return createMobilePushRegistryState()
  }
}

/**
 * Persists durably: a registration the phone believes succeeded must survive a
 * crash, or the desktop would seal for a device whose key it has forgotten and
 * every push to it would render as placeholder text.
 */
export function saveMobilePushRegistry(userDataPath: string, state: MobilePushRegistryState): void {
  writeDurableSecureJsonFile(registryPath(userDataPath), state)
}
