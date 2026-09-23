// Roster data model, merge logic, and GitHub Contents API sync.
//
// roster.json shape:
// {
//   "version": 1,
//   "updatedAt": ISO, "updatedBy": "Pat",
//   "people": {
//     "<id>": { id, name, deleted, rosterAt, rosterBy,      // name/removal edits
//               status, note, statusAt, statusBy }          // duty status edits
//   }
// }
// Name edits and status edits carry separate timestamps so a rename by one user
// never wipes out a status update made by another at the same time.

export const STATUSES = ['PDY', 'School', 'Leave', 'Pass', 'Staff Duty', 'Recovery'];

export function emptyRoster() {
  return { version: 1, updatedAt: null, updatedBy: null, people: {} };
}

export function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function normalize(raw) {
  const out = emptyRoster();
  if (!raw || typeof raw !== 'object') return out;
  out.updatedAt = raw.updatedAt || null;
  out.updatedBy = raw.updatedBy || null;
  for (const [id, p] of Object.entries(raw.people || {})) {
    if (!p || typeof p !== 'object') continue;
    out.people[id] = {
      id,
      name: String(p.name || '').trim(),
      deleted: !!p.deleted,
      rosterAt: p.rosterAt || '',
      rosterBy: p.rosterBy || '',
      status: STATUSES.includes(p.status) ? p.status : null,
      note: String(p.note || ''),
      statusAt: p.statusAt || '',
      statusBy: p.statusBy || '',
    };
  }
  return out;
}

// Per person, newest name edit wins and newest status edit wins, independently.
export function mergeRosters(a, b) {
  const out = emptyRoster();
  const pa = a?.people || {}, pb = b?.people || {};
  for (const id of new Set([...Object.keys(pa), ...Object.keys(pb)])) {
    const x = pa[id], y = pb[id];
    if (!x || !y) { out.people[id] = { ...(x || y) }; continue; }
    const r = (x.rosterAt || '') >= (y.rosterAt || '') ? x : y;
    const s = (x.statusAt || '') >= (y.statusAt || '') ? x : y;
    out.people[id] = {
      id,
      name: r.name, deleted: r.deleted, rosterAt: r.rosterAt, rosterBy: r.rosterBy,
      status: s.status, note: s.note, statusAt: s.statusAt, statusBy: s.statusBy,
    };
  }
  const newer = (a?.updatedAt || '') >= (b?.updatedAt || '') ? a : b;
  out.updatedAt = newer?.updatedAt || null;
  out.updatedBy = newer?.updatedBy || null;
  return out;
}

const FIELDS = ['name', 'deleted', 'rosterAt', 'rosterBy', 'status', 'note', 'statusAt', 'statusBy'];
export const sameEntry = (a, b) => !!a && !!b && FIELDS.every(f => a[f] === b[f]);

// Local is always merged on top of the last-seen remote, so any difference
// means local holds edits the remote hasn't seen yet.
export function isPending(local, remote, id) {
  const l = local.people[id];
  return !!l && !sameEntry(l, remote.people[id]);
}

export function pendingIds(local, remote) {
  return Object.keys(local.people).filter(id => isPending(local, remote, id));
}

// Sort by name, ignoring a leading rank so "SGT Adams" sorts under A.
const RANK = /^(PV[12]|PVT|PFC|SPC|SP4|CPL|SGT|SSG|SFC|MSG|1SG|SGM|CSM|WO1|CW[2-5]|2LT|1LT|CPT|MAJ|LTC|COL|BG|MG|LTG|GEN|LCPL|GYSGT|SSGT|TSGT|MSGT|AMN|A1C|SRA|PO[123]|CPO|ENS|LTJG|LT|CDR|CAPT|MR|MRS|MS|DR)\.?\s+/i;
const sortKey = name => name.replace(RANK, '');
export const byName = (a, b) =>
  sortKey(a.name).localeCompare(sortKey(b.name), undefined, { sensitivity: 'base', numeric: true })
  || a.name.localeCompare(b.name);

