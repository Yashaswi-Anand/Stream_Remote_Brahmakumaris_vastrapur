'use strict';

const crypto = require('crypto');
const { FirebaseRest, SERVER_TIME } = require('./firebaseRest');

const HEARTBEAT_MS = 30000; // presence "last seen" (the website shows the PC offline after 75 s without one)
const WATCH_CHECK_MS = 10000;
const WATCH_FRESH_MS = 60000; // a phone refreshes its "watching" mark every 20 s
const FRAME_INTERVAL_MS = 2000;
const STATE_DEBOUNCE_MS = 500;
const STREAM_RENEW_MS = 45 * 60000; // ID tokens last an hour; reopen the listeners before that
const COMMAND_MAX_AGE_MS = 2 * 60000; // never run a button press that waited longer than this
const RESULT_KEEP_MS = 60000;
const MAX_BACKOFF_MS = 60000;
const NODES = ['pcs', 'presence', 'state', 'preview', 'frames', 'watch', 'commands', 'results'];

const LOCAL_HOST_RE = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i;
const PAIRING_CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;

/** Turns "stream.example.com" or "http://192.168.1.5:5555/" into a clean base URL. */
function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the website address.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error('That website address is not valid.');
  }
  if (u.username || u.password) throw new Error('That website address is not valid.');
  // Plain http is allowed only on the local network (for testing); the internet needs https.
  if (u.protocol === 'http:' && !LOCAL_HOST_RE.test(u.hostname)) throw new Error('Use an https:// address for a website on the internet.');
  return `${u.protocol}//${u.host}`;
}

const normalizePairingCode = (code) =>
  String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .replace(/^(.{4})(.{4})$/, '$1-$2');

/**
 * Reads the website's public Firebase settings from <site>/config.json. A website that has no Firebase
 * settings yet, opened on this PC or the local network, means the local Firebase emulators (testing).
 */
async function loadSiteConfig(base, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(`${base}/config.json`, { headers: { 'Cache-Control': 'no-cache' } });
  } catch (err) {
    throw new Error(`Could not reach ${base} (${err.cause?.code || err.message}).`);
  }
  if (!res.ok) throw new Error(`${base} is not a Stream Remote website (config.json: ${res.status}).`);
  const json = await res.json().catch(() => null);
  const fb = json && json.firebase;
  if (!fb) throw new Error(`${base} is not a Stream Remote website.`);
  const local = new URL(base);
  const emulated = LOCAL_HOST_RE.test(local.hostname) && local.port === '5555'; // npm run web:local
  if (fb.apiKey && !emulated) {
    if (typeof fb.projectId !== 'string' || !/^https:\/\/[\w.-]+\.(firebaseio\.com|firebasedatabase\.app)\/?$/.test(fb.databaseURL || '')) {
      throw new Error('The website has incomplete Firebase settings (databaseURL / projectId).');
    }
    return { apiKey: fb.apiKey, databaseURL: fb.databaseURL, projectId: fb.projectId };
  }
  const host = new URL(base).hostname;
  if (!LOCAL_HOST_RE.test(host)) throw new Error('This website is not set up yet (it has no Firebase settings).');
  return { apiKey: 'demo-key', projectId: 'demo-stream-remote', databaseURL: '', emulators: { auth: `http://${host}:9099`, database: `http://${host}:9000` } };
}

/**
 * Connects this PC to the Stream Remote website through its Firebase database (outgoing connections only;
 * nothing listens on this PC). Publishes a compact state, runs the website's button presses through the same
 * actions as the app window, and captures the screen only while someone on the website is watching.
 */
class RemoteClient {
  constructor({ store, logger, tokenStore, getState, runCommand, captureFrame, makePreview, fetchImpl, appVersion, defaultName, onChange }) {
    Object.assign(this, { store, logger, tokenStore, getState, runCommand, captureFrame, makePreview, appVersion, defaultName, onChange });
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.gen = 0; // bumps on every stop, so work from an older connection attempt is dropped
    this.timers = [];
    this.streams = [];
    this.retry = 0;
    this.retryTimer = null;
    this.stateTimer = null;
    this.frameTimer = null;
    this.fb = null;
    this.session = null; // { idToken, uid, expiresAt }
    this.offset = 0; // server time − local time
    this.commands = {};
    this.handled = new Set();
    this.queue = Promise.resolve();
    this.watchers = {};
    this.lastStateJson = '';
    this.lastPreviewName = null;
    this.status = { connection: 'off', error: '', watching: false, connectedAt: '' };
  }

