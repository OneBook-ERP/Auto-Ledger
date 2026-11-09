module.exports = {
  preset: 'jest-expo',
  testPathIgnorePatterns: ['/node_modules/', '/android/', '/ios/', '/.superpowers/'],
  modulePathIgnorePatterns: ['/.superpowers/'],
  // lucide-react-native's package "exports" points Jest at its ES-module build; use the CommonJS build in tests.
  moduleNameMapper: { '^lucide-react-native$': '<rootDir>/node_modules/lucide-react-native/dist/cjs/lucide-react-native.js' },
};
