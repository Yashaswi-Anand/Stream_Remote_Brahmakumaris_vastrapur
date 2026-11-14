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

/**
 * Checks a JSON release manifest:
 *   { "version": "1.1.0", "releaseNotes": "…", "downloadUrl": "https://…", "publishedAt": "2026-…" }
 */
async function fetchManifest(url, fetchImpl, timeoutMs = 10000) {
  if (!isHttpsUrl(url)) throw new Error('The release manifest URL must start with https://');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'The update server did not respond in time.' : `Could not reach the update server (${err.message}).`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`The update server returned HTTP ${res.status}.`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('The release manifest is not valid JSON.');
  }
  if (!body || !isVersion(body.version)) throw new Error('The release manifest has no valid "version".');
  return {
    version: body.version.replace(/^v/i, ''),
    releaseNotes: typeof body.releaseNotes === 'string' ? body.releaseNotes.slice(0, 5000) : '',
    downloadUrl: isHttpsUrl(body.downloadUrl) ? body.downloadUrl : '',
    publishedAt: typeof body.publishedAt === 'string' ? body.publishedAt : '',
  };
}

module.exports = { compareVersions, fetchManifest, isHttpsUrl };
