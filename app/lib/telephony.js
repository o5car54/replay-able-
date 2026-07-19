// Telephony adapter. Sends SMS via the Twilio REST API using the built-in
// global fetch (no SDK, no npm install). Falls back to SIMULATION mode when no
// Twilio credentials are configured, so the whole product is usable for free.
import { config, isLive } from './config.js';

const esc = (s) => String(s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;');

// Fill {business} / {review} placeholders in a reply template.
export function renderTemplate(template, business) {
  return String(template || '')
    .replaceAll('{business}', business.name || 'us')
    .replaceAll('{review}', business.review_link || '');
}

// Returns { delivery: 'sent'|'simulated'|'failed', sid, error }
export async function sendSms({ to, from, body }) {
  if (!isLive) {
    console.log(`  [SIMULATED SMS] to=${to} from=${from} :: ${body}`);
    return { delivery: 'simulated', sid: 'SIM-' + Date.now() };
  }
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`;
    const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('  [TWILIO ERROR]', data.message || res.status);
      return { delivery: 'failed', error: data.message || `HTTP ${res.status}` };
    }
    return { delivery: 'sent', sid: data.sid };
  } catch (err) {
    console.error('  [TWILIO EXCEPTION]', err.message);
    return { delivery: 'failed', error: err.message };
  }
}

// TwiML: when a call hits the Twilio number, try the owner's real phone first.
// If they don't pick up, the <Dial action> fires our voice-status webhook.
export function dialTwiML({ ownerPhone, timeout, statusUrl }) {
  if (!ownerPhone) {
    // No owner phone configured — go straight to the missed-call path.
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="${Number(timeout) || 18}" answerOnBridge="true" action="${esc(statusUrl)}" method="POST">
    <Number>${esc(ownerPhone)}</Number>
  </Dial>
</Response>`;
}

export const emptyTwiML = () =>
  `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
