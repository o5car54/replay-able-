// Replayable — zero-dependency Node server.
// Run:  node server.js       (from the app/ directory)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { randomUUID } from 'node:crypto';

import { config, isLive } from './lib/config.js';
import * as store from './lib/store.js';
import { handleMissedCall, handleInboundSms, sendOwnerReply } from './lib/logic.js';
import { dialTwiML, emptyTwiML } from './lib/telephony.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');

// ---------- tiny helpers ----------
const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};
const sendXml = (res, xml) => {
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(xml);
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}
async function parseBody(req) {
  const raw = await readBody(req);
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(raw)); // form-urlencoded (Twilio)
}

// ---------- ultra-light session auth ----------
const sessions = new Set();
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('='); return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1))];
  }).filter(p => p[0]));
}
function isAuthed(req) {
  if (!config.adminPassword) return true;          // no password set => open (dev)
  const sid = parseCookies(req).rb_session;
  return sid && sessions.has(sid);
}

// ---------- static files ----------
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
               '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const buf = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  } catch { send(res, 404, { error: 'not found' }); }
}

// ---------- main handler ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const method = req.method;

  try {
    // ===== Twilio webhooks (no auth; secured in prod via Twilio signature — see README) =====
    if (p === '/webhooks/voice' && method === 'POST') {
      const body = await parseBody(req);
      const business = store.getBusinessByTwilioNumber(body.To) || store.listBusinesses()[0];
      if (!business) return sendXml(res, emptyTwiML());
      const statusUrl = `${url.origin}/webhooks/voice-status?business=${business.id}&caller=${encodeURIComponent(body.From || '')}`;
      return sendXml(res, dialTwiML({
        ownerPhone: business.owner_phone, timeout: business.timeout_seconds, statusUrl,
      }));
    }

    if (p === '/webhooks/voice-status' && method === 'POST') {
      const body = await parseBody(req);
      const business = store.getBusiness(Number(url.searchParams.get('business')));
      const caller = url.searchParams.get('caller') || body.From;
      const status = body.DialCallStatus; // completed | no-answer | busy | failed | canceled
      if (business && caller && status && status !== 'completed') {
        await handleMissedCall(business, caller);
      }
      return sendXml(res, emptyTwiML());
    }

    if (p === '/webhooks/sms' && method === 'POST') {
      const body = await parseBody(req);
      const business = store.getBusinessByTwilioNumber(body.To) || store.listBusinesses()[0];
      if (business && body.From) handleInboundSms(business, body.From, body.Body || '');
      return sendXml(res, emptyTwiML());
    }

    // ===== Auth endpoints =====
    if (p === '/api/login' && method === 'POST') {
      const body = await parseBody(req);
      if (config.adminPassword && body.password === config.adminPassword) {
        const sid = randomUUID(); sessions.add(sid);
        return send(res, 200, { ok: true }, {
          'Set-Cookie': `rb_session=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`,
        });
      }
      return send(res, 401, { error: 'Wrong password' });
    }
    if (p === '/api/logout' && method === 'POST') {
      const sid = parseCookies(req).rb_session; sessions.delete(sid);
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'rb_session=; Path=/; Max-Age=0' });
    }
    if (p === '/api/session' && method === 'GET') {
      return send(res, 200, { authed: isAuthed(req), passwordRequired: Boolean(config.adminPassword), live: isLive });
    }

    // ===== Everything under /api requires auth =====
    if (p.startsWith('/api/')) {
      if (!isAuthed(req)) return send(res, 401, { error: 'auth required' });

      // Businesses
      if (p === '/api/businesses' && method === 'GET')
        return send(res, 200, store.listBusinesses());
      if (p === '/api/businesses' && method === 'POST') {
        const b = await parseBody(req);
        if (!b.name) return send(res, 400, { error: 'name required' });
        return send(res, 200, store.createBusiness(b));
      }
      const bizMatch = p.match(/^\/api\/businesses\/(\d+)$/);
      if (bizMatch) {
        const id = Number(bizMatch[1]);
        if (method === 'PUT') return send(res, 200, store.updateBusiness(id, await parseBody(req)));
        if (method === 'DELETE') { store.deleteBusiness(id); return send(res, 200, { ok: true }); }
      }

      // Stats + leads for a business
      const statMatch = p.match(/^\/api\/businesses\/(\d+)\/stats$/);
      if (statMatch && method === 'GET') return send(res, 200, store.stats(Number(statMatch[1])));

      const leadsMatch = p.match(/^\/api\/businesses\/(\d+)\/leads$/);
      if (leadsMatch && method === 'GET') return send(res, 200, store.listLeads(Number(leadsMatch[1])));

      // Single lead conversation
      const convMatch = p.match(/^\/api\/leads\/(\d+)$/);
      if (convMatch && method === 'GET') {
        const lead = store.getLeadById(Number(convMatch[1]));
        if (!lead) return send(res, 404, { error: 'not found' });
        return send(res, 200, { lead, messages: store.listMessages(lead.id) });
      }
      const statusMatch = p.match(/^\/api\/leads\/(\d+)\/status$/);
      if (statusMatch && method === 'POST') {
        const { status } = await parseBody(req);
        return send(res, 200, store.setLeadStatus(Number(statusMatch[1]), status));
      }
      const replyMatch = p.match(/^\/api\/leads\/(\d+)\/reply$/);
      if (replyMatch && method === 'POST') {
        const lead = store.getLeadById(Number(replyMatch[1]));
        const { body } = await parseBody(req);
        if (!lead || !body) return send(res, 400, { error: 'lead and body required' });
        const msg = await sendOwnerReply(lead, body);
        return send(res, 200, msg);
      }

      // Simulator — the exact live code path, no Twilio needed.
      if (p === '/api/simulate/missed-call' && method === 'POST') {
        const { business_id, caller } = await parseBody(req);
        const business = store.getBusiness(Number(business_id));
        if (!business) return send(res, 400, { error: 'unknown business' });
        const out = await handleMissedCall(business, caller || '+447700900000');
        return send(res, 200, out);
      }
      if (p === '/api/simulate/inbound-sms' && method === 'POST') {
        const { business_id, caller, body } = await parseBody(req);
        const business = store.getBusiness(Number(business_id));
        if (!business) return send(res, 400, { error: 'unknown business' });
        return send(res, 200, handleInboundSms(business, caller || '+447700900000', body || 'Yes please, when can you come out?'));
      }

      return send(res, 404, { error: 'unknown api route' });
    }

    // ===== static dashboard =====
    if (method === 'GET') return serveStatic(res, p);
    return send(res, 405, { error: 'method not allowed' });
  } catch (err) {
    console.error('Server error:', err);
    return send(res, 500, { error: 'server error' });
  }
});

server.listen(config.port, () => {
  console.log('');
  console.log('  ╭───────────────────────────────────────────────╮');
  console.log('  │   Replayable  ·  missed-call text-back engine  │');
  console.log('  ╰───────────────────────────────────────────────╯');
  console.log(`  Dashboard:  http://localhost:${config.port}`);
  console.log(`  Mode:       ${isLive ? 'LIVE (Twilio connected)' : 'SIMULATION (no Twilio keys — texts are logged, not sent)'}`);
  console.log(`  Auth:       ${config.adminPassword ? 'password protected' : 'OPEN (set ADMIN_PASSWORD in .env before hosting)'}`);
  console.log('');
});
