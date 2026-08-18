'use strict';

const mysql = require('mysql2/promise');
const env = require('./env');

const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  waitForConnections: true,
  connectionLimit: env.db.poolLimit,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: ['DATE'],
  ssl: env.db.ssl ? { rejectUnauthorized: true } : undefined,
  // Prepared statements everywhere: this is the SQL injection defence. Never
  // build a query by concatenating user input.
  namedPlaceholders: false,
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

const isDeadlock = (err) =>
  Boolean(err) &&
  (err.code === 'ER_LOCK_DEADLOCK' ||
    err.errno === 1213 ||
    err.code === 'ER_LOCK_WAIT_TIMEOUT' ||
    err.errno === 1205);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` inside a transaction on a dedicated connection.
 * Commits on success, rolls back on any throw, always releases the connection.
 *
 * Deadlocks are retried. InnoDB will pick a victim and roll it back whenever
 * concurrent transactions touch overlapping index ranges in different orders,
 * which is exactly what happens when a crowd hits the same seat the moment
 * booking opens. A deadlock means "nothing was written, try again", not "this
 * request is invalid", so retrying is the correct response and the caller
 * should never see it. On retry the seat is usually already taken, so the
 * caller gets the honest "that seat has gone" answer instead of a 500.
 *
 * `fn` must therefore be safe to run more than once: do all reads and writes
 * on the connection it is handed, and keep side effects such as sending a
 * WhatsApp message outside the transaction.
 */
async function transaction(fn, { retries = 4, isolation = 'READ COMMITTED' } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const conn = await pool.getConnection();
    try {
      // READ COMMITTED, not MySQL's REPEATABLE READ default.
      //
      // Under REPEATABLE READ a plain SELECT reads the snapshot taken at the
      // start of the transaction, so a capacity count would miss bookings that
      // other transactions committed a moment ago and let too many people in.
      // Correctness here depends on counting what is committed *now*, while
      // holding the row lock that serialises booking. READ COMMITTED gives
      // each statement a fresh view and takes fewer gap locks, so it also
      // deadlocks less. Uniqueness still rests on the indexes, not isolation.
      //
      // SET TRANSACTION without SESSION applies to the next transaction only,
      // so this does not leak into other users of this pooled connection.
      if (isolation) {
        await conn.query(`SET TRANSACTION ISOLATION LEVEL ${isolation}`);
      }
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch {
        /* connection already gone */
      }
      lastError = err;
      if (!isDeadlock(err) || attempt === retries) throw err;
    } finally {
      conn.release();
    }

    // Exponential backoff with jitter, so retries do not collide again.
    await sleep(Math.round((2 ** attempt) * 15 * (0.5 + Math.random())));
  }

  throw lastError;
}

async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
    return true;
  } finally {
    conn.release();
  }
}

const isDuplicateKey = (err) => err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);

module.exports = { pool, query, queryOne, transaction, ping, isDuplicateKey, isDeadlock };
