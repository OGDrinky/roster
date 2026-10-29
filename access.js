// Team access file (access.json, published next to the app): the roster repo and
// token, encrypted with a shared team password. Anyone with the link and the
// password can join without a setup code. Without the password the file is useless.

const ITERATIONS = 600000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

// Not case-sensitive: phones love to capitalize the first letter.
const normalizePassword = p => String(p).trim().toLowerCase();

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function createAccessFile(cfg, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITERATIONS);
  const plain = enc.encode(JSON.stringify({ o: cfg.owner, r: cfg.repo, p: cfg.path, t: cfg.token }));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  return JSON.stringify({ v: 1, iter: ITERATIONS, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) }, null, 2) + '\n';
}

// { status: 'ok', file } | { status: 'missing' } | { status: 'offline' }
export async function fetchAccessFile() {
  try {
    const res = await fetch('access.json', { cache: 'no-store' });
    if (!res.ok) return { status: 'missing' };
    return { status: 'ok', file: await res.json() };
  } catch {
    return { status: 'offline' };
  }
}

// Returns { owner, repo, path, token }, or null when the password is wrong.
export async function openAccessFile(file, password) {
  try {
    const key = await deriveKey(password, fromB64(file.salt), file.iter);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.ct));
    const j = JSON.parse(dec.decode(plain));
    return { owner: j.o, repo: j.r, path: j.p || 'roster.json', token: j.t };
  } catch {
    return null;
  }
}
