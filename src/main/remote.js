'use strict';

const FRAME_INTERVAL_MS = 1500;
const STATE_DEBOUNCE_MS = 400;
const MAX_BACKOFF_MS = 60000;

/** Turns "stream.example.com" or "http://192.168.1.5:8787/" into a clean base URL. */
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
  const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)$/i.test(u.hostname);
  if (u.protocol === 'http:' && !local) throw new Error('Use an https:// address for a website on the internet.');
  return `${u.protocol}//${u.host}`;
}

/**
 * Connects this PC to the remote-control website (outgoing connection only; nothing listens on this PC).
 * Sends a compact state, answers commands through the same actions as the app window, and captures the
 * screen only while someone on the website is watching.
 */
class RemoteClient {
  constructor({ store, logger, tokenStore, getState, runCommand, captureFrame, makePreview, fetchImpl, WebSocketImpl, appVersion, defaultName, onChange }) {
    Object.assign(this, { store, logger, tokenStore, getState, runCommand, captureFrame, makePreview, appVersion, defaultName, onChange });
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.WebSocket = WebSocketImpl || globalThis.WebSocket;
    this.ws = null;
    this.retry = 0;
    this.retryTimer = null;
    this.stateTimer = null;
    this.frameTimer = null;
    this.lastStateJson = '';
    this.lastPreviewName = null;
    this.status = { connection: 'off', error: '', watching: false, connectedAt: '' };
  }

  get config() {
    return this.store.get().remote;
  }

  get paired() {
    return !!(this.config.serverUrl && this.config.deviceId && this.tokenStore.read());
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

  stop() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.stateTimer);
    this.stopFrames();
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close();
  }

  /** Exchanges a one-time pairing code from the website for this PC's own token. */
  async pair(serverUrl, code, name = this.defaultName) {
    const base = normalizeServerUrl(serverUrl);
    let res;
    try {
      res = await this.fetch(`${base}/api/device/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name }),
      });
    } catch (err) {
      throw new Error(`Could not reach ${base} (${err.cause?.code || err.message}).`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Pairing failed (${res.status}).`);
    if (typeof body.token !== 'string' || typeof body.deviceId !== 'string') throw new Error('The website sent an unexpected answer.');
    this.stop();
    this.tokenStore.write(body.token);
    this.store.update((c) => {
      c.remote = { enabled: true, serverUrl: base, deviceId: body.deviceId, deviceName: body.name || name };
    });
    this.logger.success('remote', `Paired with ${base} as "${body.name || name}".`);
    this.retry = 0;
    this.connect();
    return { serverUrl: base, deviceName: body.name || name };
  }

  unpair() {
    this.stop();
    this.tokenStore.clear();
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

  connect() {
    if (this.ws || !this.config.enabled || !this.paired) return;
    clearTimeout(this.retryTimer);
    const url = `${this.config.serverUrl.replace(/^http/i, 'ws')}/ws/device`;
    this.setStatus({ connection: 'connecting' });
    let ws;
    try {
      ws = new this.WebSocket(url);
    } catch (err) {
      this.setStatus({ connection: 'error', error: err.message });
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    let authFailed = false;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.tokenStore.read(), version: this.appVersion }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === 'auth-ok') {
        this.retry = 0;
        this.lastStateJson = '';
        this.lastPreviewName = null;
        this.setStatus({ connection: 'connected', error: '', connectedAt: new Date().toISOString() });
        this.logger.info('remote', `Connected to the remote control website (${this.config.serverUrl}).`);
        this.sendState();
      } else if (msg.type === 'auth-failed') {
        authFailed = true;
        this.setStatus({ connection: 'error', error: msg.error || 'The website did not accept this PC.' });
        this.logger.warn('remote', msg.error || 'The website did not accept this PC.');
      } else if (msg.type === 'command') {
        this.onCommand(msg);
      } else if (msg.type === 'watch') {
        if (msg.on) this.startFrames();
        else this.stopFrames();
      }
    };
    ws.onerror = () => {};
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopFrames();
      const wasConnected = this.status.connection === 'connected';
      if (e.code === 4003) authFailed = true;
      if (authFailed) {
        // Removed on the website: stay off until paired again.
        this.setStatus({ connection: 'error', error: this.status.error || 'This PC was removed on the website. Pair it again.' });
        return;
      }
      this.setStatus({ connection: 'connecting', error: wasConnected ? '' : this.status.error || 'Cannot reach the website. Retrying…' });
      if (wasConnected) this.logger.warn('remote', 'Lost the connection to the remote control website. Reconnecting…');
      this.scheduleReconnect();
    };
  }

  scheduleReconnect() {
    clearTimeout(this.retryTimer);
    const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** this.retry++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  send(msg) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  async onCommand(msg) {
    const reply = (ok, error = '', hint = '') => this.send({ type: 'result', id: msg.id, ok, error, hint });
    try {
      const res = await this.runCommand(msg.action, msg.args || {}, msg.by || 'website');
      if (res && res.ok === false) reply(false, res.error || (res.errors || []).join(' ') || 'Not done.', res.hint || '');
      else reply(true);
    } catch (err) {
      reply(false, err.message, err.hint || '');
    }
    this.stateChanged();
  }

  /** Call whenever the app state may have changed; sends a compact copy shortly after. */
  stateChanged() {
    if (!this.ws || this.status.connection !== 'connected' || this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.sendState();
    }, STATE_DEBOUNCE_MS);
  }

  sendState() {
    if (this.status.connection !== 'connected') return;
    const state = this.getState();
    state.remote = { watching: this.status.watching };
    const json = JSON.stringify({ type: 'state', state });
    if (json !== this.lastStateJson) {
      this.lastStateJson = json;
      this.send(json);
    }
    const name = state.images?.selectedName || '';
    if (name !== this.lastPreviewName) {
      this.lastPreviewName = name;
      Promise.resolve(name ? this.makePreview() : '')
        .then((dataUrl) => this.send({ type: 'preview', name, dataUrl: dataUrl || '' }))
        .catch(() => {});
    }
  }

  startFrames() {
    if (this.frameTimer) return;
    this.setStatus({ watching: true });
    this.logger.info('remote', 'Someone on the website is viewing this PC screen.');
    let busy = false;
    const tick = async () => {
      if (busy || !this.ws) return;
      busy = true;
      try {
        const jpeg = await this.captureFrame();
        if (jpeg && this.ws && this.ws.readyState === 1 && (this.ws.bufferedAmount || 0) < 2 * 1024 * 1024) this.ws.send(jpeg);
      } catch {
        // Skip this frame.
      } finally {
        busy = false;
      }
    };
    tick();
    this.frameTimer = setInterval(tick, FRAME_INTERVAL_MS);
    this.stateChanged();
  }

  stopFrames() {
    if (!this.frameTimer) return;
    clearInterval(this.frameTimer);
    this.frameTimer = null;
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

module.exports = { RemoteClient, remoteState, normalizeServerUrl };
