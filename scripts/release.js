'use strict';

/*
 * Publishes the current version's installer as a GitHub release (the website's Download page and the app's
 * Update tab read the latest release). Only the Setup exe is uploaded.
 *
 *   npm run release                 (notes from release-notes/<version>.md, if present)
 *
 * Needs the GitHub CLI (gh) signed in once: gh auth login
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const { version } = require('../package.json');
const repo = 'Yashaswi-Anand/Stream_Remote_Brahmakumaris_vastrapur';
const tag = `v${version}`;
const exe = path.join(root, 'dist', `Zoom-Stream-Automation-Setup-${version}.exe`);
const notesFile = path.join(root, 'release-notes', `${version}.md`);

function gh() {
  const candidates = [process.env.GH_PATH, 'C:\\Program Files\\GitHub CLI\\gh.exe', 'gh'].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' });
      return c;
    } catch {
      // Try the next one.
    }
  }
  throw new Error('GitHub CLI (gh) is not installed. Install it with: winget install --id GitHub.cli');
}

const run = (bin, args, opts = {}) => String(execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) || '').trim();

try {
  if (!fs.existsSync(exe)) throw new Error(`${path.relative(root, exe)} is missing. Build it first (npm run dist).`);
  const bin = gh();
  try {
    run(bin, ['auth', 'status', '--hostname', 'github.com']);
  } catch {
    throw new Error('GitHub CLI is not signed in. Run: gh auth login');
  }
  let exists = false;
  try {
    run(bin, ['release', 'view', tag, '--repo', repo]);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists) throw new Error(`Release ${tag} already exists. Bump the version in package.json for a new release.`);

  const notes = fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Zoom Stream Automation ${version} for the stream PC (Windows 10/11, 64-bit).\n\nInstalls, or upgrades the installed app (settings and pairing are kept). In the app: Update → Download & install.`;
  const tmp = path.join(require('os').tmpdir(), `zsa-notes-${version}.md`);
  fs.writeFileSync(tmp, notes);
  console.log(`Publishing ${tag} with ${path.basename(exe)} (${Math.round(fs.statSync(exe).size / 1048576)} MB)…`);
  run(bin, ['release', 'create', tag, exe, '--repo', repo, '--title', `Zoom Stream Automation ${version}`, '--notes-file', tmp, '--latest', '--target', 'main'], { stdio: ['ignore', 'inherit', 'inherit'] });
  fs.rmSync(tmp, { force: true });
  console.log(`Published: https://github.com/${repo}/releases/tag/${tag}`);
} catch (err) {
  console.error(`Release not published: ${err.message}`);
  process.exit(1);
}
