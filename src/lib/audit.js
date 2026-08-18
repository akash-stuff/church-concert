'use strict';

const db = require('../db');
const { clientIp } = require('./helpers');

/**
 * Write an audit entry. Never throws — a logging failure must not roll back or
 * break the action being logged. Pass `conn` to log inside a transaction.
 */
async function audit(req, entry, conn = null) {
  const runner = conn || db.pool;
  const actor = req?.admin
    ? { type: 'ADMIN', id: req.admin.id, label: req.admin.email }
    : req?.user
      ? { type: 'USER', id: req.user.id, label: req.user.email }
      : { type: 'SYSTEM', id: null, label: null };

  try {
    await runner.execute(
      `INSERT INTO audit_logs
         (actor_type, actor_id, actor_label, action, entity_type, entity_id,
          metadata, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.actorType || actor.type,
        entry.actorId ?? actor.id,
        entry.actorLabel ?? actor.label,
        entry.action,
        entry.entityType ?? null,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        req ? clientIp(req) : null,
        req?.get?.('user-agent')?.slice(0, 255) ?? null,
      ],
    );
  } catch (err) {
    console.error('[audit] failed to write entry:', entry.action, err.message);
  }
}

const DEFAULT_SETTINGS = {
  duplicate_check_fields: ['email', 'mobile_number', 'whatsapp_number'],
  minimum_age: 18,
  require_whatsapp_verification: true,
  allow_user_self_cancel: true,
};

async function getSettings() {
  const rows = await db.query('SELECT setting_key, value FROM app_settings');
  const settings = { ...DEFAULT_SETTINGS };
  for (const row of rows) {
    const raw = row.value;
    settings[row.setting_key] = typeof raw === 'string' ? safeJson(raw) : raw;
  }
  // minimum_age is a floor, not a ceiling: never drop below 18.
  settings.minimum_age = Math.max(18, Number(settings.minimum_age) || 18);
  return settings;
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

async function setSettings(patch) {
  const entries = Object.entries(patch);
  if (!entries.length) return;
  for (const [key, value] of entries) {
    await db.query(
      `INSERT INTO app_settings (setting_key, value) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE value = VALUES(value)`,
      [key, JSON.stringify(value)],
    );
  }
}

module.exports = { audit, getSettings, setSettings, DEFAULT_SETTINGS };
