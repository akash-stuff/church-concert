'use strict';

const express = require('express');
const db = require('../db');
const env = require('../env');
const bookingService = require('../services/booking');
const notifications = require('../services/notifications');
const { audit, getSettings } = require('../lib/audit');
const {
  asyncRoute,
  hashPassword,
  verifyPassword,
  badRequest,
  unauthorized,
  conflict,
  forbidden,
  notFound,
  ageOn,
  sha256,
  randomToken,
  numericCode,
  addMinutes,
  maskPhone,
} = require('../lib/helpers');
const schemas = require('../lib/schemas');
const { parse } = schemas;
const auth = require('../middleware/auth');
const { authLimiter, otpLimiter } = require('../middleware/security');

const router = express.Router();

const UNDER_AGE_MESSAGE = 'Registration is available only for participants aged 18 years or above.';
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

const publicUser = (user) => ({
  id: user.id,
  full_name: user.full_name,
  email: user.email,
  mobile_number: user.mobile_number,
  whatsapp_number: user.whatsapp_number,
  whatsapp_masked: maskPhone(user.whatsapp_number),
  date_of_birth: user.date_of_birth,
  gender: user.gender,
  address: user.address,
  emergency_contact: user.emergency_contact,
  whatsapp_verified: Boolean(user.whatsapp_verified),
  whatsapp_verified_at: user.whatsapp_verified_at,
  age: ageOn(user.date_of_birth),
  created_at: user.created_at,
});