  get config() {
    return this.store.get().remote;
  }

  get credentials() {
    try {
      const v = JSON.parse(this.tokenStore.read() || 'null');
      return v && typeof v.refreshToken === 'string' ? v : null;
    } catch {
      return null;
    }
  }

  get paired() {
    return !!(this.config.serverUrl && this.config.deviceId && this.credentials);
  }

  info() {
    const c = this.config;
    return { ...this.status, enabled: c.enabled, paired: this.paired, serverUrl: c.serverUrl, deviceName: c.deviceName };
  }

  setStatus(patch) {
    Object.assign(this.status, patch);
    this.onChange?.();
  }

  start() {
    if (this.config.enabled && this.paired) this.connect();
    else this.setStatus({ connection: this.paired ? 'off' : 'unpaired' });
  }

  /** Stops everything; with `offline`, tells the website this PC is going offline (best effort). */
  stop({ offline = true } = {}) {
    const wasConnected = this.status.connection === 'connected';
    this.gen++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stateTimer);
    this.stateTimer = null;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of this.streams) s.close();
    this.streams = [];
    this.stopFrames({ quiet: true });
    if (offline && wasConnected && this.fb && this.session) {
      this.fb.db('PUT', `presence/${this.config.deviceId}`, { online: false, lastSeen: SERVER_TIME, version: this.appVersion }, this.session.idToken, { silent: true }).catch(() => {});
    }
  }

  /** Exchanges a one-time pairing code from the website for this PC's own Firebase sign-in. */
  async pair(serverUrl, code, name = this.defaultName) {
    const base = normalizeServerUrl(serverUrl);
    const pairingCode = normalizePairingCode(code);
    if (!PAIRING_CODE_RE.test(pairingCode)) throw new Error('Enter the 8-character code shown on the website.');
    const pcName = String(name || 'Stream PC').trim().slice(0, 60) || 'Stream PC';
    const cfg = await loadSiteConfig(base, this.fetch);
    const fb = new FirebaseRest({ config: cfg, fetchImpl: this.fetch });
    let account;
    try {
      account = await fb.signUpAnonymous();
    } catch (err) {
      throw new Error(err.code === 'ADMIN_ONLY_OPERATION' || err.code === 'OPERATION_NOT_ALLOWED' ? 'The website does not allow PCs to sign in yet: turn on "Anonymous" sign-in in the Firebase console.' : err.message);
    }
    const deviceId = crypto.randomUUID();
    try {
      await fb.db('PATCH', '', { [`pcs/${deviceId}`]: { name: pcName, uid: account.uid, pairedAt: SERVER_TIME, code: pairingCode }, [`pairing/${pairingCode}/usedBy`]: deviceId }, account.idToken, { silent: true });
    } catch (err) {
      if (err.code === 'PERMISSION_DENIED') throw new Error('Wrong or expired code. Create a new one on the website (Admin → Add a PC).');
      throw err;
    }
    this.stop();
    this.tokenStore.write(JSON.stringify({ refreshToken: account.refreshToken }));
    this.store.update((c) => {
      c.remote = { enabled: true, serverUrl: base, deviceId, deviceName: pcName };
    });
    this.logger.success('remote', `Paired with ${base} as "${pcName}".`);
    this.retry = 0;
    this.connect();
    return { serverUrl: base, deviceName: pcName };
  }

  async unpair() {
    const { deviceId } = this.config;
    // Remove this PC from the website too (best effort; the owner can also remove it there).
    if (this.fb && deviceId) {
      try {
        await this.ensureToken(this.gen);
        const gone = {};
        for (const n of NODES) gone[`${n}/${deviceId}`] = null;
        await this.fb.db('PATCH', '', gone, this.session.idToken, { silent: true });
      } catch {
        // Offline or already removed.
      }
    }
    this.stop({ offline: false });
    this.tokenStore.clear();
    this.session = null;
    this.fb = null;
    this.store.update((c) => {
      c.remote = { enabled: true, serverUrl: '', deviceId: '', deviceName: '' };
    });
    this.setStatus({ connection: 'unpaired', error: '', watching: false });
    this.logger.info('remote', 'Remote control website unpaired from this PC.');
  }

  setEnabled(enabled) {
    this.store.update((c) => {
      c.remote.enabled = !!enabled;
    });
    if (enabled) {
      this.retry = 0;
      this.start();
    } else {
      this.stop();
      this.setStatus({ connection: 'off', error: '', watching: false });
    }
    this.logger.info('remote', `Remote control ${enabled ? 'turned on' : 'turned off'}.`);
  }

  // ---- Connection --------------------------------------------------------------------------------

  async ensureToken(gen) {
    if (this.session && this.session.expiresAt - 5 * 60000 > Date.now()) return this.session.idToken;
    const creds = this.credentials;
    if (!creds) throw Object.assign(new Error('This PC is not paired.'), { fatal: true });
    let s;
    try {
      s = await this.fb.refresh(creds.refreshToken);
    } catch (err) {
      if (err.status >= 400 && err.status < 500) throw Object.assign(new Error("This PC's sign-in is no longer valid. Pair it again."), { fatal: true });
      throw err;
    }
    if (gen !== this.gen) throw Object.assign(new Error('stopped'), { stale: true });
    if (s.refreshToken && s.refreshToken !== creds.refreshToken) this.tokenStore.write(JSON.stringify({ refreshToken: s.refreshToken }));
    this.session = { idToken: s.idToken, uid: s.uid, expiresAt: Date.now() + s.expiresIn * 1000 };
    return s.idToken;
  }

  async connect() {
    if (!this.config.enabled || !this.paired) return;
    this.stop({ offline: false });
    const gen = this.gen;
    const id = this.config.deviceId;
    this.setStatus({ connection: 'connecting' });
    try {
      if (!this.fb || this.fbBase !== this.config.serverUrl) {
        this.fb = new FirebaseRest({ config: await loadSiteConfig(this.config.serverUrl, this.fetch), fetchImpl: this.fetch });
        this.fbBase = this.config.serverUrl;
      }
      const token = await this.ensureToken(gen);
      // Still paired? (The owner may have removed this PC on the website.)
      let me = null;
      try {
        me = await this.fb.db('GET', `pcs/${id}`, undefined, token);
      } catch (err) {
        if (err.code !== 'PERMISSION_DENIED') throw err;
      }
      if (!me || me.uid !== this.session.uid) throw Object.assign(new Error('This PC was removed on the website. Pair it again.'), { fatal: true });
      if (gen !== this.gen) return;
      await this.heartbeat(gen, true);
      // Old answers are only useful for a minute.
      await this.fb.db('DELETE', `results/${id}`, undefined, token, { silent: true }).catch(() => {});
      if (gen !== this.gen) return;
      this.retry = 0;
      this.lastStateJson = '';
      this.lastPreviewName = null;
      this.setStatus({ connection: 'connected', error: '', connectedAt: new Date().toISOString() });
      this.logger.info('remote', `Connected to the remote control website (${this.config.serverUrl}).`);
      this.openStreams(gen, token);
      this.timers.push(setInterval(() => this.heartbeat(gen).catch((err) => this.lost(gen, err)), HEARTBEAT_MS));
      this.timers.push(setInterval(() => this.checkWatch(), WATCH_CHECK_MS));
      this.timers.push(setInterval(() => this.renewStreams(gen), STREAM_RENEW_MS));
      this.sendState();
    } catch (err) {
      if (err.stale || gen !== this.gen) return;
      if (err.fatal) {
        this.stop({ offline: false });
        this.setStatus({ connection: 'error', error: err.message, watching: false });
        this.logger.warn('remote', err.message);
        return;
      }
      this.setStatus({ connection: 'connecting', error: `${err.message} Retrying…` });
      this.scheduleReconnect();
    }
  }

  /** Something failed while connected: start over (with a fresh check that the PC is still paired). */
  lost(gen, err) {
    if (gen !== this.gen) return;
    const wasConnected = this.status.connection === 'connected';
    this.stop({ offline: false });
    this.setStatus({ connection: 'connecting', error: '' });
    if (wasConnected) this.logger.warn('remote', `Lost the connection to the remote control website${err?.message ? ` (${err.message})` : ''}. Reconnecting…`);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** this.retry++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  async heartbeat(gen, first = false) {
    const token = await this.ensureToken(gen);
    const body = { online: true, lastSeen: SERVER_TIME, version: this.appVersion };
    if (first) {
      // Read back the server's time once, to judge how old commands and "watching" marks are.
      const res = await this.fb.db('PUT', `presence/${this.config.deviceId}`, body, token);
      if (res && typeof res.lastSeen === 'number') this.offset = res.lastSeen - Date.now();
    } else {
      await this.fb.db('PUT', `presence/${this.config.deviceId}`, body, token, { silent: true });
    }
  }

  openStreams(gen, token) {
    const id = this.config.deviceId;
    const onEnd = (reason) => {
      if (gen !== this.gen) return;
      if (reason === 'auth_revoked') return this.renewStreams(gen);
      this.lost(gen, new Error(reason === 'cancel' ? 'access was refused' : reason));
    };
    this.commands = {};
    this.watchers = {};
    this.streams.push(this.fb.stream(`commands/${id}`, token, (type, ev) => this.onCommandsEvent(type, ev), onEnd));
    this.streams.push(this.fb.stream(`watch/${id}`, token, (type, ev) => this.onWatchEvent(type, ev), onEnd));
  }

  async renewStreams(gen) {
    if (gen !== this.gen) return;
    try {
      this.session = null;
      const token = await this.ensureToken(gen);
      if (gen !== this.gen) return;
      for (const s of this.streams) s.close();
      this.streams = [];
      this.openStreams(gen, token);
    } catch (err) {
      if (!err.stale) this.lost(gen, err);
    }
  }

  // ---- Commands from the website -----------------------------------------------------------------

  static applyEvent(map, type, { path, data }) {
    const key = String(path || '/').replace(/^\/+/, '').split('/')[0];
    if (!key) {
      if (type === 'put') return { ...(data || {}) };
      return { ...map, ...(data || {}) };
    }
    const next = { ...map };
    if (data === null && String(path).split('/').filter(Boolean).length === 1) delete next[key];
    else if (String(path).split('/').filter(Boolean).length === 1) next[key] = type === 'patch' ? { ...(map[key] || {}), ...data } : data;
    return next;
  }

  onCommandsEvent(type, ev) {
    this.commands = RemoteClient.applyEvent(this.commands, type, ev);
    for (const done of [...this.handled]) if (!this.commands[done]) this.handled.delete(done);
    for (const [cmdId, cmd] of Object.entries(this.commands)) {
      if (this.handled.has(cmdId) || !cmd || typeof cmd !== 'object') continue;
      this.handled.add(cmdId);
      const gen = this.gen;
      this.queue = this.queue.then(() => this.runOne(gen, cmdId, cmd));
    }
  }

  async runOne(gen, cmdId, cmd) {
    if (gen !== this.gen) return;
    const id = this.config.deviceId;
    let result;
    const age = Date.now() + this.offset - Number(cmd.at || 0);
    if (!cmd.at || age > COMMAND_MAX_AGE_MS) {
      result = { ok: false, error: 'This button press waited too long and was not run. Try again.' };
    } else {
      try {
        const res = await this.runCommand(String(cmd.action), cmd.args && typeof cmd.args === 'object' ? cmd.args : {}, String(cmd.by || 'website'));
        result = res && res.ok === false ? { ok: false, error: res.error || (res.errors || []).join(' ') || 'Not done.', hint: res.hint || '' } : { ok: true };
      } catch (err) {
        result = { ok: false, error: err.message, hint: err.hint || '' };
      }
    }
    this.stateChanged();
    if (gen !== this.gen) return;
    try {
      const token = await this.ensureToken(gen);
      const body = { ok: result.ok, at: SERVER_TIME };
      if (result.error) body.error = String(result.error).slice(0, 500);
      if (result.hint) body.hint = String(result.hint).slice(0, 500);
      await this.fb.db('PUT', `results/${id}/${cmdId}`, body, token, { silent: true });
      await this.fb.db('DELETE', `commands/${id}/${cmdId}`, undefined, token, { silent: true });
      setTimeout(() => {
        if (this.session) this.fb.db('DELETE', `results/${id}/${cmdId}`, undefined, this.session.idToken, { silent: true }).catch(() => {});
      }, RESULT_KEEP_MS);
    } catch (err) {
      if (!err.stale) this.logger.warn('remote', `Could not send the result to the website: ${err.message}`);
    }
  }

  // ---- State -------------------------------------------------------------------------------------

  /** Call whenever the app state may have changed; sends a compact copy shortly after. */
  stateChanged() {
    if (this.status.connection !== 'connected' || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, STATE_DEBOUNCE_MS);
  }

  async sendState() {
    if (this.status.connection !== 'connected') return;
    const gen = this.gen;
    const id = this.config.deviceId;
    const state = this.getState();
    state.remote = { watching: this.status.watching };
    const json = JSON.stringify(state);
    try {
      const token = await this.ensureToken(gen);
      if (json !== this.lastStateJson) {
        this.lastStateJson = json;
        await this.fb.db('PUT', `state/${id}`, state, token, { silent: true });
      }
      const name = state.images?.selectedName || '';
      if (name !== this.lastPreviewName) {
        this.lastPreviewName = name;
        const dataUrl = name ? (await this.makePreview()) || '' : '';
        await this.fb.db('PUT', `preview/${id}`, { name, dataUrl }, token, { silent: true });
      }
    } catch (err) {
      if (err.stale || gen !== this.gen) return;
      this.lastStateJson = '';
      this.lastPreviewName = null;
      this.lost(gen, err);
    }
  }

  // ---- Live screen -------------------------------------------------------------------------------

  onWatchEvent(type, ev) {
    this.watchers = RemoteClient.applyEvent(this.watchers, type, ev);
    this.checkWatch();
  }

  checkWatch() {
    const serverNow = Date.now() + this.offset;
    const watched = Object.values(this.watchers).some((t) => typeof t === 'number' && serverNow - t < WATCH_FRESH_MS);
    if (watched && this.status.connection === 'connected') this.startFrames();
    else this.stopFrames();
  }

  startFrames() {
    if (this.frameTimer) return;
    const gen = this.gen;
    const id = this.config.deviceId;
    this.setStatus({ watching: true });
    this.logger.info('remote', 'Someone on the website is viewing this PC screen.');
    let busy = false;
    const tick = async () => {
      if (busy || gen !== this.gen) return;
      busy = true;
      try {
        const jpeg = await this.captureFrame();
        if (jpeg && gen === this.gen && this.frameTimer) {
          const token = await this.ensureToken(gen);
          await this.fb.db('PUT', `frames/${id}`, { at: SERVER_TIME, jpeg: Buffer.from(jpeg).toString('base64') }, token, { silent: true });
        }
      } catch {
        // Skip this frame.
      } finally {
        busy = false;
      }
    };
    this.frameTimer = setInterval(tick, FRAME_INTERVAL_MS);
    tick();
    this.stateChanged();
  }

  stopFrames({ quiet = false } = {}) {
    if (!this.frameTimer) return;
    clearInterval(this.frameTimer);
    this.frameTimer = null;
    if (this.session && this.fb) this.fb.db('DELETE', `frames/${this.config.deviceId}`, undefined, this.session.idToken, { silent: true }).catch(() => {});
    if (quiet) {
      this.status.watching = false;
      return;
    }
    this.setStatus({ watching: false });
    this.logger.info('remote', 'Screen viewing on the website stopped.');
    this.stateChanged();
  }
}

