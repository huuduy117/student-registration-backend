const jwt = require('jsonwebtoken');

module.exports = {
  signToken: (payload, secret = process.env.JWT_SECRET, options = {}) =>
    jwt.sign(payload, secret, { expiresIn: '1h', ...options }),

  verifyToken: (token, secret = process.env.JWT_SECRET) => jwt.verify(token, secret),
};