// ---------------------------------------------------------------------------
// POST /api/auth/register
// ---------------------------------------------------------------------------
router.post(
  '/register',
  authLimiter,
  asyncRoute(async (req, res) => {
    const data = parse(schemas.registerSchema, req.body);
    const settings = await getSettings();

    // Age is derived from the date of birth on the server. The client-side
    // checkbox is a courtesy, not the control.
    const age = ageOn(data.date_of_birth);
    if (!Number.isFinite(age) || age < 0 || age > 120) {
      throw badRequest('Enter a valid date of birth.', 'VALIDATION_FAILED', {
        date_of_birth: 'Enter a valid date of birth.',
      });
    }
    if (age < settings.minimum_age) {
      await audit(req, {
        action: 'REGISTRATION_REJECTED_UNDERAGE',
        entityType: 'USER',
        metadata: { age, email: data.email },
      });
      throw forbidden(UNDER_AGE_MESSAGE, 'UNDER_AGE');
    }

    // An account is not tied to one concert, so registration is open while any
    // active concert is still accepting people. Shutting the door because the
    // earliest concert has closed would block someone signing up for a later
    // one that is still open.
    const concerts = await bookingService.listConcerts({ activeOnly: true });
    if (!concerts.length) throw forbidden('No concert is open for registration.', 'REG_CLOSED');

    const windows = concerts.map(({ concert }) =>
      bookingService.withinWindow(concert.registration_opens_at, concert.registration_closes_at),
    );
    if (!windows.includes('OPEN')) {
      throw windows.includes('NOT_OPEN')
        ? forbidden('Registration has not opened yet.', 'REG_NOT_OPEN')
        : forbidden('Registration has closed.', 'REG_CLOSED');
    }

    // Friendly duplicate messages before the insert; the unique indexes remain
    // the authority if two registrations race.
    const checks = settings.duplicate_check_fields || ['email'];
    const labels = {
      email: 'That email address is already registered.',
      mobile_number: 'That mobile number is already registered.',
      whatsapp_number: 'That WhatsApp number is already registered.',
    };
    for (const field of checks) {
      const existing = await db.queryOne(`SELECT id FROM users WHERE ${field} = ? LIMIT 1`, [
        data[field],
      ]);
      if (existing) throw conflict(labels[field], 'DUPLICATE_ACCOUNT', { [field]: labels[field] });
    }

    const passwordHash = await hashPassword(data.password);

    let userId;
    try {
      const result = await db.query(
        `INSERT INTO users
           (full_name, email, mobile_number, whatsapp_number, password_hash, date_of_birth,
            gender, address, emergency_contact, terms_accepted_at, age_confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          data.full_name,
          data.email,
          data.mobile_number,
          data.whatsapp_number,
          passwordHash,
          data.date_of_birth,
          data.gender,
          data.address,
          data.emergency_contact,
        ],
      );
      userId = result.insertId;
    } catch (err) {
      if (db.isDuplicateKey(err)) {
        throw conflict(
          'An account already exists with those details. Try signing in instead.',
          'DUPLICATE_ACCOUNT',
        );
      }
      throw err;
    }

    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [userId]);

    await audit(req, {
      actorType: 'USER',
      actorId: userId,
      actorLabel: user.email,
      action: 'USER_REGISTERED',
      entityType: 'USER',
      entityId: userId,
      metadata: { age },
    });

    // Welcome them to the concert coming up soonest, which is the one the site
    // will show them first.
    const nextConcert = concerts[0].concert;
    await notifications.sendRegistrationWelcome(user, nextConcert);
    const sent = await issueVerificationCode(user);

    auth.issueUserSession(res, user);

    res.status(201).json({
      user: publicUser(user),
      whatsapp: {
        sent: sent.ok,
        masked_number: maskPhone(user.whatsapp_number),
        expires_in_minutes: env.otp.ttlMinutes,
        message: sent.ok
          ? `We sent a verification code to ${maskPhone(user.whatsapp_number)} on WhatsApp.`
          : 'We could not reach WhatsApp just now. Request a new code in a moment.',
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// WhatsApp verification
// ---------------------------------------------------------------------------

/** Issue a fresh code: invalidate previous ones, store only the hash. */
async function issueVerificationCode(user) {
  await db.query(
    `UPDATE whatsapp_verifications SET consumed_at = NOW()
      WHERE user_id = ? AND consumed_at IS NULL`,
    [user.id],
  );

  const code = numericCode(env.otp.length);
  await db.query(
    `INSERT INTO whatsapp_verifications (user_id, phone_e164, code_hash, max_attempts, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [user.id, user.whatsapp_number, sha256(code), env.otp.maxAttempts, addMinutes(env.otp.ttlMinutes)],
  );

  if (env.whatsapp.driver === 'mock') {
    console.log(`[whatsapp:mock] verification code for ${user.whatsapp_number} is ${code}`);
  }

  return notifications.sendVerificationCode(user, code, env.otp.ttlMinutes);
}

router.post(
  '/whatsapp/send',
  otpLimiter,
  auth.requireUser,
  asyncRoute(async (req, res) => {
    if (req.user.whatsapp_verified) {
      return res.json({ already_verified: true, message: 'That number is already verified.' });
    }
    const user = await db.queryOne('SELECT * FROM users WHERE id = ?', [req.user.id]);
    const sent = await issueVerificationCode(user);
    return res.json({
      sent: sent.ok,
      masked_number: maskPhone(user.whatsapp_number),
      expires_in_minutes: env.otp.ttlMinutes,
      message: sent.ok
        ? `New code sent to ${maskPhone(user.whatsapp_number)}.`
        : 'WhatsApp did not accept the message. Check the number in your profile, then try again.',
    });
  }),
);

router.post(
  '/whatsapp/verify',
  otpLimiter,
  auth.requireUser,
  asyncRoute(async (req, res) => {
    const { code } = parse(schemas.verifyWhatsappSchema, req.body);

    if (req.user.whatsapp_verified) {
      return res.json({ verified: true, message: 'That number is already verified.' });
    }

    const record = await db.queryOne(
      `SELECT * FROM whatsapp_verifications
        WHERE user_id = ? AND consumed_at IS NULL
        ORDER BY id DESC LIMIT 1`,
      [req.user.id],
    );
    if (!record) throw badRequest('Request a new code first.', 'NO_PENDING_CODE');

    if (new Date(record.expires_at) < new Date()) {
      throw badRequest('That code expired. Request a new one.', 'CODE_EXPIRED');
    }
    if (record.attempts >= record.max_attempts) {
      throw badRequest('Too many wrong codes. Request a new one.', 'CODE_ATTEMPTS_EXCEEDED');
    }

    if (sha256(code) !== record.code_hash) {
      await db.query('UPDATE whatsapp_verifications SET attempts = attempts + 1 WHERE id = ?', [
        record.id,
      ]);
      const left = record.max_attempts - record.attempts - 1;
      throw badRequest(
        left > 0 ? `That code is not right. ${left} attempts left.` : 'That code is not right.',
        'CODE_INVALID',
      );
    }

    await db.transaction(async (conn) => {
      await conn.execute('UPDATE whatsapp_verifications SET consumed_at = NOW() WHERE id = ?', [
        record.id,
      ]);
      await conn.execute(
        `UPDATE users SET whatsapp_verified = 1, whatsapp_verified_at = NOW() WHERE id = ?`,
        [req.user.id],
      );
    });

    await audit(req, {
      action: 'WHATSAPP_VERIFIED',
      entityType: 'USER',
      entityId: req.user.id,
      metadata: { phone: maskPhone(record.phone_e164) },
    });

    return res.json({ verified: true, message: 'WhatsApp verified. You can choose a seat now.' });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/auth/login
// ---------------------------------------------------------------------------
router.post(
  '/login',
  authLimiter,
  asyncRoute(async (req, res) => {
    const { identifier, password } = parse(schemas.loginSchema, req.body);
    const generic = unauthorized('Those details do not match an account.', 'INVALID_CREDENTIALS');

    const user = await db.queryOne(
      `SELECT * FROM users
        WHERE email = ? OR mobile_number = ? OR whatsapp_number = ?
        LIMIT 1`,
      [identifier.toLowerCase(), identifier, identifier],
    );

    // Uniform failure: never reveal whether the account exists.
    if (!user) throw generic;

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      throw forbidden(
        'Too many failed sign-ins. Try again in a few minutes or reset your password.',
        'ACCOUNT_LOCKED',
      );
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      const failures = user.failed_login_count + 1;
      const lock = failures >= LOCKOUT_THRESHOLD;
      await db.query(
        `UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?`,
        [lock ? 0 : failures, lock ? addMinutes(LOCKOUT_MINUTES) : null, user.id],
      );
      if (lock) {
        await audit(req, {
          actorType: 'USER',
          actorId: user.id,
          actorLabel: user.email,
          action: 'USER_LOCKED_OUT',
          entityType: 'USER',
          entityId: user.id,
        });
      }
      throw generic;
    }

    if (!user.is_active) {
      throw forbidden(
        'This account has been disabled. Contact the church office.',
        'ACCOUNT_DISABLED',
      );
    }

    await db.query(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW() WHERE id = ?`,
      [user.id],
    );

    auth.issueUserSession(res, user);
    await audit(req, {
      actorType: 'USER',
      actorId: user.id,
      actorLabel: user.email,
      action: 'USER_LOGIN',
    });

    res.json({ user: publicUser(user) });
  }),
);

router.post('/logout', (req, res) => {
  auth.clearUserSession(res);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------
router.post(
  '/forgot-password',
  authLimiter,
  asyncRoute(async (req, res) => {
    const { email } = parse(schemas.forgotPasswordSchema, req.body);
    const user = await db.queryOne('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);

    // Always the same reply, so this endpoint cannot enumerate accounts.
    const reply = {
      ok: true,
      message: 'If that email is registered, a reset link is on its way by WhatsApp.',
    };

    if (!user || !user.is_active) return res.json(reply);

    const token = randomToken(32);
    await db.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
      [user.id, sha256(token), addMinutes(30)],
    );

    const link = `${env.appUrl}/reset-password.html?token=${token}`;
    await notifications.dispatch({
      userId: user.id,
      recipient: user.whatsapp_number,
      type: 'PASSWORD_RESET',
      send: () =>
        require('../services/whatsapp').sendRaw(
          require('../services/whatsapp').textMessage(
            user.whatsapp_number,
            `${env.appName}: reset your password with this link. It expires in 30 minutes.\n${link}\n\nIf you did not ask for this, ignore this message.`,
          ),
        ),
    });

    if (!env.isProduction) console.log(`[auth] password reset link for ${user.email}: ${link}`);

    return res.json(reply);
  }),
);

router.post(
  '/reset-password',
  authLimiter,
  asyncRoute(async (req, res) => {
    const { token, password } = parse(schemas.resetPasswordSchema, req.body);

    const record = await db.queryOne(
      `SELECT * FROM password_resets WHERE token_hash = ? LIMIT 1`,
      [sha256(token)],
    );
    if (!record || record.consumed_at || new Date(record.expires_at) < new Date()) {
      throw badRequest('That reset link is no longer valid. Request a new one.', 'RESET_INVALID');
    }

    const hash = await hashPassword(password);
    await db.transaction(async (conn) => {
      await conn.execute('UPDATE password_resets SET consumed_at = NOW() WHERE id = ?', [record.id]);
      // Bumping token_version signs out every existing session.
      await conn.execute(
        `UPDATE users SET password_hash = ?, token_version = token_version + 1,
                          failed_login_count = 0, locked_until = NULL
          WHERE id = ?`,
        [hash, record.user_id],
      );
    });

    auth.clearUserSession(res);
    await audit(req, {
      actorType: 'USER',
      actorId: record.user_id,
      action: 'PASSWORD_RESET',
      entityType: 'USER',
      entityId: record.user_id,
    });

    res.json({ ok: true, message: 'Password changed. Sign in with your new password.' });
  }),
);

// ---------------------------------------------------------------------------
// Admin authentication (separate cookie, separate table, separate login page)
// ---------------------------------------------------------------------------
router.post(
  '/admin/login',
  authLimiter,
  asyncRoute(async (req, res) => {
    const { email, password } = parse(schemas.adminLoginSchema, req.body);
    const admin = await db.queryOne('SELECT * FROM admins WHERE email = ? LIMIT 1', [email]);
    const generic = unauthorized('Those details do not match an admin account.', 'INVALID_CREDENTIALS');

    if (!admin) throw generic;
    const ok = await verifyPassword(admin.password_hash, password);
    if (!ok) {
      await audit(req, {
        actorType: 'SYSTEM',
        action: 'ADMIN_LOGIN_FAILED',
        entityType: 'ADMIN',
        entityId: admin.id,
        metadata: { email },
      });
      throw generic;
    }
    if (!admin.is_active) throw forbidden('This admin account is disabled.');

    await db.query('UPDATE admins SET last_login_at = NOW() WHERE id = ?', [admin.id]);
    auth.issueAdminSession(res, admin);

    req.admin = admin;
    await audit(req, { action: 'ADMIN_LOGIN' });

    res.json({
      admin: { id: admin.id, full_name: admin.full_name, email: admin.email, role: admin.role },
    });
  }),
);

router.post('/admin/logout', (req, res) => {
  auth.clearAdminSession(res);
  res.json({ ok: true });
});

module.exports = { router, publicUser, issueVerificationCode, UNDER_AGE_MESSAGE, notFound };
