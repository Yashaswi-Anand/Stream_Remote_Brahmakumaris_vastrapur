'use strict';

const fs = require('fs');
const path = require('path');

/** Reads KEY=VALUE lines from server/.env (local development only; on the host, set environment variables instead). */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function loadConfig(overrides = {}) {
  loadDotEnv(path.join(__dirname, '..', '.env'));
  const env = { ...process.env, ...overrides };
  const flag = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
  return {
    port: Number(env.PORT) || 8787,
    host: env.HOST || '0.0.0.0',
    // Public address of the website, used in invite links (e.g. https://stream.example.com).
    publicUrl: (env.PUBLIC_URL || '').replace(/\/+$/, ''),
    dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
    // MySQL when DB_HOST is set (the live server); a local file otherwise (development on this PC).
    db: env.DB_HOST
      ? { host: env.DB_HOST, port: Number(env.DB_PORT) || 3306, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME }
      : null,
    // Code needed to create the first (owner) account. Random and printed to the console when not set.
    setupCode: env.SETUP_CODE || '',
    // Redirect plain http to https and mark cookies Secure. Turn on for the live server.
    requireHttps: flag(env.REQUIRE_HTTPS, false),
    // Trust X-Forwarded-Proto / X-Forwarded-For from the host's proxy.
    trustProxy: flag(env.TRUST_PROXY, true),
    sessionDays: Number(env.SESSION_DAYS) || 30,
    // Folder holding the desktop app installers offered on the Download page (Zoom-Stream-Automation-Setup-X.Y.Z.exe, …-Portable-…).
    downloadsDir: path.resolve(path.join(__dirname, '..'), env.DOWNLOADS_DIR || 'downloads'),
  };
}

module.exports = { loadConfig };
