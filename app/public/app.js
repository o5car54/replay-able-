// Replayable dashboard — vanilla JS, talks to the REST API.
let state = { businesses: [], currentBiz: null, currentLead: null, editingBizId: null };

const $ = (id) => document.getElementById(id);
const api = async (path, method = 'GET', body) => {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const initials = (num) => String(num).replace(/\D/g, '').slice(-2) || '??';
const timeAgo = (iso) => {
  const d = (Date.now() - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 1000;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + 'm';
  if (d < 86400) return Math.floor(d / 3600) + 'h';
  return Math.floor(d / 86400) + 'd';
};
let toastTimer;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ---------- boot ----------
(async function init() {
  const s = await api('/session');
  if (s.passwordRequired && !s.authed) { $('login').classList.remove('hidden'); return; }
  startApp(s);
})();

async function doLogin() {
  try {
    await api('/login', 'POST', { password: $('pw').value });
    location.reload();
  } catch { $('loginErr').textContent = 'Wrong password. Try again.'; }
}
async function doLogout() { await api('/logout', 'POST'); location.reload(); }

async function startApp(session) {
  $('app').classList.remove('hidden');
  if (!session.passwordRequired) $('logoutBtn').classList.add('hidden');
  const badge = $('modeBadge');
  if (session.live) { badge.textContent = 'LIVE'; badge.className = 'mode-badge mode-live'; }
  else { badge.textContent = 'SIMULATION'; badge.className = 'mode-badge mode-sim'; }
  await loadBusinesses();
}

// ---------- businesses ----------
async function loadBusinesses() {
  state.businesses = await api('/businesses');
  const sel = $('bizSelect');
  sel.innerHTML = state.businesses.map(b => `<option value="${b.id}">${esc(b.name)}</option>`).join('');
  if (state.businesses.length) {
    state.currentBiz = state.businesses.find(b => b.id === state.currentBiz?.id) || state.businesses[0];
    sel.value = state.currentBiz.id;
    await refresh();
  }
}
async function selectBusiness(id) {
  state.currentBiz = state.businesses.find(b => b.id === Number(id));
  state.currentLead = null;
  clearConversation();
  await refresh();
}
async function refresh() { await Promise.all([loadStats(), loadLeads()]); }

async function loadStats() {
  const s = await api(`/businesses/${state.currentBiz.id}/stats`);
  $('stTotal').textContent = s.total;
  $('stToday').textContent = s.new_today;
  $('stReplied').textContent = s.replied;
  $('stWon').textContent = s.won;
}

async function loadLeads() {
  const leads = await api(`/businesses/${state.currentBiz.id}/leads`);
  const list = $('leadList');
  if (!leads.length) { list.innerHTML = `<div class="empty">No leads yet. Try the “Simulate missed call” button below 👇</div>`; return; }
  list.innerHTML = leads.map(l => `
    <div class="lead ${state.currentLead === l.id ? 'active' : ''}" onclick="openLead(${l.id})">
      <div class="avatar">${initials(l.caller_number)}</div>
      <div class="meta">
        <div class="num">${esc(l.caller_number)} <span class="pill ${l.status}">${l.status}</span></div>
        <div class="snippet">${esc(l.last_message || '—')}</div>
      </div>
      <div class="time">${timeAgo(l.last_activity)}</div>
    </div>`).join('');
}

// ---------- conversation ----------
function clearConversation() {
  $('convTitle').textContent = 'Select a lead';
  $('statusBtns').innerHTML = '';
  $('thread').innerHTML = `<div class="empty">Pick a lead on the left to see the conversation.</div>`;
  $('compose').classList.add('hidden');
}
async function openLead(id) {
  state.currentLead = id;
  const { lead, messages } = await api(`/leads/${id}`);
  document.querySelectorAll('.lead').forEach(el => el.classList.remove('active'));
  $('convTitle').textContent = lead.caller_number;
  $('statusBtns').innerHTML = `
    <button class="chip won" onclick="setStatus(${id},'won')">Mark won</button>
    <button class="chip lost" onclick="setStatus(${id},'lost')">Lost</button>`;
  $('thread').innerHTML = messages.length ? messages.map(m => `
    <div class="msg ${m.direction}">${esc(m.body)}
      <span class="m-meta">${m.direction === 'out' ? 'Sent' : 'Received'} · ${timeAgo(m.created_at)}${m.delivery === 'simulated' ? ' · simulated' : m.delivery === 'failed' ? ' · failed' : ''}</span>
    </div>`).join('') : `<div class="empty">No messages yet.</div>`;
  $('thread').scrollTop = $('thread').scrollHeight;
  $('compose').classList.remove('hidden');
  loadLeads();
}
async function sendReply() {
  const box = $('replyBox'); const body = box.value.trim();
  if (!body || !state.currentLead) return;
  box.value = '';
  await api(`/leads/${state.currentLead}/reply`, 'POST', { body });
  await openLead(state.currentLead);
  toast('Reply sent');
}
async function setStatus(id, status) {
  await api(`/leads/${id}/status`, 'POST', { status });
  await refresh(); await openLead(id);
  toast(status === 'won' ? 'Nice — job won! 🎉' : 'Marked ' + status);
}

// ---------- simulate ----------
async function simulateMissed() {
  const caller = $('simNumber').value.trim() || '+447700900555';
  await api('/simulate/missed-call', 'POST', { business_id: state.currentBiz.id, caller });
  await refresh();
  toast('Missed call simulated — auto-text sent');
}
async function simulateReply() {
  const caller = $('simNumber').value.trim() || '+447700900555';
  const body = $('simReply').value.trim() || 'Yes please';
  await api('/simulate/inbound-sms', 'POST', { business_id: state.currentBiz.id, caller, body });
  await refresh();
  const leads = await api(`/businesses/${state.currentBiz.id}/leads`);
  const match = leads.find(l => l.caller_number === caller);
  if (match) await openLead(match.id);
  toast('Customer reply simulated');
}

// ---------- business modal ----------
function openBusinessModal(edit) {
  state.editingBizId = edit ? state.currentBiz.id : null;
  const b = edit ? state.currentBiz : { name:'', owner_phone:'', twilio_number:'',
    reply_template:"Hi, this is {business} 👋 Sorry we missed your call — we're probably out on a job. Reply here with what you need doing and we'll get right back to you.",
    timeout_seconds:18, review_link:'' };
  $('bizModalTitle').textContent = edit ? 'Edit client' : 'Add client';
  $('f_name').value = b.name; $('f_owner').value = b.owner_phone; $('f_twilio').value = b.twilio_number;
  $('f_template').value = b.reply_template; $('f_timeout').value = b.timeout_seconds; $('f_review').value = b.review_link;
  $('bizDeleteBtn').style.display = edit ? 'inline-flex' : 'none';
  $('bizModal').classList.remove('hidden');
}
function closeBusinessModal() { $('bizModal').classList.add('hidden'); }
async function saveBusiness() {
  const payload = {
    name: $('f_name').value.trim(), owner_phone: $('f_owner').value.trim(),
    twilio_number: $('f_twilio').value.trim(), reply_template: $('f_template').value.trim(),
    timeout_seconds: Number($('f_timeout').value) || 18, review_link: $('f_review').value.trim(),
  };
  if (!payload.name) { toast('Business name is required'); return; }
  if (state.editingBizId) { await api(`/businesses/${state.editingBizId}`, 'PUT', payload); }
  else { const created = await api('/businesses', 'POST', payload); state.currentBiz = created; }
  closeBusinessModal();
  await loadBusinesses();
  toast('Saved');
}
async function deleteBusiness() {
  if (!state.editingBizId || !confirm('Delete this client and all their leads?')) return;
  await api(`/businesses/${state.editingBizId}`, 'DELETE');
  state.currentBiz = null; closeBusinessModal(); await loadBusinesses(); toast('Client deleted');
}

// double-click the selector label area to edit current business
$('bizSelect').addEventListener('dblclick', () => openBusinessModal(true));
