const { withEntitlementsPlist, withXcodeProject } = require('expo/config-plugins')

/*
Makes the APNs environment a build setting instead of a literal in the
entitlements.

The entitlement decides which of Apple's two push environments the app
registers against, and it has to agree with the provisioning profile signing the
build: a development profile only carries `development`, an App Store profile
only `production`. So the same source tree has to produce both, and a value
written into the entitlements file can only ever be one of them.

Getting it wrong is expensive to notice. The build succeeds, the app installs,
notifications arrive — and every one of them shows the placeholder text, because
the token was minted in the environment the push server is not talking to. There
is nothing in the build output to suggest anything is wrong.

  prebuild with nothing set            →  development  →  sandbox token
  APS_ENVIRONMENT=production npx expo prebuild  →  production token
  xcodebuild … APS_ENVIRONMENT=production       →  production token
*/
const BUILD_SETTING = 'APS_ENVIRONMENT'
const ENVIRONMENTS = ['development', 'production']

/**
 * The value baked in as the target's default.
 *
 * Read from the environment at prebuild rather than left to xcodebuild, because
 * CI does not drive xcodebuild directly: Xcode Cloud runs the build itself and
 * only hands the workflow's environment to the clone script. Taking it here
 * means the same variable works in both places — a local override on the
 * xcodebuild command line still wins, since a command-line setting beats the
 * project's default.
 */
function defaultEnvironment() {
  const requested = process.env[BUILD_SETTING]
  if (requested === undefined || requested === '') {
    return 'development'
  }
  if (!ENVIRONMENTS.includes(requested)) {
    // Refusing beats defaulting: a typo would otherwise produce a build that
    // installs and runs, with every push arriving as placeholder text.
    throw new Error(
      `${BUILD_SETTING} must be one of ${ENVIRONMENTS.join(', ')}, got ${JSON.stringify(requested)}`
    )
  }
  return requested
}

/** Xcode expands build settings inside entitlements plists — the same mechanism
 *  the stock `$(AppIdentifierPrefix)` keychain group relies on. */
function withApsEnvironmentEntitlement(config) {
  return withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['aps-environment'] = `$(${BUILD_SETTING})`
    return cfg
  })
}

/** Defaults the setting on the app target only. The extension has no
 *  `aps-environment` of its own: it rewrites notifications that already
 *  arrived and never registers for any. */
function withApsEnvironmentDefault(config) {
  const environment = defaultEnvironment()
  return withXcodeProject(config, (cfg) => {
    const appTarget = cfg.modRequest.projectName
    const configurations = cfg.modResults.pbxXCBuildConfigurationSection()
    for (const key of Object.keys(configurations)) {
      const settings = configurations[key].buildSettings
      if (!settings || !settings.PRODUCT_NAME) {
        continue
      }
      if (settings.PRODUCT_NAME.replaceAll('"', '') !== appTarget) {
        continue
      }
      settings[BUILD_SETTING] = environment
    }
    return cfg
  })
}

module.exports = function withApsEnvironment(config) {
  return withApsEnvironmentDefault(withApsEnvironmentEntitlement(config))
}
