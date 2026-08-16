const fs = require('node:fs')
const path = require('node:path')
const {
  withXcodeProject,
  withEntitlementsPlist,
  withInfoPlist,
  withDangerousMod
} = require('expo/config-plugins')

// Why a target and not just app code: iOS only lets a Notification Service
// Extension rewrite a push before it is shown, and an extension is a separate
// binary with its own process, entitlements, and Info.plist. That cannot be
// expressed in app source, so the Xcode project has to grow a target — and
// prebuild regenerates the project, so it has to happen here.
const TARGET_NAME = 'OrcaNotificationService'
const SOURCE_FILES = [
  'NotificationService.swift',
  'OrcaPushEnvelope.swift',
  'OrcaPushKeychain.swift'
]
// Info.plist key the extension reads to find the shared keychain group.
const ACCESS_GROUP_INFO_KEY = 'OrcaPushKeychainAccessGroup'
// Where the app's JS side reads the same group from, so it writes the key into
// the group the extension reads rather than the app's default one.
const ACCESS_GROUP_EXTRA_KEY = 'orcaPushKeychainAccessGroup'

/** Keychain groups must carry the team prefix, so both sides are written as
 *  literals rather than `$(AppIdentifierPrefix)`: the JS side has no way to
 *  expand a build variable, and it has to name the identical string. */
function keychainGroupsFor(bundleIdentifier, appleTeamId) {
  if (!appleTeamId) {
    return null
  }
  return {
    // First entry is the default group for items stored without an explicit
    // one. Keeping the plain app identifier first leaves every other secret —
    // the pairing credentials above all — where it already was, out of reach
    // of the extension.
    appDefault: `${appleTeamId}.${bundleIdentifier}`,
    shared: `${appleTeamId}.${bundleIdentifier}.push`
  }
}

/** Copies the Swift sources and the extension Info.plist into the generated
 *  ios/ tree. prebuild wipes that tree, so this reruns every time. */
function withExtensionSources(config, appleTeamId) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot
      const platformRoot = cfg.modRequest.platformProjectRoot
      const targetDir = path.join(platformRoot, TARGET_NAME)
      fs.mkdirSync(targetDir, { recursive: true })

      const sourceDir = path.join(projectRoot, 'plugins', 'notification-service-extension')
      for (const file of SOURCE_FILES) {
        fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file))
      }

      const groups = keychainGroupsFor(cfg.ios?.bundleIdentifier ?? '', appleTeamId)
      fs.writeFileSync(
        path.join(targetDir, 'Info.plist'),
        buildExtensionInfoPlist(groups?.shared),
        'utf8'
      )
      fs.writeFileSync(
        path.join(targetDir, `${TARGET_NAME}.entitlements`),
        buildExtensionEntitlements(groups?.shared),
        'utf8'
      )
      return cfg
    }
  ])
}

/** Without a team id there is no valid group name, so the key is left out and
 *  the extension falls back to placeholder text rather than reading the wrong
 *  keychain group. */
function buildExtensionInfoPlist(sharedGroup) {
  const accessGroupEntry = sharedGroup
    ? `
    <key>${ACCESS_GROUP_INFO_KEY}</key>
    <string>${sharedGroup}</string>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
    <string>${TARGET_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <!-- Xcode supplies this for its own templates but not for a plist written
         by hand: without it iOS cannot tell which binary the extension runs,
         and installing the app fails outright on the extension placeholder. -->
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleName</key>
    <string>$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>$(MARKETING_VERSION)</string>
    <key>CFBundleVersion</key>
    <string>$(CURRENT_PROJECT_VERSION)</string>${accessGroupEntry}
    <key>NSExtension</key>
    <dict>
      <key>NSExtensionPointIdentifier</key>
      <string>com.apple.usernotifications.service</string>
      <key>NSExtensionPrincipalClass</key>
      <string>$(PRODUCT_MODULE_NAME).NotificationService</string>
    </dict>
  </dict>
</plist>
`
}

