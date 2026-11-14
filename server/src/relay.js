'use strict';

const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { tokenHash } = require('./auth');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const noArgs = () => ({});

/** Commands the website may send to a PC, with an argument check and a label for the activity log. */
const COMMANDS = {
  startStream: { label: 'Start Stream', args: noArgs },
  endStream: { label: 'End Stream', args: noArgs },
  cancel: { label: 'Cancel', args: noArgs },
  confirmLive: { label: "I'm live", args: noArgs },
  openZoom: { label: 'Open Zoom meeting', args: noArgs },
  shareImage: { label: 'Share Image', args: noArgs },
  shareScreen: { label: 'Share Screen', args: noArgs },
  stopShare: { label: 'Stop Share', args: noArgs },
  nextImage: { label: 'Next image', args: noArgs },
  dismissError: { label: 'Dismiss error', args: noArgs },
  selectImage: { label: 'Choose image', args: (a) => (typeof a?.name === 'string' && a.name.length > 0 && a.name.length <= 260 ? { name: a.name } : null) },
  setSchedule: {
    label: 'Save schedule',
    args: (a) => (a && TIME_RE.test(a.time) && typeof a.enabled === 'boolean' ? { time: a.time, enabled: a.enabled } : null),
  },
};

const HEARTBEAT_MS = 25000;
const DEVICE_AUTH_TIMEOUT_MS = 10000;
const COMMAND_TIMEOUT_MS = 30000;
const MAX_BROWSER_BUFFER = 1.5 * 1024 * 1024;

/**
 * Relays between the website (browsers) and paired PCs (the desktop app).
 *   Browser  → /ws         (session cookie; same-origin only)
 *   PC       → /ws/device  (first message: { type: 'auth', token })
 * The server keeps each PC's last state and preview, forwards commands with an audit entry,
 * and asks a PC for screen frames only while someone is watching.
 */
