const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { requireDatabase } = require('./db');

const JWT_SECRET = () => process.env.JWT_SECRET;

function requireJwtSecret() {
  if (!JWT_SECRET()) {
    const error = new Error('JWT_SECRET is not configured');
    error.statusCode = 503;
    throw error;
  }
}

function createToken(userId) {
  requireJwtSecret();
  return jwt.sign({ user_id: String(userId) }, JWT_SECRET(), { expiresIn: '7d' });
}

function tokenFromRequest(request) {
  const value = request.headers.authorization || '';
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

async function authenticateJwt(request) {
  const token = tokenFromRequest(request);
  if (!token) return null;
  try {
    requireJwtSecret();
    const payload = jwt.verify(token, JWT_SECRET());
    const result = await requireDatabase().query('SELECT id FROM users WHERE id = $1', [payload.user_id]);
    return result.rows[0] ? payload : null;
  } catch {
    return null;
  }
}

async function authenticateApiKey(request) {
  const plainKey = tokenFromRequest(request);
  if (!plainKey) return null;
  const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');
  const result = await requireDatabase().query('SELECT user_id FROM api_keys WHERE key_hash = $1 AND is_active = true', [keyHash]);
  return result.rows[0] || null;
}

async function register(name, email, password) {
  const normalizedName = String(name || '').trim();
  if (normalizedName.length < 2 || normalizedName.length > 120) throw Object.assign(new Error('Name must be between 2 and 120 characters'), { statusCode: 400 });
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail || !/^\S+@\S+\.\S+$/.test(normalizedEmail)) throw Object.assign(new Error('A valid email is required'), { statusCode: 400 });
  if (typeof password !== 'string' || password.length < 8) throw Object.assign(new Error('Password must be at least 8 characters'), { statusCode: 400 });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await requireDatabase().query('INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email, credits', [normalizedName, normalizedEmail, passwordHash]);
    return { ...result.rows[0], token: createToken(result.rows[0].id) };
  } catch (error) {
    if (error.code === '23505') throw Object.assign(new Error('Email is already registered'), { statusCode: 409 });
    throw error;
  }
}

async function login(email, password) {
  const result = await requireDatabase().query('SELECT id, name, email, credits, password FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  if (!result.rows[0] || !(await bcrypt.compare(String(password || ''), result.rows[0].password))) throw Object.assign(new Error('Invalid email or password'), { statusCode: 401 });
  return { id: result.rows[0].id, name: result.rows[0].name, email: result.rows[0].email, credits: result.rows[0].credits, token: createToken(result.rows[0].id) };
}

async function createApiKey(userId) {
  const plainKey = `sk_live_${crypto.randomBytes(32).toString('base64url')}`;
  const keyHash = crypto.createHash('sha256').update(plainKey).digest('hex');
  const result = await requireDatabase().query('INSERT INTO api_keys (user_id, key_hash, key_prefix) VALUES ($1, $2, $3) RETURNING id, key_prefix, created_at, is_active', [userId, keyHash, plainKey.slice(0, 8)]);
  return { ...result.rows[0], key: plainKey };
}

module.exports = { register, login, createApiKey, authenticateJwt, authenticateApiKey, requireDatabase };