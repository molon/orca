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

function appGroupFor(bundleIdentifier) {
  return `group.${bundleIdentifier}.push`
}

function keychainGroupFor(bundleIdentifier) {
  return `${bundleIdentifier}.push`
}

/** Copies the Swift sources and the extension Info.plist into the generated
 *  ios/ tree. prebuild wipes that tree, so this reruns every time. */
function withExtensionSources(config) {
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

      const bundleIdentifier = cfg.ios?.bundleIdentifier ?? ''
      fs.writeFileSync(
        path.join(targetDir, 'Info.plist'),
        buildExtensionInfoPlist(keychainGroupFor(bundleIdentifier)),
        'utf8'
      )
      fs.writeFileSync(
        path.join(targetDir, `${TARGET_NAME}.entitlements`),
        buildExtensionEntitlements(bundleIdentifier),
        'utf8'
      )
      return cfg
    }
  ])
}

function buildExtensionInfoPlist(keychainGroup) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>CFBundleDisplayName</key>
    <string>${TARGET_NAME}</string>
    <key>CFBundleIdentifier</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
    <key>CFBundleName</key>
    <string>$(PRODUCT_NAME)</string>
    <key>CFBundlePackageType</key>
    <string>XPC!</string>
    <key>CFBundleShortVersionString</key>
    <string>$(MARKETING_VERSION)</string>
    <key>CFBundleVersion</key>
    <string>$(CURRENT_PROJECT_VERSION)</string>
    <key>${ACCESS_GROUP_INFO_KEY}</key>
    <string>$(AppIdentifierPrefix)${keychainGroup}</string>
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

function buildExtensionEntitlements(bundleIdentifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>com.apple.security.application-groups</key>
    <array>
      <string>${appGroupFor(bundleIdentifier)}</string>
    </array>
    <key>keychain-access-groups</key>
    <array>
      <string>$(AppIdentifierPrefix)${keychainGroupFor(bundleIdentifier)}</string>
    </array>
  </dict>
</plist>
`
}

/** The app writes the push key; the extension reads it. Both need the same
 *  keychain access group or the extension's lookup silently returns nothing. */
function withSharedKeychainGroup(config) {
  const withGroups = withEntitlementsPlist(config, (cfg) => {
    const bundleIdentifier = cfg.ios?.bundleIdentifier ?? ''
    cfg.modResults['com.apple.security.application-groups'] = [appGroupFor(bundleIdentifier)]
    cfg.modResults['keychain-access-groups'] = [
      `$(AppIdentifierPrefix)${keychainGroupFor(bundleIdentifier)}`
    ]
    return cfg
  })
  return withInfoPlist(withGroups, (cfg) => {
    const bundleIdentifier = cfg.ios?.bundleIdentifier ?? ''
    cfg.modResults[ACCESS_GROUP_INFO_KEY] =
      `$(AppIdentifierPrefix)${keychainGroupFor(bundleIdentifier)}`
    return cfg
  })
}

function withExtensionTarget(config) {
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
      if (!settings || settings.PRODUCT_NAME !== `"${TARGET_NAME}"`) {
        continue
      }
      settings.PRODUCT_BUNDLE_IDENTIFIER = `"${bundleIdentifier}.${TARGET_NAME}"`
      settings.INFOPLIST_FILE = `"${TARGET_NAME}/Info.plist"`
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

module.exports = function withNotificationServiceExtension(config) {
  return withExtensionTarget(withSharedKeychainGroup(withExtensionSources(config)))
}
