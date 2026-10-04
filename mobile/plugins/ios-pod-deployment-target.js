const { withPodfile } = require('expo/config-plugins')

/*
Raises every pod to the app's own iOS deployment target.

Xcode 27 refuses targets below 15.0 outright (some resource-bundle pods still
declare 9.0–13.4), and its SDK marks APIs expo-router uses as iOS 16, while the
podspec still says 15.1. expo-build-properties' `ios.deploymentTarget` moves the
app and the Podfile platform but leaves each pod on its own podspec value, so
this lifts the lower ones to match. Generated into the Podfile because `ios/` is
rebuilt by prebuild, locally and on Xcode Cloud alike.
*/
const MARKER = '# orca: raise pods to the app deployment target'

const SNIPPET = `
    ${MARKER}
    app_ios_target = podfile_properties['ios.deploymentTarget'] || '15.1'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |bc|
        if bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < app_ios_target.to_f
          bc.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = app_ios_target
        end
      end
    end
`

module.exports = function withIosPodDeploymentTarget(config) {
  return withPodfile(config, (cfg) => {
    const podfile = cfg.modResults.contents
    if (podfile.includes(MARKER)) {
      return cfg
    }
    const anchor = /(react_native_post_install\([\s\S]*?\n\s*\)\n)/
    if (!anchor.test(podfile)) {
      throw new Error('ios-pod-deployment-target: react_native_post_install not found in Podfile')
    }
    cfg.modResults.contents = podfile.replace(anchor, `$1${SNIPPET}`)
    return cfg
  })
}