// One human-readable line per changed person; used for commit messages and
// to decide whether a push is needed at all.
export function describeChanges(before, after) {
  const out = [];
  for (const p of Object.values(after.people).sort(byName)) {
    const q = before.people[p.id];
    if (sameEntry(p, q)) continue;
    if (p.deleted) { out.push(`removed ${p.name}`); continue; }
    const status = p.statusAt && p.statusAt !== q?.statusAt
      ? `${p.status || 'cleared'}${p.note ? ` (${p.note})` : ''}` : '';
    if (!q) { out.push(`added ${p.name}${status ? `: ${status}` : ''}`); continue; }
    const parts = [];
    if (q.deleted) parts.push(`restored ${p.name}`);
    if (p.name !== q.name) parts.push(`renamed ${q.name} -> ${p.name}`);
    if (status) parts.push(`${p.name}: ${status}`);
    out.push(parts.length ? parts.join(', ') : `${p.name}: updated`);
  }
  return out;
}

export function serialize(roster) {
  const people = {};
  for (const p of Object.values(roster.people).sort(byName)) people[p.id] = p;
  return JSON.stringify({ version: 1, updatedAt: roster.updatedAt, updatedBy: roster.updatedBy, people }, null, 2) + '\n';
}

// ---- GitHub Contents API ----

const API = 'https://api.github.com';

export function isConfigured(cfg) {
  return !!(cfg && cfg.owner && cfg.repo && cfg.token);
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

const repoPath = cfg => `/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}`;
const filePath = cfg => `${repoPath(cfg)}/contents/${(cfg.path || 'roster.json').split('/').map(encodeURIComponent).join('/')}`;

export class SyncError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function gh(cfg, path, opts = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${cfg.token.trim()}`,
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch {
    throw new SyncError('No connection. Changes are saved on this phone.', 0);
  }
  if (res.ok) return res.json();
  let detail = '';
  try { detail = (await res.json()).message || ''; } catch {}
  const msg = {
    401: 'GitHub rejected the token (wrong or expired).',
    403: /rate limit/i.test(detail) ? 'GitHub rate limit hit. Try again shortly.' : 'Token lacks permission. It needs Contents: Read and write on the roster repo.',
    404: 'Repo not found, or the token can\'t access it.',
    409: 'Someone pushed at the same moment.',
  }[res.status] || `GitHub error ${res.status}${detail ? `: ${detail}` : ''}`;
  throw new SyncError(msg, res.status);
}

// Returns { roster, sha }. sha is null when roster.json doesn't exist yet.
export async function fetchRemote(cfg) {
  try {
    const j = await gh(cfg, filePath(cfg));
    return { roster: normalize(JSON.parse(b64decode(j.content))), sha: j.sha };
  } catch (e) {
    if (e.status !== 404) throw e;
    await gh(cfg, repoPath(cfg)); // throws if the repo itself is unreachable
    return { roster: emptyRoster(), sha: null };
  }
}

async function putRemote(cfg, roster, sha, message) {
  const body = { message, content: b64encode(serialize(roster)) };
  if (sha) body.sha = sha;
  await gh(cfg, filePath(cfg), { method: 'PUT', body: JSON.stringify(body) });
}

// Fetch the latest remote, merge local edits into it, and write it back.
// Retries if another user pushed between our read and write.
// Returns { remote, changes } where remote is what's now on GitHub.
export async function pushRoster(cfg, local, userName) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { roster: remote, sha } = await fetchRemote(cfg);
    const merged = mergeRosters(remote, local);
    const changes = describeChanges(remote, merged);
    if (!changes.length) return { remote, changes };
    merged.updatedAt = new Date().toISOString();
    merged.updatedBy = userName;
    const summary = changes.slice(0, 4).join('; ') + (changes.length > 4 ? `; +${changes.length - 4} more` : '');
    try {
      await putRemote(cfg, merged, sha, `${userName}: ${summary}`);
      return { remote: merged, changes };
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt < 3) continue;
      throw e;
    }
  }
}

export async function testConnection(cfg) {
  const repo = await gh(cfg, repoPath(cfg));
  const { sha } = await fetchRemote(cfg);
  return { isPrivate: repo.private, fileExists: !!sha };
}
