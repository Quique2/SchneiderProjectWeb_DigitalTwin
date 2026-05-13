const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// Required for three.js and @react-three/fiber ESM package exports
config.resolver.unstable_enablePackageExports = true;
config.resolver.unstable_conditionNames = ['browser', 'require', 'default'];

// Allow .glsl files if needed in the future
config.resolver.assetExts.push('glsl', 'stl');

module.exports = config;
