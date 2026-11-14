'use strict';

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 10;

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) =>
    crypto.scrypt(password, salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

/** Returns "scrypt$N$r$p$salt$hash" (base64url). Only this hash is stored, never the password. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const key = await scrypt(String(password), Buffer.from(salt, 'base64url'), { N: Number(N), r: Number(r), p: Number(p), keylen: expected.length });
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return 'Password is too long.';
  return '';
}

/** Random token for sessions, invites and devices. Only its SHA-256 is stored on the server. */
const newToken = () => crypto.randomBytes(32).toString('base64url');
const tokenHash = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** Short pairing code shown on the website and typed into the desktop app, e.g. "K7Q2-9MXA". */
function newPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const normalizePairingCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

/** Counts failures per key and blocks the key for `blockMs` after `max` failures within `windowMs`. */
class RateLimiter {
  constructor({ max = 5, windowMs = 15 * 60000, blockMs = 15 * 60000 } = {}) {
    Object.assign(this, { max, windowMs, blockMs });
    this.entries = new Map();
  }

  blockedFor(key, now = Date.now()) {
    const e = this.entries.get(key);
    if (!e) return 0;
    if (e.blockedUntil > now) return e.blockedUntil - now;
    if (now - e.first > this.windowMs) this.entries.delete(key);
    return 0;
  }

  fail(key, now = Date.now()) {
    let e = this.entries.get(key);
    if (!e || now - e.first > this.windowMs) e = { first: now, count: 0, blockedUntil: 0 };
    e.count += 1;
    if (e.count >= this.max) e.blockedUntil = now + this.blockMs;
    this.entries.set(key, e);
  }

  reset(key) {
    this.entries.delete(key);
  }
}

module.exports = { hashPassword, verifyPassword, passwordProblem, newToken, tokenHash, newPairingCode, normalizePairingCode, RateLimiter, MIN_PASSWORD };