function buildExtensionEntitlements(sharedGroup) {
  const groups = sharedGroup
    ? `
    <key>keychain-access-groups</key>
    <array>
      <string>${sharedGroup}</string>
    </array>`
    : ''
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>${groups}
  </dict>
</plist>
`
}

/** The app writes the push key; the extension reads it. Both need the same
 *  keychain access group or the extension's lookup silently returns nothing. */
function withSharedKeychainGroup(config, appleTeamId) {
  const groups = keychainGroupsFor(config.ios?.bundleIdentifier ?? '', appleTeamId)
  if (!groups) {
    // Nothing to share without a team id. Granting no group at all keeps the
    // app on its default keychain group, which is what every other secret
    // already uses; naming an unresolvable one breaks all of them.
    return config
  }
  const withExtra = {
    ...config,
    extra: { ...config.extra, [ACCESS_GROUP_EXTRA_KEY]: groups.shared }
  }
  const withGroups = withEntitlementsPlist(withExtra, (cfg) => {
    cfg.modResults['keychain-access-groups'] = [groups.appDefault, groups.shared]
    return cfg
  })
  return withInfoPlist(withGroups, (cfg) => {
    cfg.modResults[ACCESS_GROUP_INFO_KEY] = groups.shared
    return cfg
  })
}

function withExtensionTarget(config, appleTeamId) {
  return withXcodeProject(config, (cfg) => {
    const project = cfg.modResults
    if (project.pbxTargetByName(TARGET_NAME)) {
      return cfg
    }

    const group = project.addPbxGroup(
      [...SOURCE_FILES, 'Info.plist', `${TARGET_NAME}.entitlements`],
      TARGET_NAME,
      TARGET_NAME
    )
    // Attach the group under the project root so Xcode shows the sources.
    const groups = project.hash.project.objects.PBXGroup
    for (const key of Object.keys(groups)) {
      if (
        groups[key].name === undefined &&
        groups[key].path === undefined &&
        groups[key].children
      ) {
        groups[key].children.push({ value: group.uuid, comment: TARGET_NAME })
        break
      }
    }

    const target = project.addTarget(TARGET_NAME, 'app_extension', TARGET_NAME)
    // Why the sources are passed to addBuildPhase rather than added afterwards:
    // a phase created empty and filled later leaves the compile step with no
    // inputs, and the target still "succeeds" — producing an .appex holding
    // only an Info.plist, with no binary for iOS to load. The extension then
    // never runs and every push renders as placeholder text, with nothing in
    // the build output to suggest anything is wrong.
    project.addBuildPhase(SOURCE_FILES, 'PBXSourcesBuildPhase', 'Sources', target.uuid)
    project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid)
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid)

    const bundleIdentifier = cfg.ios?.bundleIdentifier ?? ''
    const configurations = project.pbxXCBuildConfigurationSection()
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings
      if (!settings) {
        continue
      }
      // Every target needs it: signing an app whose entitlements name a
      // team-prefixed keychain group fails if the build has no team.
      if (appleTeamId && settings.PRODUCT_NAME) {
        settings.DEVELOPMENT_TEAM = appleTeamId
      }
      if (settings.PRODUCT_NAME !== `"${TARGET_NAME}"`) {
        continue
      }
      settings.PRODUCT_BUNDLE_IDENTIFIER = `"${bundleIdentifier}.${TARGET_NAME}"`
      settings.INFOPLIST_FILE = `"${TARGET_NAME}/Info.plist"`
      // Both come from app.json so the extension always reports the same
      // version as the app; a mismatch is rejected at submission. Left unset
      // they expand to nothing and the version keys vanish from the bundle.
      settings.MARKETING_VERSION = cfg.version ?? '1.0.0'
      settings.CURRENT_PROJECT_VERSION = cfg.ios?.buildNumber ?? '1'
      settings.CODE_SIGN_ENTITLEMENTS = `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`
      settings.SWIFT_VERSION = '5.0'
      settings.CODE_SIGN_STYLE = 'Automatic'
      // The extension runs under a ~24 MB cap; it has no reason to carry
      // anything beyond CryptoKit and Foundation.
      settings.IPHONEOS_DEPLOYMENT_TARGET = '15.1'
      settings.TARGETED_DEVICE_FAMILY = '"1,2"'
    }

    return cfg
  })
}

/** `appleTeamId` is what makes push decryption possible: without it the app and
 *  the extension cannot name a shared keychain group, so the extension gets no
 *  key and every push renders as placeholder text. Everything else still
 *  builds, which is why this is an option rather than a hard requirement. */
module.exports = function withNotificationServiceExtension(config, { appleTeamId } = {}) {
  return withExtensionTarget(
    withSharedKeychainGroup(withExtensionSources(config, appleTeamId), appleTeamId),
    appleTeamId
  )
}
