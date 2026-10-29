import {
  STATUSES, emptyRoster, newId, normalize, mergeRosters, isPending, pendingIds,
  byName, describeChanges, isConfigured, fetchRemote, pushRoster, testConnection,
} from './sync.js';
import { createAccessFile, fetchAccessFile, openAccessFile } from './access.js';

const AUTO_REFRESH_MS = 5 * 60 * 1000;
const DEADLINE_HOUR = 7; // 0700 local time
const KEYS = { settings: 'pdy.settings', local: 'pdy.local', remote: 'pdy.remote', lastSync: 'pdy.lastSync' };
const CODE_PREFIX = 'PDY1.';
const CHECK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const X_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

const $ = sel => document.querySelector(sel);

// ---------- storage ----------

function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function store(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
}

// member: joined with the team password (no token shown, no roster management).
const BLANK_SETTINGS = { name: '', owner: '', repo: '', path: 'roster.json', token: '', member: false };
let settings = { ...BLANK_SETTINGS, ...load(KEYS.settings, {}) };
let local = normalize(load(KEYS.local, null));   // this phone's roster, including unpushed edits
let remote = normalize(load(KEYS.remote, null)); // last roster seen on GitHub
let lastSync = load(KEYS.lastSync, null);
let syncError = null;
let busy = false;
let filter = 'all';
let editingId = null;
let currentView = '';
let teamFile = '';
let mainScroll = 0;
let renderedKey = '';

const saveData = () => { store(KEYS.local, local); store(KEYS.remote, remote); store(KEYS.lastSync, lastSync); };
const saveSettings = () => store(KEYS.settings, settings);

// ---------- helpers ----------

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const milDate = d => `${pad(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}`;
const milTime = d => `${pad(d.getHours())}${pad(d.getMinutes())}`;
const shortDay = d => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
const isToday = iso => !!iso && new Date(iso).toDateString() === new Date().toDateString();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const statusColor = s => `var(--s-${s.toLowerCase().replace(/\s+/g, '')})`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function when(iso) {
  const d = new Date(iso);
  return isToday(iso) ? milTime(d) : `${shortDay(d)} ${milTime(d)}`;
}

const activePeople = () => Object.values(local.people).filter(p => !p.deleted).sort(byName);
const needsUpdate = p => !p.status || !isToday(p.statusAt);
// Anyone not updated today turns red once the daily deadline passes.
const pastDeadline = () => new Date().getHours() >= DEADLINE_HOUR;
// Changes at midnight (new day) and at the deadline, so the list re-renders at both.
const renderKey = () => `${new Date().toDateString()}|${pastDeadline()}`;

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 5000 : 2500);
}

function requireName() {
  if (settings.name.trim()) return true;
  toast('Enter your name first');
  openView('settings');
  setTimeout(() => $('#set-name').focus(), 50);
  return false;
}

// ---------- main view ----------

function render() {
  renderedKey = renderKey();
  $('#today').textContent = `${DOW[new Date().getDay()]} ${milDate(new Date())}${settings.name ? ` · ${settings.name}` : ''}`;
  renderSync();
  renderSummary();
  renderList();
}

function renderSync() {
  const t = $('#sync-text'), btn = $('#btn-push');
  const configured = isConfigured(settings);
  const pending = pendingIds(local, remote).length;

  $('#btn-refresh').classList.toggle('spin', busy);
  $('#btn-refresh').hidden = !configured;
  t.classList.toggle('error', !!syncError && !busy);

  if (!configured) t.textContent = 'Saved on this phone only. Connect GitHub to share with your team.';
  else if (busy) t.textContent = 'Syncing…';
  else if (syncError) t.textContent = syncError;
  else if (!lastSync) t.textContent = 'Not synced yet';
  else {
    let s = `Synced ${milTime(new Date(lastSync))} (${ago(lastSync)})`;
    if (remote.updatedBy) s += `\nLast push: ${remote.updatedBy}, ${when(remote.updatedAt)}`;
    t.textContent = s;
  }

  if (!configured) {
    btn.textContent = 'Set up sync';
    btn.classList.toggle('has-changes', pending > 0);
    btn.disabled = false;
  } else {
    btn.textContent = pending ? `Push ${pending}` : 'Up to date';
    btn.classList.toggle('has-changes', pending > 0);
    btn.disabled = busy || !pending;
  }
}

