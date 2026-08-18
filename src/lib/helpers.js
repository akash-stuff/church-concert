'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../env');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class AppError extends Error {
  constructor(status, message, code = undefined, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const badRequest = (m, code, details) => new AppError(400, m, code, details);
const unauthorized = (m = 'Sign in to continue.', code) => new AppError(401, m, code);
const forbidden = (m = 'You do not have access to this.', code) => new AppError(403, m, code);
const notFound = (m = 'Not found.', code) => new AppError(404, m, code);
const conflict = (m, code, details) => new AppError(409, m, code, details);
const tooMany = (m = 'Too many attempts. Try again later.') => new AppError(429, m, 'RATE_LIMITED');

/** Wrap an async route handler so rejections reach the error middleware. */
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Password hashing — Argon2id when the native module is available, bcrypt
// otherwise. Verification detects the algorithm from the hash prefix, so
// existing hashes keep working if the runtime changes.
// ---------------------------------------------------------------------------

let argon2 = null;
try {
  // eslint-disable-next-line global-require
  argon2 = require('argon2');
} catch {
  argon2 = null;
}

const BCRYPT_ROUNDS = 12;

async function hashPassword(plain) {
  if (argon2) {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19456, // 19 MiB — OWASP baseline
      timeCost: 2,
      parallelism: 1,
    });
  }
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

async function verifyPassword(hash, plain) {
  if (!hash || !plain) return false;
  try {
    if (hash.startsWith('$argon2')) {
      if (!argon2) return false;
      return argon2.verify(hash, plain);
    }
    return bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

const passwordAlgorithm = () => (argon2 ? 'argon2id' : 'bcrypt');

// ---------------------------------------------------------------------------
// Tokens and codes
// ---------------------------------------------------------------------------

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('hex');

function numericCode(length) {
  let out = '';
  while (out.length < length) {
    out += crypto.randomInt(0, 10).toString();
  }
  return out;
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Age — computed server-side from date of birth, never trusted from the client
// ---------------------------------------------------------------------------

function ageOn(dateOfBirth, reference = new Date()) {
  const dob = dateOfBirth instanceof Date ? dateOfBirth : new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return NaN;
  let age = reference.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = reference.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && reference.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

// ---------------------------------------------------------------------------
// Phone numbers — stored in E.164 so uniqueness checks are meaningful
// ---------------------------------------------------------------------------

function normalisePhone(raw, defaultCountryCode = env.whatsapp.defaultCountryCode) {
  if (!raw) return null;
  let value = String(raw).trim().replace(/[\s()\-.]/g, '');
  if (value.startsWith('00')) value = `+${value.slice(2)}`;
  if (!value.startsWith('+')) {
    const cc = (defaultCountryCode || '').replace(/[^\d+]/g, '');
    if (!cc) return null;
    value = `${cc.startsWith('+') ? cc : `+${cc}`}${value.replace(/^0+/, '')}`;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(value)) return null;
  return value;
}

/** +919876543210 -> +91 ***** 43210 */
function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone);
  if (digits.length < 6) return digits;
  return `${digits.slice(0, 3)} ***** ${digits.slice(-4)}`;
}

const nowSql = () => new Date();

function addMinutes(minutes, from = new Date()) {
  return new Date(from.getTime() + minutes * 60 * 1000);
}

const clientIp = (req) => (req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '');

module.exports = {
  AppError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooMany,
  asyncRoute,
  hashPassword,
  verifyPassword,
  passwordAlgorithm,
  sha256,
  randomToken,
  numericCode,
  timingSafeEqual,
  ageOn,
  normalisePhone,
  maskPhone,
  nowSql,
  addMinutes,
  clientIp,
};
