'use strict';

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');

const env = require('./env');
const db = require('./db');
const { asyncRoute } = require('./lib/helpers');
const auth = require('./middleware/auth');
const security = require('./middleware/security');

const authRoutes = require('./routes/auth.routes').router;
const appRoutes = require('./routes/app.routes').router;
const adminRoutes = require('./routes/admin.routes');
const webhookRoutes = require('./routes/webhook.routes');

const app = express();

if (env.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

// ---------------------------------------------------------------------------
// Security headers. The CSP is strict: no inline scripts, so every page loads
// its behaviour from /js. Google Fonts is the only external origin.
// ---------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        upgradeInsecureRequests: env.isProduction ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: env.isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
  }),
);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// Concert posters arrive as a base64 data URI, which does not fit the 100kb
// limit every other endpoint is held to. Parsing it here, before the general
// parser, is what gives it a larger allowance: body-parser marks the request as
// read, so the parser below sees it is done and passes it through. The path is
// matched exactly, so nothing else inherits the bigger limit.
const posterJson = express.json({ limit: '3mb' });
app.use((req, res, next) => {
  if (req.method === 'POST' && /^\/api\/admin\/concerts\/\d+\/poster$/.test(req.path)) {
    return posterJson(req, res, next);
  }
  return next();
});

// Keep the raw body so the WhatsApp webhook signature can be verified.
app.use(
  express.json({
    limit: '100kb',
    verify: (req, res, buf) => {
      if (req.path.startsWith('/api/webhooks/')) req.rawBody = buf;
    },
  }),
);
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(cookieParser());

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
app.use('/api/webhooks', webhookRoutes);

app.use('/api', security.apiLimiter, security.csrf, auth.loadUser, auth.loadAdmin);

app.get(
  '/api/health',
  asyncRoute(async (req, res) => {
    let database = 'up';
    try {
      await db.ping();
    } catch {
      database = 'down';
    }
    res.status(database === 'up' ? 200 : 503).json({
      status: database === 'up' ? 'ok' : 'degraded',
      database,
      whatsapp_driver: env.whatsapp.driver,
      time: new Date().toISOString(),
    });
  }),
);

app.get('/api/csrf', (req, res) => {
  res.json({ token: req.cookies?.[security.CSRF_COOKIE] ?? null, header: security.CSRF_HEADER });
});

app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', appRoutes);

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(
  express.static(path.join(__dirname, '..', 'public'), {
    extensions: ['html'],
    maxAge: env.isProduction ? '1h' : 0,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) res.set('Cache-Control', 'no-cache');
    },
  }),
);

app.use(security.notFoundHandler);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '..', 'public', '404.html'), (err) => {
    if (err) res.status(404).type('txt').send('Page not found.');
  });
});

app.use(security.errorHandler);

module.exports = app;