function renderSummary() {
  const people = activePeople();
  const counts = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let needs = 0;
  for (const p of people) {
    if (p.status) counts[p.status]++;
    if (needsUpdate(p)) needs++;
  }
  const chips = [
    { key: 'all', label: 'All', n: people.length },
    ...STATUSES.map(s => ({ key: s, label: s, n: counts[s], color: statusColor(s) })),
    { key: 'needs', label: 'Needs update', n: needs },
  ];
  $('#summary').hidden = !people.length;
  $('#summary').innerHTML = chips.map(c => `
    <button class="chip${c.n ? '' : ' zero'}${filter === c.key ? ' active' : ''}${c.key === 'needs' ? ' needs' : ''}"
      data-filter="${esc(c.key)}" ${c.color ? `style="--c:${c.color}"` : ''} aria-pressed="${filter === c.key}">
      <span class="n">${c.n}</span>
      <span class="l">${c.color ? '<i></i>' : ''}${esc(c.label)}</span>
    </button>`).join('');
}

function statusBox(p) {
  const stale = p.status && !isToday(p.statusAt) ? ' stale' : '';
  if (!p.status) return '<span class="status-box unset">Set</span>';
  const icon = p.status === 'PDY' ? CHECK_SVG : '';
  return `<span class="status-box${stale}" style="--c:${statusColor(p.status)}">${icon}${esc(p.status)}</span>`;
}

function rowHtml(p) {
  const pending = isPending(local, remote, p.id);
  const stale = p.status && !isToday(p.statusAt);
  const overdue = needsUpdate(p) && pastDeadline();
  const meta = [];
  if (p.statusAt) {
    const d = new Date(p.statusAt);
    meta.push(stale ? `as of ${shortDay(d)}` : milTime(d), p.statusBy);
  }
  if (pending) meta.push('not pushed');
  return `<li><button class="row" data-id="${esc(p.id)}">
    <div class="who">
      <div class="name${overdue ? ' overdue' : ''}">${pending ? '<span class="dot"></span>' : ''}${esc(p.name)}</div>
      ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
      ${meta.length ? `<div class="meta${stale ? ' stale' : ''}">${esc(meta.filter(Boolean).join(' · '))}</div>` : ''}
    </div>
    ${statusBox(p)}
  </button></li>`;
}

function renderList() {
  const people = activePeople();
  const shown = people.filter(p => filter === 'all' || (filter === 'needs' ? needsUpdate(p) : p.status === filter));
  $('#list').innerHTML = shown.map(rowHtml).join('');
  $('#list').hidden = !shown.length;
  $('#btn-report').hidden = !people.length;

  const empty = $('#empty');
  empty.hidden = !!shown.length;
  if (!people.length && !isConfigured(settings)) {
    empty.innerHTML = `<p>Joining a team? Open Settings and paste the setup code a teammate sent you.<br><br>Starting fresh? Add your people, then connect GitHub.</p>
      <div class="row-inline"><button class="ghost-btn" style="flex:1" data-action="settings">Settings</button>
      <button class="primary-btn" style="flex:1" data-action="manage">Add people</button></div>`;
  } else if (!people.length && settings.member) {
    empty.innerHTML = `<p>The roster is empty. Ask an instructor to add people.</p>`;
  } else if (!people.length) {
    empty.innerHTML = `<p>The roster is empty.</p><button class="primary-btn" data-action="manage">Add people</button>`;
  } else if (!shown.length) {
    empty.innerHTML = `<p>No one in this group.</p><button class="ghost-btn" data-action="all">Show everyone</button>`;
  }
}

