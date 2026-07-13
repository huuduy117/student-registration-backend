/**
 * Jest Configuration for Student Registration Backend
 * 
 * This configuration sets up Jest for:
 * - Unit and integration testing
 * - MongoDB Memory Server setup
 * - Code coverage tracking
 * - Test environment isolation
 */

module.exports = {
  // Test environment - use node for backend testing
  testEnvironment: 'node',

  // Test paths and patterns
  testMatch: [
    '**/test/**/*.test.js',
    '**/tests/**/*.test.js',
    '**/__tests__/**/*.test.js',
  ],

  // Coverage configuration
  collectCoverageFrom: [
    'controllers/**/*.js',
    'models/**/*.js',
    'middleware/**/*.js',
    'routes/**/*.js',
    'utils/**/*.js',
    '!**/node_modules/**',
    '!**/test/**',
    '!**/tests/**',
    '!**/dist/**',
  ],

  // Coverage thresholds (minimum code coverage requirements)
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 75,
      lines: 75,
      statements: 75,
    },
    './controllers/': {
      branches: 80,
      functions: 85,
      lines: 85,
      statements: 85,
    },
    './middleware/': {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/test/setup.js'],

  // Timeout for tests (some tests may need extra time)
  testTimeout: 30000,

  // Verbose output for debugging
  verbose: true,

  // Mock modules
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
  },

  // Transform files (if using Babel)
  transform: {},

  // Clear mocks between tests
  clearMocks: true,

  // Restore mocks between tests
  restoreMocks: true,

  // Coverage reporters
  coverageReporters: ['text', 'lcov', 'html', 'json-summary'],

  // Max workers for parallel test execution
  maxWorkers: '50%',

  // Run tests in band (sequentially) if needed - good for database tests
  // Can be overridden with --runInBand flag
};