/** The PC's state as the website needs it (no file paths, settings or secrets). */
function remoteState(full) {
  const wf = full.workflow;
  return {
    app: { version: full.app.version },
    zoom: { status: full.zoom.status, inMeeting: !!full.zoom.inMeeting, sharingDetected: !!full.zoom.sharingDetected },
    workflow: {
      busy: wf.busy,
      action: wf.action,
      message: wf.message,
      error: wf.error,
      waitingForUser: wf.waitingForUser,
      steps: wf.steps.map(({ id, label, status, detail }) => ({ id, label, status, detail })),
      stream: wf.stream,
      share: wf.share,
    },
    images: { count: full.images.count, selectedName: full.images.selectedName, names: (full.images.names || []).slice(0, 500), error: full.images.error },
    schedule: { enabled: full.schedule.enabled, time: full.schedule.time, nextRun: full.schedule.info.nextRun, configured: full.schedule.info.configured },
    meetingId: /^\d{9,12}$/.test(full.settings.meetingLink || '') ? full.settings.meetingLink : '',
    logs: (full.logs || []).slice(-40).map(({ ts, level, message }) => ({ ts, level, message: String(message).slice(0, 300) })),
  };
}

module.exports = { RemoteClient, remoteState, normalizeServerUrl, normalizePairingCode, loadSiteConfig };
