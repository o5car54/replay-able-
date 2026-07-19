// Twilio connection tester.
//   node check-twilio.js                 -> verify credentials only
//   node check-twilio.js +447xxxxxxxxx   -> also send a test SMS to that (verified) number
//
// Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN from app/.env (or the environment).
import { config, isLive } from './lib/config.js';

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

if (!isLive) {
  console.log(red('\n  ✗ No Twilio credentials found.'));
  console.log('  Add these to app/.env then re-run:\n');
  console.log(dim('    TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  console.log(dim('    TWILIO_AUTH_TOKEN=your_auth_token\n'));
  process.exit(1);
}

const auth = Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString('base64');
const headers = { Authorization: `Basic ${auth}` };

console.log('\n  Checking Twilio credentials…');

// 1) Verify the account is reachable and the token is valid.
const acctRes = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}.json`, { headers });
const acct = await acctRes.json();
if (!acctRes.ok) {
  console.log(red(`  ✗ Auth failed: ${acct.message || acctRes.status}`));
  console.log(dim('    Double-check the SID and Auth Token from console.twilio.com.\n'));
  process.exit(1);
}
console.log(green('  ✓ Connected!'));
console.log(`    Account:  ${acct.friendly_name}`);
console.log(`    Status:   ${acct.status}   Type: ${acct.type === 'Trial' ? 'Trial (free credit)' : acct.type}`);

// 2) List any phone numbers on the account.
const numRes = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/IncomingPhoneNumbers.json`, { headers });
const nums = (await numRes.json()).incoming_phone_numbers || [];
if (nums.length) {
  console.log(`    Numbers:  ${nums.map(n => n.phone_number).join(', ')}`);
} else {
  console.log(dim('    Numbers:  none yet — buy one under Phone Numbers → Buy a number.'));
}

// 3) Optional: send a test SMS.
const to = process.argv[2];
if (to) {
  const from = nums[0]?.phone_number;
  if (!from) { console.log(red('\n  ✗ Cannot send test — no Twilio number on the account yet.\n')); process.exit(1); }
  console.log(`\n  Sending a test text from ${from} to ${to}…`);
  const smsRes = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/Messages.json`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from,
        Body: 'Replayable test ✓ Your missed-call text-back is connected.' }) });
  const sms = await smsRes.json();
  if (!smsRes.ok) {
    console.log(red(`  ✗ Send failed: ${sms.message || smsRes.status}`));
    if (String(sms.message || '').includes('unverified'))
      console.log(dim('    On a trial account you can only text numbers you have verified in the console.'));
    process.exit(1);
  }
  console.log(green(`  ✓ Text sent! (sid ${sms.sid}, status ${sms.status})`));
  console.log(dim('    On trials the message is prefixed "Sent from your Twilio trial account".'));
}
console.log('');