// ---------- status sheet ----------

function openSheet(id) {
  const p = local.people[id];
  if (!p || !requireName()) return;
  editingId = id;
  $('#sheet-name').textContent = p.name;
  $('#sheet-note').value = p.note;
  $('#status-grid').innerHTML = STATUSES.map(s => `
    <button class="status-opt${p.status === s ? ' selected' : ''}" data-status="${esc(s)}" style="--c:${statusColor(s)}">
      <i></i>${esc(s)}
    </button>`).join('');
  $('#sheet-meta').textContent = p.statusAt
    ? `${p.status || 'Cleared'} by ${p.statusBy}, ${when(p.statusAt)}`
    : 'Type a note if needed, then tap a status.';
  $('#sheet-clear').hidden = !p.status;
  $('#sheet').hidden = $('#backdrop').hidden = false;
  history.pushState({ v: 'main', sheet: true }, '');
}

function hideSheet() {
  $('#sheet').hidden = $('#backdrop').hidden = true;
  editingId = null;
}

function closeSheet() {
  if (history.state?.sheet) history.back();
  else hideSheet();
}

function setStatus(status) {
  const p = local.people[editingId];
  if (!p) return;
  p.status = status;
  p.note = status ? $('#sheet-note').value.trim() : '';
  p.statusAt = new Date().toISOString();
  p.statusBy = settings.name.trim();
  saveData();
  closeSheet();
  render();
}

// ---------- sync ----------

async function pull({ quiet = false } = {}) {
  if (!isConfigured(settings)) { if (!quiet) toast('Connect GitHub in Settings first'); return; }
  if (busy) return;
  busy = true;
  renderSync();
  try {
    const { roster } = await fetchRemote(settings);
    const hadRoster = Object.keys(remote.people).length > 0;
    const incoming = describeChanges(remote, roster).length;
    remote = roster;
    local = mergeRosters(roster, local);
    lastSync = new Date().toISOString();
    syncError = null;
    saveData();
    if (incoming && hadRoster) toast(`${plural(incoming, 'update')} from your team`);
    else if (incoming) toast('Roster loaded');
    else if (!quiet) toast('Up to date');
  } catch (e) {
    syncFailed(e, quiet);
  } finally {
    busy = false;
    render();
  }
}

async function push() {
  if (!isConfigured(settings)) { toast('Connect GitHub to share your roster'); openView('settings'); return; }
  if (!requireName() || busy) return;
  busy = true;
  syncError = null;
  renderSync();
  try {
    const res = await pushRoster(settings, local, settings.name.trim());
    remote = res.remote;
    local = mergeRosters(remote, local); // keeps any edits made while the push was in flight
    lastSync = new Date().toISOString();
    saveData();
    toast(res.changes.length ? `Pushed ${plural(res.changes.length, 'change')}` : 'Already up to date');
  } catch (e) {
    syncFailed(e, false);
  } finally {
    busy = false;
    render();
  }
}

function syncFailed(e, quiet) {
  if (e.status === 401 && settings.member) { lostTeamAccess(); return; }
  syncError = e.message;
  if (!quiet) toast(e.message, true);
}

// The token was replaced (new team access file). Members re-enter the team
// password; their name and any unpushed changes are kept.
function lostTeamAccess() {
  settings = { ...settings, token: '' };
  saveSettings();
  hideSheet();
  showView('main');
  gateError('Team access has changed. Enter the team password again.');
}

// ---------- sign in ----------

const needsSignIn = () => !isConfigured(settings) || !settings.name.trim();

function gateError(msg) {
  $('#gate-error').textContent = msg;
  $('#gate-error').hidden = !msg;
}