class Relay {
  constructor({ store, resolveSession, isAllowedOrigin }) {
    this.store = store;
    this.resolveSession = resolveSession;
    this.isAllowedOrigin = isAllowedOrigin;
    this.devices = new Map(); // deviceId → { ws, device, state, preview, connectedAt }
    this.browsers = new Set(); // { ws, user, deviceId, watching }
    this.pending = new Map(); // command id → { browser, timer }
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const c of this.wss.clients) c.terminate();
    this.wss.close();
  }

  ping() {
    for (const ws of this.wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  /** Handles an HTTP upgrade for /ws or /ws/device. */
  async handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname === '/ws') {
      // Browsers: the session cookie must be valid and the page must be this site (no cross-site sockets).
      if (!this.isAllowedOrigin(req)) return reject(403, 'Forbidden');
      const session = await this.resolveSession(req).catch(() => null);
      if (!session) return reject(401, 'Unauthorized');
      this.wss.handleUpgrade(req, socket, head, (ws) => this.addBrowser(ws, session.user));
    } else if (url.pathname === '/ws/device') {
      this.wss.handleUpgrade(req, socket, head, (ws) => this.addDevice(ws));
    } else {
      reject(404, 'Not Found');
    }
  }

  // ---- PCs -----------------------------------------------------------------------------------

  addDevice(ws) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    let entry = null;
    const authTimer = setTimeout(() => ws.close(4001, 'Authentication timeout'), DEVICE_AUTH_TIMEOUT_MS);

    ws.on('message', async (data, isBinary) => {
      if (!entry) {
        if (isBinary) return ws.close(4001, 'Not authenticated');
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return ws.close(4002, 'Bad message');
        }
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return ws.close(4001, 'Not authenticated');
        const device = await this.store.findDeviceByToken(tokenHash(msg.token)).catch(() => null);
        clearTimeout(authTimer);
        if (!device) {
          ws.send(JSON.stringify({ type: 'auth-failed', error: 'This PC is not paired (or was removed). Pair it again from the website.' }));
          return ws.close(4003, 'Unknown device');
        }
        const old = this.devices.get(device.id);
        if (old) old.ws.close(4004, 'Connected from another place');
        entry = { ws, device, state: null, preview: null, connectedAt: new Date().toISOString(), version: String(msg.version || '').slice(0, 20) };
        this.devices.set(device.id, entry);
        ws.send(JSON.stringify({ type: 'auth-ok', deviceId: device.id, name: device.name }));
        this.store.updateDevice(device.id, { lastSeenAt: entry.connectedAt }).catch(() => {});
        this.sendWatch(device.id);
        this.broadcastDevices();
        return;
      }
      if (isBinary) return this.forwardFrame(entry.device.id, data);
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onDeviceMessage(entry, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (entry && this.devices.get(entry.device.id) === entry) {
        this.devices.delete(entry.device.id);
        this.store.updateDevice(entry.device.id, { lastSeenAt: new Date().toISOString() }).catch(() => {});
        this.broadcastDevices();
      }
    });
    ws.on('error', () => {});
  }

  onDeviceMessage(entry, msg) {
    const id = entry.device.id;
    if (msg.type === 'state' && msg.state && typeof msg.state === 'object') {
      entry.state = msg.state;
      this.toBrowsers(id, { type: 'state', deviceId: id, state: msg.state });
    } else if (msg.type === 'preview') {
      entry.preview = { name: String(msg.name || ''), dataUrl: /^data:image\/jpeg;base64,/.test(msg.dataUrl) ? msg.dataUrl : '' };
      this.toBrowsers(id, { type: 'preview', deviceId: id, ...entry.preview });
    } else if (msg.type === 'result' && typeof msg.id === 'string') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      this.send(p.browser.ws, { type: 'result', id: msg.id, ok: !!msg.ok, error: String(msg.error || '').slice(0, 500), hint: String(msg.hint || '').slice(0, 500) });
    }
  }

  forwardFrame(deviceId, data) {
    for (const b of this.browsers) {
      if (b.deviceId === deviceId && b.watching && b.ws.readyState === 1 && b.ws.bufferedAmount < MAX_BROWSER_BUFFER) b.ws.send(data, { binary: true });
    }
  }

  /** Tells a PC whether anyone is watching its screen (frames are only captured while someone is). */
  sendWatch(deviceId) {
    const entry = this.devices.get(deviceId);
    if (!entry) return;
    const watchers = [...this.browsers].filter((b) => b.deviceId === deviceId && b.watching).length;
    if (entry.watching === watchers > 0) return;
    entry.watching = watchers > 0;
    this.send(entry.ws, { type: 'watch', on: entry.watching });
  }

  /** Disconnects a PC that was removed on the website. */
  dropDevice(deviceId) {
    const entry = this.devices.get(deviceId);
    if (entry) entry.ws.close(4003, 'Device removed');
  }

  // ---- Browsers ------------------------------------------------------------------------------

  addBrowser(ws, user) {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    const b = { ws, user, deviceId: null, watching: false };
    this.browsers.add(b);
    this.sendDevices(b);

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onBrowserMessage(b, msg).catch(() => {});
    });
    ws.on('close', () => {
      this.browsers.delete(b);
      if (b.deviceId) this.sendWatch(b.deviceId);
    });
    ws.on('error', () => {});
  }

  async onBrowserMessage(b, msg) {
    if (msg.type === 'select') {
      const prev = b.deviceId;
      b.deviceId = typeof msg.deviceId === 'string' ? msg.deviceId : null;
      b.watching = false;
      if (prev) this.sendWatch(prev);
      const entry = this.devices.get(b.deviceId);
      if (entry?.state) this.send(b.ws, { type: 'state', deviceId: b.deviceId, state: entry.state });
      if (entry?.preview) this.send(b.ws, { type: 'preview', deviceId: b.deviceId, ...entry.preview });
    } else if (msg.type === 'watch') {
      b.watching = !!msg.on && !!b.deviceId;
      if (b.deviceId) this.sendWatch(b.deviceId);
    } else if (msg.type === 'command') {
      const id = typeof msg.id === 'string' && msg.id.length <= 64 ? msg.id : crypto.randomUUID();
      const fail = (error) => this.send(b.ws, { type: 'result', id, ok: false, error });
      const def = COMMANDS[msg.action];
      if (!def) return fail('Unknown command.');
      const args = def.args(msg.args || {});
      if (!args) return fail('Invalid values.');
      const entry = this.devices.get(b.deviceId);
      if (!entry) return fail('The PC is offline. Check that it is on, signed in and the app is running.');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail('The PC did not answer in time.');
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { browser: b, timer });
      this.send(entry.ws, { type: 'command', id, action: msg.action, args, by: b.user.email });
      const detail = msg.action === 'setSchedule' ? `${args.time}, ${args.enabled ? 'on' : 'off'}` : msg.action === 'selectImage' ? args.name : '';
      await this.store.addAudit({ actor: b.user.email, action: def.label, detail: `${entry.device.name}${detail ? `: ${detail}` : ''}` });
    }
  }

  /** Closes a signed-out user's sockets. */
  dropUser(userId) {
    for (const b of this.browsers) if (b.user.id === userId) b.ws.close(4005, 'Signed out');
  }

  async devicesList() {
    const devices = await this.store.listDevices();
    return devices.map((d) => {
      const e = this.devices.get(d.id);
      return { id: d.id, name: d.name, online: !!e, version: e?.version || '', lastSeenAt: e ? e.connectedAt : d.lastSeenAt, createdAt: d.createdAt };
    });
  }

  async sendDevices(b) {
    this.send(b.ws, { type: 'devices', devices: await this.devicesList() });
  }

  async broadcastDevices() {
    const msg = { type: 'devices', devices: await this.devicesList() };
    for (const b of this.browsers) this.send(b.ws, msg);
  }

  toBrowsers(deviceId, msg) {
    for (const b of this.browsers) if (b.deviceId === deviceId) this.send(b.ws, msg);
  }

  send(ws, msg) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }
}

module.exports = { Relay, COMMANDS };
