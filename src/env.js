'use strict';

require('dotenv').config();

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseDatabaseUrl(url) {
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL. Expected mysql://user:pass@host:3306/dbname');
  }
  const database = parsed.pathname.replace(/^\//, '');
  if (!database) throw new Error('DATABASE_URL is missing the database name.');
  return {
    host: parsed.hostname,
    port: int(parsed.port, 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
  };
}

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const env = {
  nodeEnv,
  isProduction,
  appName: process.env.APP_NAME || 'Church Concert',
  appUrl: (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, ''),
  port: int(process.env.PORT, 3000),
  trustProxy: bool(process.env.TRUST_PROXY, false),

  db: {
    ...parseDatabaseUrl(process.env.DATABASE_URL),
    poolLimit: int(process.env.DB_POOL_LIMIT, 10),
    ssl: bool(process.env.DB_SSL, false),
  },

  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,

  whatsapp: {
    driver: (process.env.WHATSAPP_DRIVER || 'mock').toLowerCase(),
    apiUrl: (process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v20.0').replace(/\/$/, ''),
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    templateVerification: process.env.WHATSAPP_TEMPLATE_VERIFICATION || '',
    templateBooking: process.env.WHATSAPP_TEMPLATE_BOOKING || '',
    defaultCountryCode: process.env.WHATSAPP_DEFAULT_COUNTRY_CODE || '',
  },

  otp: {
    length: Math.min(Math.max(int(process.env.OTP_LENGTH, 6), 4), 8),
    ttlMinutes: int(process.env.OTP_TTL_MINUTES, 10),
    maxAttempts: int(process.env.OTP_MAX_ATTEMPTS, 5),
  },

  rateLimit: {
    windowMs: int(process.env.RATE_LIMIT_WINDOW_MINUTES, 15) * 60 * 1000,
    authMax: int(process.env.RATE_LIMIT_AUTH_MAX, 40),
    apiMax: int(process.env.RATE_LIMIT_API_MAX, 300),
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || '',
    name: process.env.SEED_ADMIN_NAME || 'Administrator',
    password: process.env.SEED_ADMIN_PASSWORD || '',
  },
};

if (!env.jwtSecret || env.jwtSecret.length < 32) {
  const message =
    'JWT_SECRET must be set to at least 32 characters. Generate one with:\n' +
    '  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"';
  if (isProduction) throw new Error(message);
  console.warn(`[env] WARNING: ${message}`);
  env.jwtSecret = env.jwtSecret || 'insecure-development-secret-change-me-now-0000000';
}

if (isProduction && env.whatsapp.driver === 'mock') {
  console.warn('[env] WARNING: WHATSAPP_DRIVER=mock in production. No messages will be delivered.');
}

module.exports = env;