// Step 1: team password (unlocks the repo + token). Step 2: who you are.
function fillGate() {
  const step = isConfigured(settings) ? 'name' : 'pass';
  $('#gate-pass').hidden = step !== 'pass';
  $('#gate-name').hidden = step !== 'name';
  $('#gate-admin').hidden = step !== 'pass';
  gateError('');
  if (step === 'name') {
    $('#roster-names').innerHTML = activePeople().map(p => `<option value="${esc(p.name)}">`).join('');
    $('#gate-who').value = settings.name;
  }
}

async function submitPassword(e) {
  e.preventDefault();
  const btn = $('#gate-pass-btn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  gateError('');
  try {
    const res = await fetchAccessFile();
    if (res.status === 'offline') { gateError('No connection. Try again when you have signal.'); return; }
    if (res.status === 'missing') { gateError('Team access isn\'t set up yet. Ask an instructor.'); return; }
    const cfg = await openAccessFile(res.file, $('#gate-password').value);
    if (!cfg) { gateError('Wrong password.'); return; }
    settings = { ...settings, ...cfg, member: true };
    saveSettings();
    $('#gate-password').value = '';
    await pull({ quiet: true }); // loads the roster so people can pick their name
    if (!isConfigured(settings)) return; // token rejected; lostTeamAccess() already explained
    if (settings.name) showView('main'); else fillGate();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Enter';
  }
}

function submitName(e) {
  e.preventDefault();
  const name = $('#gate-who').value.trim().replace(/\s+/g, ' ');
  if (name.length < 2) { gateError('Enter your rank and name.'); return; }
  settings = { ...settings, name };
  saveSettings();
  showView('main');
  toast(`Signed in as ${name}`);
}

function signOut() {
  const pending = pendingIds(local, remote).length;
  const warn = pending ? `\n\n${plural(pending, 'change')} on this phone haven't been pushed and will be lost.` : '';
  if (!confirm(`Sign out of PDY Tracker on this phone?${warn}`)) return;
  local = emptyRoster();
  remote = emptyRoster();
  lastSync = null;
  syncError = null;
  saveData();
  settings = { ...BLANK_SETTINGS };
  saveSettings();
  history.replaceState({ v: 'main' }, '');
  showView('main');
}

// ---------- report ----------

function buildReport() {
  const people = activePeople();
  const now = new Date();
  const groups = Object.fromEntries(STATUSES.map(s => [s, []]));
  const unset = [];
  for (const p of people) (p.status ? groups[p.status] : unset).push(p);

  const line = p => `- ${p.name}${p.note ? ` – ${p.note}` : ''}${p.status && !isToday(p.statusAt) ? ` (as of ${shortDay(new Date(p.statusAt))})` : ''}`;
  const out = [`PERSTAT ${milDate(now)} as of ${milTime(now)}`, `Assigned: ${people.length}`];
  for (const s of STATUSES) out.push(`${s}: ${groups[s].length}`);
  if (unset.length) out.push(`Not reported: ${unset.length}`);
  for (const s of STATUSES.slice(1)) {
    if (groups[s].length) out.push('', `${s.toUpperCase()}:`, ...groups[s].map(line));
  }
  const stalePdy = groups.PDY.filter(p => !isToday(p.statusAt));
  if (stalePdy.length) out.push('', 'PDY, NOT CONFIRMED TODAY:', ...stalePdy.map(line));
  if (unset.length) out.push('', 'NOT REPORTED:', ...unset.map(p => `- ${p.name}`));
  return out.join('\n');
}

async function shareReport() {
  const text = buildReport();
  if (navigator.share) {
    try { await navigator.share({ text }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(text); toast('Report copied'); } catch { prompt('Copy the report:', text); }
}

// ---------- views ----------

function showView(v) {
  if (v === 'main' && needsSignIn()) v = 'gate';
  if (v !== currentView) {
    if (currentView === 'main') mainScroll = window.scrollY;
    for (const name of ['gate', 'main', 'settings', 'manage']) $(`#view-${name}`).hidden = name !== v;
    if (currentView === 'settings' && v === 'main' && isConfigured(settings)) pull({ quiet: true });
    currentView = v;
    if (v === 'settings') fillSettings();
    if (v === 'manage') renderManage();
    window.scrollTo(0, v === 'main' ? mainScroll : 0);
  }
  if (v === 'gate') fillGate();
  if (v === 'main') render();
}

// Views go through history so the phone's back button/gesture works.
function openView(v) {
  hideSheet();
  history.pushState({ v }, '');
  showView(v);
}

window.addEventListener('popstate', e => {
  hideSheet();
  showView(e.state?.v || 'main');
});

// ---------- settings ----------

function parseRepo(s) {
  const parts = s.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/i, '').split('/').filter(Boolean);
  return parts.length >= 2 ? { owner: parts[0], repo: parts[1] } : { owner: '', repo: '' };
}

// Phones that joined with the team password only see their name and Sign out;
// the repo/token fields are never filled in for them.
function fillSettings() {
  const member = !!settings.member;
  document.querySelectorAll('#view-settings [data-admin]').forEach(el => { el.hidden = member; });
  $('#member-panel').hidden = !member;
  $('#team-panel').hidden = member || !isConfigured(settings);
  $('#set-name').value = settings.name;
  $('#set-repo').value = !member && settings.owner && settings.repo ? `${settings.owner}/${settings.repo}` : '';
  $('#set-path').value = member ? '' : settings.path || 'roster.json';
  $('#set-token').value = member ? '' : settings.token;
  $('#set-code').value = '';
  $('#test-result').hidden = true;
  $('#team-result').hidden = true;
}

function readSettings() {
  if (settings.member) {
    settings = { ...settings, name: $('#set-name').value.trim() };
    saveSettings();
    return;
  }
  const { owner, repo } = parseRepo($('#set-repo').value);
  settings = {
    ...settings,
    name: $('#set-name').value.trim(),
    owner, repo,
    path: $('#set-path').value.trim() || 'roster.json',
    token: $('#set-token').value.trim(),
  };
  saveSettings();
}

async function runTest() {
  readSettings();
  const out = $('#test-result');
  out.hidden = false;
  out.className = 'test-result';
  if (!isConfigured(settings)) {
    out.classList.add('bad');
    out.textContent = 'Enter the repo (owner/name) and token first.';
    return;
  }
  out.textContent = 'Checking…';
  try {
    const r = await testConnection(settings);
    out.classList.add(r.isPrivate ? 'ok' : 'bad');
    out.textContent = (r.isPrivate
      ? '✓ Connected. '
      : '⚠ Connected, but this repo is PUBLIC, so anyone can read the roster. Make it private in the repo\'s GitHub settings. ')
      + (r.fileExists ? `${settings.path} found.` : `${settings.path} will be created on your first Push.`);
    $('#team-panel').hidden = false;
    syncError = null;
    pull({ quiet: true });
  } catch (e) {
    out.classList.add('bad');
    out.textContent = e.message;
  }
}

function makeSetupCode() {
  return CODE_PREFIX + btoa(JSON.stringify({ o: settings.owner, r: settings.repo, p: settings.path, t: settings.token }));
}

function parseSetupCode(s) {
  try {
    const j = JSON.parse(atob(s.trim().replace(/\s/g, '').replace(CODE_PREFIX, '')));
    if (j.o && j.r && j.t) return j;
  } catch {}
  return null;
}

async function copySetupCode() {
  readSettings();
  if (!isConfigured(settings)) { toast('Set up the repo and token first', true); return; }
  const code = makeSetupCode();
  try { await navigator.clipboard.writeText(code); toast('Setup code copied'); } catch { prompt('Copy this setup code:', code); }
}

function applySetupCode() {
  const j = parseSetupCode($('#set-code').value);
  if (!j) { toast('That setup code isn\'t valid', true); return; }
  settings = { ...settings, owner: j.o, repo: j.r, path: j.p || 'roster.json', token: j.t };
  saveSettings();
  const name = $('#set-name').value;
  fillSettings();
  $('#set-name').value = name;
  runTest();
}

// Where to save access.json in the app's own repo, when hosted on GitHub Pages.
function accessFileLink(exists) {
  const owner = location.hostname.match(/^([^.]+)\.github\.io$/i)?.[1];
  const repo = location.pathname.split('/').filter(Boolean)[0];
  if (!owner || !repo) return null;
  return exists
    ? `https://github.com/${owner}/${repo}/edit/main/access.json`
    : `https://github.com/${owner}/${repo}/new/main?filename=access.json`;
}

async function createTeamAccess() {
  readSettings();
  const out = $('#team-result');
  out.hidden = false;
  out.className = 'test-result';
  const password = $('#team-password').value;
  if (password.trim().length < 4) { out.classList.add('bad'); out.textContent = 'Use at least 4 characters.'; return; }
  if (!isConfigured(settings)) { out.classList.add('bad'); out.textContent = 'Connect the GitHub repo first.'; return; }
  out.textContent = 'Encrypting…';
  teamFile = await createAccessFile(settings, password);
  const exists = (await fetchAccessFile()).status === 'ok';
  const link = accessFileLink(exists);
  // Copy happens on its own tap: phones only allow clipboard writes directly from a tap.
  out.innerHTML = `
    <p class="team-step">1. <button id="btn-team-copy" class="ghost-btn">Copy file contents</button></p>
    <p class="team-step">2. ${link
      ? `<a class="ghost-btn link-as-btn" href="${esc(link)}" target="_blank" rel="noopener">Open GitHub</a>`
      : 'Save it as <b>access.json</b> next to index.html in the app\'s repo.'}</p>
    <p class="team-step">3. ${exists ? 'Select everything in the file and replace it with what you copied' : 'Paste it into the file'},
      then tap <b>Commit changes</b>. The password works about a minute later.</p>`;
  $('#btn-team-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(teamFile); toast('Copied'); } catch { prompt('Copy this:', teamFile); }
  });
}

function resetPhone() {
  const pending = pendingIds(local, remote).length;
  const warn = pending ? `\n\n${plural(pending, 'change')} on this phone haven't been pushed and will be lost.` : '';
  if (!confirm(`Clear the roster stored on this phone and reload it from GitHub?${warn}`)) return;
  local = emptyRoster();
  remote = emptyRoster();
  lastSync = null;
  syncError = null;
  saveData();
  history.back();
  if (isConfigured(settings)) pull();
}

// ---------- manage roster ----------

function renderManage() {
  const people = activePeople();
  $('#manage-count').textContent = plural(people.length, 'person').replace('persons', 'people');
  $('#manage-list').innerHTML = people.map(p => `
    <li data-id="${esc(p.id)}">
      <input value="${esc(p.name)}" aria-label="Name" autocomplete="off">
      <button class="icon-btn remove" aria-label="Remove ${esc(p.name)}">${X_SVG}</button>
    </li>`).join('');
  $('#manage-list').hidden = !people.length;
}

function touchRoster(p) {
  p.rosterAt = new Date().toISOString();
  p.rosterBy = settings.name.trim();
}

function addPeople() {
  if (!requireName()) return;
  const existing = new Set(activePeople().map(p => p.name.toLowerCase()));
  let added = 0, dupes = 0;
  for (const raw of $('#add-names').value.split('\n')) {
    const name = raw.trim().replace(/\s+/g, ' ');
    if (!name) continue;
    if (existing.has(name.toLowerCase())) { dupes++; continue; }
    existing.add(name.toLowerCase());
    const id = newId();
    local.people[id] = { id, name, deleted: false, rosterAt: '', rosterBy: '', status: null, note: '', statusAt: '', statusBy: '' };
    touchRoster(local.people[id]);
    added++;
  }
  if (!added && !dupes) return;
  saveData();
  $('#add-names').value = '';
  renderManage();
  toast(`Added ${plural(added, 'person').replace('persons', 'people')}${dupes ? `, skipped ${dupes} already on the roster` : ''}`);
}

function renamePerson(id, input) {
  const p = local.people[id];
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (!p || !name || name === p.name) { if (p) input.value = p.name; return; }
  if (!requireName()) { input.value = p.name; return; }
  p.name = name;
  touchRoster(p);
  saveData();
}

function removePerson(id) {
  const p = local.people[id];
  if (!p || !requireName() || !confirm(`Remove ${p.name} from the roster?`)) return;
  p.deleted = true;
  touchRoster(p);
  saveData();
  renderManage();
}

// ---------- wiring ----------

$('#list').addEventListener('click', e => {
  const row = e.target.closest('.row');
  if (row) openSheet(row.dataset.id);
});
$('#summary').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  filter = chip.dataset.filter === filter ? 'all' : chip.dataset.filter;
  render();
});
$('#empty').addEventListener('click', e => {
  const a = e.target.closest('[data-action]')?.dataset.action;
  if (a === 'all') { filter = 'all'; render(); }
  else if (a) openView(a);
});
$('#status-grid').addEventListener('click', e => {
  const opt = e.target.closest('.status-opt');
  if (opt) setStatus(opt.dataset.status);
});
$('#sheet-clear').addEventListener('click', () => setStatus(null));
$('#sheet-close').addEventListener('click', closeSheet);
$('#backdrop').addEventListener('click', closeSheet);
$('#sheet-note').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

