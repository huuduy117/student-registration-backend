const request = require('supertest');
const app = require('../../app'); // Import your Express app instance

const { connect, clearDatabase, disconnect } = require('../mocks/mockMongoose');

beforeAll(async () => {
  await connect();
});

afterEach(async () => {
  await clearDatabase();
});

afterAll(async () => {
  await disconnect();
});

describe('Authentication Controller', () => {
  it('should return a 200 status and a token for valid credentials', async () => {
    const response = await request(app).post('/api/auth/login').send({
      email: 'testuser@example.com',
      password: 'password123',
    });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('token');
  });

  it('should return a 401 status for invalid credentials', async () => {
    const response = await request(app).post('/api/auth/login').send({
      email: 'invalid@example.com',
      password: 'wrongpassword',
    });

    expect(response.status).toBe(401);
    expect(response.body).toHaveProperty('error', 'Invalid credentials');
  });
});