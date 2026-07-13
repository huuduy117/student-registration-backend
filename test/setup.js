/**
 * Jest Setup File for Backend Testing
 * 
 * Configures:
 * - MongoDB Memory Server
 * - Test database connection
 * - Global test utilities
 * - Mock implementations
 */

const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

let mongoServer;

/**
 * Global setup before all tests
 * Starts an in-memory MongoDB instance
 */
beforeAll(async () => {
  // Start MongoDB Memory Server
  mongoServer = await MongoMemoryServer.create();
  const mongoUri = mongoServer.getUri();

  // Connect Mongoose to in-memory database
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
  }

  // Set environment variables for testing
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-key-for-testing-only';
  process.env.JWT_EXPIRE = '24h';
  process.env.MONGO_URI = mongoUri;
  process.env.PORT = 5001; // Different port for testing

  console.log('✓ Test environment initialized');
});

/**
 * Global cleanup after all tests
 * Closes MongoDB connection and shuts down Memory Server
 */
afterAll(async () => {
  // Close Mongoose connection
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  // Stop MongoDB Memory Server
  if (mongoServer) {
    await mongoServer.stop();
  }

  console.log('✓ Test environment cleaned up');
});

/**
 * Clear database between test suites
 * Each test suite gets a clean database state
 */
afterEach(async () => {
  // Clear all collections
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
});

/**
 * Suppress console output during tests (unless error)
 */
const originalConsoleError = console.error;
const originalConsoleLog = console.log;

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  console.error.mockRestore();
  console.log.mockRestore();
});
