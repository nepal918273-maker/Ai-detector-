const { Pool } = require('pg');

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false })
  : null;

function requireDatabase() {
  if (!pool) {
    const error = new Error('Database is not configured');
    error.statusCode = 503;
    throw error;
  }
  return pool;
}

module.exports = { pool, requireDatabase };