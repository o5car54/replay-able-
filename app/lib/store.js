// Data layer — node:sqlite (built into Node 22, no native build, no npm install).
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'replayable.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS businesses (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT NOT NULL,
    owner_phone    TEXT NOT NULL DEFAULT '',
    twilio_number  TEXT NOT NULL DEFAULT '',
    reply_template TEXT NOT NULL DEFAULT '',
    timeout_seconds INTEGER NOT NULL DEFAULT 18,
    review_link    TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS leads (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    business_id    INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    caller_number  TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'new',   -- new | replied | won | lost
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_activity  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    direction      TEXT NOT NULL,                 -- out | in
    body           TEXT NOT NULL,
    delivery       TEXT NOT NULL DEFAULT 'sent',  -- sent | simulated | failed
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_leads_business ON leads(business_id);
  CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(lead_id);
`);

const DEFAULT_TEMPLATE =
  "Hi, this is {business} 👋 Sorry we missed your call — we're probably out on a job. " +
  "Reply here with what you need doing and we'll get right back to you.";

// Seed a demo business on first run so the dashboard is never empty.
const count = db.prepare('SELECT COUNT(*) AS n FROM businesses').get().n;
if (count === 0) {
  db.prepare(
    `INSERT INTO businesses (name, owner_phone, twilio_number, reply_template, timeout_seconds, review_link)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("Dave's Plumbing", '+447700900123', '+447700900999', DEFAULT_TEMPLATE, 18,
        'https://g.page/r/your-review-link');
}

export { DEFAULT_TEMPLATE };

// ---------- Businesses ----------
export const listBusinesses = () =>
  db.prepare('SELECT * FROM businesses ORDER BY name').all();

export const getBusiness = (id) =>
  db.prepare('SELECT * FROM businesses WHERE id = ?').get(id);

export const getBusinessByTwilioNumber = (num) =>
  db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(num);

export function createBusiness(b) {
  const info = db.prepare(
    `INSERT INTO businesses (name, owner_phone, twilio_number, reply_template, timeout_seconds, review_link)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(b.name, b.owner_phone || '', b.twilio_number || '',
        b.reply_template || DEFAULT_TEMPLATE, b.timeout_seconds || 18, b.review_link || '');
  return getBusiness(info.lastInsertRowid);
}

export function updateBusiness(id, b) {
  db.prepare(
    `UPDATE businesses SET name=?, owner_phone=?, twilio_number=?, reply_template=?,
       timeout_seconds=?, review_link=? WHERE id=?`
  ).run(b.name, b.owner_phone || '', b.twilio_number || '',
        b.reply_template || DEFAULT_TEMPLATE, b.timeout_seconds || 18, b.review_link || '', id);
  return getBusiness(id);
}

export function deleteBusiness(id) {
  db.prepare('DELETE FROM businesses WHERE id = ?').run(id);
}

// ---------- Leads ----------
export const getLeadById = (id) =>
  db.prepare('SELECT * FROM leads WHERE id = ?').get(id);

export const getOpenLead = (businessId, caller) =>
  db.prepare(
    `SELECT * FROM leads WHERE business_id = ? AND caller_number = ?
       AND status IN ('new','replied') ORDER BY id DESC LIMIT 1`
  ).get(businessId, caller);

export function createLead(businessId, caller) {
  const info = db.prepare(
    'INSERT INTO leads (business_id, caller_number) VALUES (?, ?)'
  ).run(businessId, caller);
  return getLeadById(info.lastInsertRowid);
}

export function setLeadStatus(id, status) {
  db.prepare('UPDATE leads SET status = ?, last_activity = datetime(\'now\') WHERE id = ?').run(status, id);
  return getLeadById(id);
}

export const listLeads = (businessId) =>
  db.prepare(
    `SELECT l.*,
       (SELECT COUNT(*) FROM messages m WHERE m.lead_id = l.id) AS message_count,
       (SELECT body FROM messages m WHERE m.lead_id = l.id ORDER BY m.id DESC LIMIT 1) AS last_message
     FROM leads l WHERE l.business_id = ? ORDER BY l.last_activity DESC`
  ).all(businessId);

// ---------- Messages ----------
export function addMessage(leadId, direction, body, delivery = 'sent') {
  const info = db.prepare(
    'INSERT INTO messages (lead_id, direction, body, delivery) VALUES (?, ?, ?, ?)'
  ).run(leadId, direction, body, delivery);
  db.prepare('UPDATE leads SET last_activity = datetime(\'now\') WHERE id = ?').run(leadId);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

export const listMessages = (leadId) =>
  db.prepare('SELECT * FROM messages WHERE lead_id = ? ORDER BY id').all(leadId);

// ---------- Stats ----------
export function stats(businessId) {
  const row = (sql, ...args) => db.prepare(sql).get(businessId, ...args);
  return {
    total: row('SELECT COUNT(*) AS n FROM leads WHERE business_id = ?').n,
    new_today: row("SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND date(created_at) = date('now')").n,
    replied: row("SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND status = 'replied'").n,
    won: row("SELECT COUNT(*) AS n FROM leads WHERE business_id = ? AND status = 'won'").n,
  };
}
