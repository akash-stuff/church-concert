'use strict';

const env = require('../env');
const { randomToken, timingSafeEqual, AppError, clientIp } = require('../lib/helpers');

const CSRF_COOKIE = 'cc_csrf';
const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF. The token lives in a readable cookie and must be echoed
 * in a header on every state-changing request. An attacker's page can trigger
 * the request but cannot read the cookie to set the header.
 */
function csrf(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, randomToken(24), {
      httpOnly: false,
      secure: env.isProduction,
      sameSite: 'strict',
      domain: env.cookieDomain,
      path: '/',
    });
  }

  if (SAFE_METHODS.has(req.method)) return next();

  // Webhooks are authenticated by provider signature, not by a browser cookie.
  if (req.path.startsWith('/api/webhooks/')) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || !timingSafeEqual(cookieToken, headerToken)) {
    return next(
      new AppError(403, 'Your session expired. Reload the page and try again.', 'CSRF_FAILED'),
    );
  }
  return next();
}

/**
 * Fixed-window limiter kept in process memory. Adequate for a single-node
 * deployment; behind more than one instance, move the counter to Redis or
 * MySQL so the window is shared.
 */
function createRateLimiter({ max, windowMs, name, keyFn }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of hits) {
      if (entry.resetAt <= now) hits.delete(key);
    }
  }, windowMs).unref();

  const middleware = (req, res, next) => {
    const key = `${name}:${keyFn ? keyFn(req) : clientIp(req)}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(key, entry);
    }
    entry.count += 1;

    const remaining = Math.max(0, max - entry.count);
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(remaining));
    res.set('RateLimit-Reset', String(Math.ceil((entry.resetAt - now) / 1000)));

    if (entry.count > max) {
      const seconds = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(seconds));
      return next(
        new AppError(429, `Too many attempts. Try again in ${seconds} seconds.`, 'RATE_LIMITED'),
      );
    }
    return next();
  };

  middleware.reset = (req) => hits.delete(`${name}:${keyFn ? keyFn(req) : clientIp(req)}`);
  middleware.stop = () => clearInterval(sweep);
  return middleware;
}

const apiLimiter = createRateLimiter({
  name: 'api',
  max: env.rateLimit.apiMax,
  windowMs: env.rateLimit.windowMs,
});

const authLimiter = createRateLimiter({
  name: 'auth',
  max: env.rateLimit.authMax,
  windowMs: env.rateLimit.windowMs,
});

/**
 * Verification-code limiter, keyed per signed-in account with an IP fallback.
 *
 * Keying purely on IP would be wrong here: a congregation registering from the
 * church's own WiFi, or any group behind carrier NAT, shares one address and
 * would lock each other out. Guessing is already bounded per code by the
 * `attempts` column (OTP_MAX_ATTEMPTS), which is the real brute-force defence;
 * this limiter exists to stop a flood of resends.
 */
const otpLimiter = createRateLimiter({
  name: 'otp',
  max: 12,
  windowMs: 15 * 60 * 1000,
  keyFn: (req) => (req.user ? `user:${req.user.id}` : `ip:${clientIp(req)}`),
});

function notFoundHandler(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: { message: 'Endpoint not found.', code: 'NOT_FOUND' } });
  }
  return next();
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = Number.isInteger(err.status) ? err.status : 500;

  if (status >= 500) {
    console.error('[error]', req.method, req.originalUrl, err);
  }

  const body = {
    error: {
      message: err.expose && err.message ? err.message : 'Something went wrong on our side.',
      code: err.code || (status === 500 ? 'INTERNAL_ERROR' : undefined),
    },
  };
  if (err.details) body.error.details = err.details;
  if (!env.isProduction && status >= 500) body.error.stack = err.stack;

  res.status(status).json(body);
}

module.exports = {
  CSRF_COOKIE,
  CSRF_HEADER,
  csrf,
  createRateLimiter,
  apiLimiter,
  authLimiter,
  otpLimiter,
  notFoundHandler,
  errorHandler,
};
