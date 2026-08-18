'use strict';

const jwt = require('jsonwebtoken');
const env = require('../env');
const db = require('../db');
const { unauthorized, forbidden, asyncRoute } = require('../lib/helpers');

const USER_COOKIE = 'cc_session';
const ADMIN_COOKIE = 'cc_admin_session';

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'strict',
    domain: env.cookieDomain,
    path: '/',
    maxAge: maxAgeMs,
  };
}

const TWELVE_HOURS = 12 * 60 * 60 * 1000;

function sign(payload) {
  return jwt.sign(payload, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
    issuer: 'church-concert',
  });
}

function issueUserSession(res, user) {
  const token = sign({ sub: user.id, kind: 'user', tv: user.token_version });
  res.cookie(USER_COOKIE, token, cookieOptions(TWELVE_HOURS));
}

function issueAdminSession(res, admin) {
  const token = sign({ sub: admin.id, kind: 'admin', role: admin.role, tv: admin.token_version });
  res.cookie(ADMIN_COOKIE, token, cookieOptions(TWELVE_HOURS));
}

function clearUserSession(res) {
  res.clearCookie(USER_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

function clearAdminSession(res) {
  res.clearCookie(ADMIN_COOKIE, { ...cookieOptions(0), maxAge: undefined });
}

function decode(token) {
  try {
    return jwt.verify(token, env.jwtSecret, { issuer: 'church-concert' });
  } catch {
    return null;
  }
}

/** Populates req.user when a valid user session exists. Never rejects. */
const loadUser = asyncRoute(async (req, res, next) => {
  const token = req.cookies?.[USER_COOKIE];
  if (!token) return next();
  const claims = decode(token);
  if (!claims || claims.kind !== 'user') return next();

  const user = await db.queryOne(
    `SELECT id, full_name, email, mobile_number, whatsapp_number, date_of_birth, gender,
            address, emergency_contact, whatsapp_verified, whatsapp_verified_at, is_active,
            token_version, created_at
       FROM users WHERE id = ? LIMIT 1`,
    [claims.sub],
  );
  // token_version bumps on password change, invalidating older sessions.
  if (user && user.token_version === claims.tv) req.user = user;
  return next();
});

/** Populates req.admin when a valid admin session exists. Never rejects. */
const loadAdmin = asyncRoute(async (req, res, next) => {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return next();
  const claims = decode(token);
  if (!claims || claims.kind !== 'admin') return next();

  const admin = await db.queryOne(
    `SELECT id, full_name, email, role, is_active, token_version
       FROM admins WHERE id = ? LIMIT 1`,
    [claims.sub],
  );
  if (admin && admin.token_version === claims.tv) req.admin = admin;
  return next();
});

function requireUser(req, res, next) {
  if (!req.user) return next(unauthorized('Sign in to continue.', 'AUTH_REQUIRED'));
  if (!req.user.is_active) {
    return next(
      forbidden('This account has been disabled. Contact the church office.', 'ACCOUNT_DISABLED'),
    );
  }
  return next();
}

function requireVerifiedUser(req, res, next) {
  if (!req.user.whatsapp_verified) {
    return next(
      forbidden('Verify your WhatsApp number before booking a seat.', 'WHATSAPP_NOT_VERIFIED'),
    );
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.admin) return next(unauthorized('Sign in to the admin dashboard.', 'ADMIN_REQUIRED'));
  if (!req.admin.is_active) return next(forbidden('This admin account is disabled.'));
  return next();
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'SUPER_ADMIN') {
    return next(forbidden('Only a super admin can change this.', 'SUPER_ADMIN_REQUIRED'));
  }
  return next();
}

module.exports = {
  USER_COOKIE,
  ADMIN_COOKIE,
  issueUserSession,
  issueAdminSession,
  clearUserSession,
  clearAdminSession,
  loadUser,
  loadAdmin,
  requireUser,
  requireVerifiedUser,
  requireAdmin,
  requireSuperAdmin,
};