$('#btn-refresh').addEventListener('click', () => pull());
$('#btn-push').addEventListener('click', push);
$('#btn-settings').addEventListener('click', () => openView('settings'));
$('#btn-report').addEventListener('click', shareReport);
document.querySelectorAll('.back').forEach(b => b.addEventListener('click', () => history.back()));

for (const id of ['#set-name', '#set-repo', '#set-path', '#set-token']) $(id).addEventListener('input', readSettings);
$('#btn-show-token').addEventListener('click', e => {
  const f = $('#set-token');
  f.type = f.type === 'password' ? 'text' : 'password';
  e.target.textContent = f.type === 'password' ? 'Show' : 'Hide';
});
$('#btn-test').addEventListener('click', runTest);
$('#btn-copy-code').addEventListener('click', copySetupCode);
$('#btn-apply-code').addEventListener('click', applySetupCode);
$('#btn-manage').addEventListener('click', () => openView('manage'));
$('#btn-reset').addEventListener('click', resetPhone);
$('#btn-team').addEventListener('click', createTeamAccess);
$('#btn-signout').addEventListener('click', signOut);

$('#gate-pass').addEventListener('submit', submitPassword);
$('#gate-name').addEventListener('submit', submitName);
$('#gate-admin').addEventListener('click', () => openView('settings'));

$('#btn-add').addEventListener('click', addPeople);
$('#manage-list').addEventListener('change', e => {
  const li = e.target.closest('li');
  if (li && e.target.matches('input')) renamePerson(li.dataset.id, e.target);
});
$('#manage-list').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.matches('input')) e.target.blur(); });
$('#manage-list').addEventListener('click', e => {
  const btn = e.target.closest('.remove');
  if (btn) removePerson(btn.closest('li').dataset.id);
});

// Auto-refresh every 5 minutes while open, and whenever the app comes back to the foreground.
setInterval(() => { if (document.visibilityState === 'visible') pull({ quiet: true }); }, AUTO_REFRESH_MS);
setInterval(() => {
  if (currentView !== 'main') return;
  if (renderKey() !== renderedKey) render(); else renderSync();
}, 30 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (currentView === 'main') render();
  if (!lastSync || Date.now() - new Date(lastSync) > 60 * 1000) pull({ quiet: true });
});

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

history.replaceState({ v: 'main' }, '');
showView('main'); // goes to sign-in instead if this phone isn't set up
pull({ quiet: true });
