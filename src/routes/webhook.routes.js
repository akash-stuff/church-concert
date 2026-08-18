'use strict';

const crypto = require('crypto');
const express = require('express');
const env = require('../env');
const db = require('../db');
const notifications = require('../services/notifications');
const { audit } = require('../lib/audit');
const { asyncRoute, sha256, timingSafeEqual, maskPhone } = require('../lib/helpers');

const router = express.Router();

/**
 * Meta's verification handshake. Called once when the webhook URL is saved in
 * the WhatsApp app configuration.
 */
router.get('/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && env.whatsapp.verifyToken && timingSafeEqual(token || '', env.whatsapp.verifyToken)) {
    return res.status(200).send(String(challenge ?? ''));
  }
  return res.sendStatus(403);
});

/**
 * Verify X-Hub-Signature-256 against the raw body. Requires the raw body to
 * have been captured by the express.json verify hook in app.js.
 */
function signatureValid(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET || '';
  if (!appSecret) return true; // Not configured: skip rather than reject.
  const header = req.get('x-hub-signature-256') || '';
  if (!req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex')}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Inbound events. Two things are handled:
 *   statuses — delivery receipts, recorded against the notification row
 *   messages — a reply containing the verification code marks the number
 *              verified, which is the "authorise over WhatsApp" path
 *
 * Always answers 200 so Meta does not retry indefinitely on our bugs.
 */
router.post(
  '/whatsapp',
  asyncRoute(async (req, res) => {
    if (!signatureValid(req)) {
      console.warn('[webhook] rejected a payload with an invalid signature');
      return res.sendStatus(401);
    }

    res.sendStatus(200); // Acknowledge first, then process.

    try {
      const entries = req.body?.entry ?? [];
      for (const entry of entries) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};

          for (const status of value.statuses ?? []) {
            await notifications.updateDeliveryStatus(
              status.id,
              status.status,
              status.errors?.[0]?.title || status.errors?.[0]?.message,
            );
          }

          for (const message of value.messages ?? []) {
            await handleInbound(message);
          }
        }
      }
    } catch (err) {
      console.error('[webhook] processing failed:', err.message);
    }
    return undefined;
  }),
);

/** A user replying with their code verifies the number without leaving WhatsApp. */
async function handleInbound(message) {
  if (message.type !== 'text') return;
  const from = `+${String(message.from).replace(/^\+/, '')}`;
  const text = String(message.text?.body ?? '').trim();
  const code = text.match(/\b(\d{4,8})\b/)?.[1];
  if (!code) return;

  const user = await db.queryOne(
    'SELECT id, full_name, whatsapp_number, whatsapp_verified FROM users WHERE whatsapp_number = ? LIMIT 1',
    [from],
  );
  if (!user || user.whatsapp_verified) return;

  const record = await db.queryOne(
    `SELECT * FROM whatsapp_verifications
      WHERE user_id = ? AND consumed_at IS NULL AND expires_at > NOW()
      ORDER BY id DESC LIMIT 1`,
    [user.id],
  );
  if (!record || record.attempts >= record.max_attempts) return;

  if (sha256(code) !== record.code_hash) {
    await db.query('UPDATE whatsapp_verifications SET attempts = attempts + 1 WHERE id = ?', [
      record.id,
    ]);
    return;
  }

  await db.transaction(async (conn) => {
    await conn.execute('UPDATE whatsapp_verifications SET consumed_at = NOW() WHERE id = ?', [
      record.id,
    ]);
    await conn.execute(
      'UPDATE users SET whatsapp_verified = 1, whatsapp_verified_at = NOW() WHERE id = ?',
      [user.id],
    );
  });

  await audit(null, {
    actorType: 'USER',
    actorId: user.id,
    action: 'WHATSAPP_VERIFIED_BY_REPLY',
    entityType: 'USER',
    entityId: user.id,
    metadata: { phone: maskPhone(from) },
  });

  console.log(`[webhook] verified ${maskPhone(from)} from an inbound reply`);
}

module.exports = router;
