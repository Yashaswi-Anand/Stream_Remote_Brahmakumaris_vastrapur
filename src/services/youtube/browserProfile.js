'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/*
 * Opens YouTube Studio in the browser profile that is already signed in to the stream's Google account,
 * so no sign-in or 2-step verification is needed. Chrome (and Edge) send links from other apps (Zoom's
 * "Live on YouTube") to the profile used last, so opening this profile first also makes Zoom's YouTube
 * page open there. Only the browser's profile list (Local State) is read: never cookies or passwords.
 */

const STUDIO_URL_RE = /^https:\/\/studio\.youtube\.com\/channel\/UC[\w-]{20,24}\/livestreaming\/?$/;

function browsers(env = process.env) {
  const local = env.LOCALAPPDATA || '';
  const pf = env.ProgramFiles || 'C:\\Program Files';
  const pf86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    {
      name: 'Chrome',
      userData: path.join(local, 'Google', 'Chrome', 'User Data'),
      exes: [path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    },
    {
      name: 'Edge',
      userData: path.join(local, 'Microsoft', 'Edge', 'User Data'),
      exes: [path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    },
  ];
}

/** The browser profile signed in as `email` (Chrome first, then Edge), or null. */
function findProfile(email, { env = process.env, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') } = {}) {
  const want = String(email || '').trim().toLowerCase();
  if (!want) return null;
  for (const b of browsers(env)) {
    const exe = b.exes.find((e) => exists(e));
    const stateFile = path.join(b.userData, 'Local State');
    if (!exe || !exists(stateFile)) continue;
    let cache = {};
    try {
      cache = JSON.parse(read(stateFile)).profile?.info_cache || {};
    } catch {
      continue;
    }
    for (const [dir, info] of Object.entries(cache)) {
      if (String(info?.user_name || '').trim().toLowerCase() === want) {
        return { browser: b.name, exe, profileDir: dir, profileName: String(info.name || dir) };
      }
    }
  }
  return null;
}

/** Opens `url` in that profile (a new window, which becomes the browser's last-used profile). */
function openInProfile(profile, url) {
  if (!STUDIO_URL_RE.test(url)) throw new Error('The YouTube Studio link is not valid.');
  const child = spawn(profile.exe, [`--profile-directory=${profile.profileDir}`, '--new-window', url], { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', () => {});
  child.unref();
}

module.exports = { findProfile, openInProfile, STUDIO_URL_RE };
