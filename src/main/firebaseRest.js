'use strict';

/**
 * Minimal Firebase client over the public REST APIs (Authentication + Realtime Database), used by the
 * desktop app to talk to the Stream Automation website's database. No Firebase SDK is needed in Electron.
 *
 * config: { apiKey, databaseURL, projectId, emulators?: { auth, database } }
 * With `emulators`, requests go to the local Firebase Emulator Suite instead (for testing on this PC).
 */
class FirebaseError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class FirebaseRest {
  constructor({ config, fetchImpl }) {
    this.config = config;
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    const emu = config.emulators || null;
    this.authBase = emu ? `${emu.auth}/identitytoolkit.googleapis.com/v1` : 'https://identitytoolkit.googleapis.com/v1';
    this.tokenBase = emu ? `${emu.auth}/securetoken.googleapis.com/v1` : 'https://securetoken.googleapis.com/v1';
    this.dbBase = emu ? emu.database : config.databaseURL.replace(/\/+$/, '');
    this.ns = emu ? `${config.projectId}-default-rtdb` : '';
  }

  async authCall(url, body, form = false) {
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
      });
    } catch (err) {
      throw new FirebaseError(`Cannot reach Firebase (${err.cause?.code || err.message}).`, 0, 'NETWORK');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = data.error?.message || `HTTP_${res.status}`;
      throw new FirebaseError(code, res.status, code);
    }
    return data;
  }

  /** A new anonymous Firebase account (one per paired PC). */
  async signUpAnonymous() {
    const d = await this.authCall(`${this.authBase}/accounts:signUp?key=${encodeURIComponent(this.config.apiKey)}`, { returnSecureToken: true });
    return { idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, expiresIn: Number(d.expiresIn) || 3600 };
  }

  async signUpWithPassword(email, password) {
    const d = await this.authCall(`${this.authBase}/accounts:signUp?key=${encodeURIComponent(this.config.apiKey)}`, { email, password, returnSecureToken: true });
    return { idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, expiresIn: Number(d.expiresIn) || 3600 };
  }

  async signInWithPassword(email, password) {
    const d = await this.authCall(`${this.authBase}/accounts:signInWithPassword?key=${encodeURIComponent(this.config.apiKey)}`, { email, password, returnSecureToken: true });
    return { idToken: d.idToken, refreshToken: d.refreshToken, uid: d.localId, expiresIn: Number(d.expiresIn) || 3600 };
  }

  /** Exchanges the stored refresh token for a fresh ID token (valid about an hour). */
  async refresh(refreshToken) {
    const d = await this.authCall(`${this.tokenBase}/token?key=${encodeURIComponent(this.config.apiKey)}`, { grant_type: 'refresh_token', refresh_token: refreshToken }, true);
    return { idToken: d.id_token, refreshToken: d.refresh_token, uid: d.user_id, expiresIn: Number(d.expires_in) || 3600 };
  }

  dbUrl(path, params = {}) {
    const q = new URLSearchParams(params);
    if (this.ns) q.set('ns', this.ns);
    const clean = String(path).replace(/^\/+|\/+$/g, '');
    const qs = q.toString();
    return `${this.dbBase}/${clean}.json${qs ? `?${qs}` : ''}`;
  }

  /** GET/PUT/PATCH/DELETE on the Realtime Database. `token` is an ID token, or { admin: true } on the emulator. */
  async db(method, path, body, token, { silent = false } = {}) {
    const params = {};
    const headers = { 'Content-Type': 'application/json' };
    if (token && token.admin) headers.Authorization = 'Bearer owner';
    else if (token) params.auth = token;
    if (silent) params.print = 'silent';
    let res;
    try {
      res = await this.fetch(this.dbUrl(path, params), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new FirebaseError(`Cannot reach Firebase (${err.cause?.code || err.message}).`, 0, 'NETWORK');
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      throw new FirebaseError(msg, res.status, /permission/i.test(msg) ? 'PERMISSION_DENIED' : res.status === 401 ? 'UNAUTHORIZED' : 'DB_ERROR');
    }
    return data;
  }

  /**
   * Listens to a database location (Server-Sent Events). onEvent(type, { path, data }) gets 'put' and 'patch';
   * onEnd(reason) runs once when the stream ends ('cancel' = no permission, 'auth_revoked' = token expired,
   * 'closed', or an error message).
   */
  stream(path, token, onEvent, onEnd) {
    const ac = new AbortController();
    let ended = false;
    const end = (reason) => {
      if (ended) return;
      ended = true;
      ac.abort();
      onEnd?.(reason);
    };
    (async () => {
      let res;
      try {
        res = await this.fetch(this.dbUrl(path, { auth: token }), { headers: { Accept: 'text/event-stream' }, signal: ac.signal });
      } catch (err) {
        return end(ended ? 'closed' : err.message);
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return end(/permission/i.test(text) || res.status === 401 ? 'cancel' : `HTTP ${res.status}`);
      }
      // Follow redirects to the database server that holds this data (fetch does this itself).
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let type = '';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) type = line.slice(6).trim();
              else if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (type === 'put' || type === 'patch') {
              let payload = null;
              try {
                payload = JSON.parse(data);
              } catch {
                continue;
              }
              onEvent(type, payload);
            } else if (type === 'cancel' || type === 'auth_revoked') {
              return end(type);
            }
          }
        }
        end('closed');
      } catch (err) {
        end(ended ? 'closed' : err.message);
      }
    })();
    return { close: () => end('closed') };
  }
}

const SERVER_TIME = { '.sv': 'timestamp' };

module.exports = { FirebaseRest, FirebaseError, SERVER_TIME };
