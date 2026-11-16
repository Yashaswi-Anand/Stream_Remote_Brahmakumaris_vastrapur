'use strict';

/** Compares dotted versions ("1.2.10" > "1.2.9"). Pre-release suffixes are ignored. */
function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

const isVersion = (v) => typeof v === 'string' && /^v?\d+\.\d+\.\d+/.test(v);
const isHttpsUrl = (v) => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

/** Where the installers are published (GitHub Releases); the app checks it unless another source is set. */
const RELEASE_REPO = 'Yashaswi-Anand/Stream_Remote_Brahmakumaris_vastrapur';
const DEFAULT_UPDATE_SOURCE = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
const INSTALLER_RE = /^Zoom-Stream-Automation-(Setup|Portable)-(\d+\.\d+\.\d+)\.exe$/;

/** Only installer files of this repository's releases are accepted as download links. */
function isReleaseAsset(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(`/${RELEASE_REPO}/releases/download/`) && INSTALLER_RE.test(decodeURIComponent(u.pathname.split('/').pop()));
  } catch {
    return false;
  }
}

/** Turns a GitHub "latest release" answer into the manifest shape, choosing the Setup or Portable exe. */
function fromGithubRelease(body, portable) {
  if (!isVersion(body.tag_name)) throw new Error('The latest release has no valid version tag (e.g. v2.2.0).');
  const version = body.tag_name.replace(/^v/i, '');
  const assets = (Array.isArray(body.assets) ? body.assets : [])
    .map((a) => ({ a, m: String(a.name || '').match(INSTALLER_RE) }))
    .filter((x) => x.m && x.m[2] === version && isReleaseAsset(x.a.browser_download_url));
  const pick = (kind) => assets.find((x) => x.m[1] === kind);
  const asset = pick(portable ? 'Portable' : 'Setup') || pick(portable ? 'Setup' : 'Portable');
  return {
    version,
    releaseNotes: typeof body.body === 'string' ? body.body.slice(0, 5000) : '',
    downloadUrl: asset ? asset.a.browser_download_url : '',
    downloadSize: asset ? Number(asset.a.size) || 0 : 0,
    publishedAt: typeof body.published_at === 'string' ? body.published_at : '',
  };
}

/**
 * Checks for the latest version. Accepts GitHub's "latest release" API (the default source) or a JSON manifest:
 *   { "version": "1.1.0", "releaseNotes": "…", "downloadUrl": "https://…", "publishedAt": "2026-…" }
 */
async function fetchManifest(url, fetchImpl, timeoutMs = 10000, { portable = false } = {}) {
  if (!isHttpsUrl(url)) throw new Error('The release manifest URL must start with https://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/vnd.github+json, application/json' } });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'The update server did not respond in time.' : `Could not reach the update server (${err.message}).`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 && /^https:\/\/api\.github\.com\//.test(url)) throw new Error('No release has been published yet.');
  if (!res.ok) throw new Error(`The update server returned HTTP ${res.status}.`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('The release manifest is not valid JSON.');
  }
  if (body && typeof body.tag_name === 'string') return fromGithubRelease(body, portable);
  if (!body || !isVersion(body.version)) throw new Error('The release manifest has no valid "version".');
  return {
    version: body.version.replace(/^v/i, ''),
    releaseNotes: typeof body.releaseNotes === 'string' ? body.releaseNotes.slice(0, 5000) : '',
    downloadUrl: isHttpsUrl(body.downloadUrl) ? body.downloadUrl : '',
    publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : '',
  };
}

module.exports = { compareVersions, fetchManifest, isHttpsUrl, isReleaseAsset, fromGithubRelease, DEFAULT_UPDATE_SOURCE, RELEASE_REPO, INSTALLER_RE };
