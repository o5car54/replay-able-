// Core business logic — shared by the real Twilio webhooks AND the simulator,
// so "test mode" exercises exactly the same code path as a live missed call.
import * as store from './store.js';
import { sendSms, renderTemplate } from './telephony.js';

// A call to `business` was missed by `callerNumber`. Create/find the lead and
// fire the automatic text-back. Returns { lead, message }.
export async function handleMissedCall(business, callerNumber) {
  let lead = store.getOpenLead(business.id, callerNumber);
  if (!lead) lead = store.createLead(business.id, callerNumber);

  const body = renderTemplate(business.reply_template || store.DEFAULT_TEMPLATE, business);
  const result = await sendSms({
    to: callerNumber,
    from: business.twilio_number,
    body,
  });

  const message = store.addMessage(lead.id, 'out', body, result.delivery);
  return { lead: store.getLeadById(lead.id), message, delivery: result.delivery };
}

// An inbound SMS arrived from a lead. Log it and mark the lead as 'replied'.
export function handleInboundSms(business, fromNumber, body) {
  let lead = store.getOpenLead(business.id, fromNumber);
  if (!lead) lead = store.createLead(business.id, fromNumber); // reply with no prior missed call
  const message = store.addMessage(lead.id, 'in', body, 'sent');
  if (lead.status === 'new') store.setLeadStatus(lead.id, 'replied');
  return { lead: store.getLeadById(lead.id), message };
}

// Owner sends a manual reply from the dashboard.
export async function sendOwnerReply(lead, body) {
  const business = store.getBusiness(lead.business_id);
  const result = await sendSms({
    to: lead.caller_number,
    from: business.twilio_number,
    body,
  });
  return store.addMessage(lead.id, 'out', body, result.delivery);
}
