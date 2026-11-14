'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUDIT_KEEP = 2000;
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));

/**
 * Development store: one JSON file in server/data (never committed). Holds only hashes of
 * passwords and tokens. The live server uses MySQL instead (see mysqlStore.js); both have the same methods.
 */
class FileStore {
  constructor(dir) {
    this.file = path.join(dir, 'db.json');
    this.data = { users: [], invites: [], sessions: [], devices: [], audit: [] };
    this.timer = null;
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (fs.existsSync(this.file)) {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const k of Object.keys(this.data)) if (Array.isArray(raw[k])) this.data[k] = raw[k];
    }
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    clearTimeout(this.timer);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  async close() {
    this.flush();
  }

  // ---- Users ---------------------------------------------------------------------------------
  async countUsers() {
    return this.data.users.length;
  }
  async findUserByEmail(email) {
    return clone(this.data.users.find((u) => u.email === String(email).toLowerCase()));
  }
  async findUserById(id) {
    return clone(this.data.users.find((u) => u.id === id));
  }
  async listUsers() {
    return this.data.users.map(({ passwordHash, ...u }) => clone(u));
  }
  async createUser({ email, role, passwordHash }) {
    const user = { id: crypto.randomUUID(), email: email.toLowerCase(), role, passwordHash, createdAt: new Date().toISOString() };
    this.data.users.push(user);
    this.save();
    return clone(user);
  }
  async updateUser(id, patch) {
    const u = this.data.users.find((x) => x.id === id);
    if (u) Object.assign(u, patch);
    this.save();
  }
  async deleteUser(id) {
    this.data.users = this.data.users.filter((u) => u.id !== id);
    this.data.sessions = this.data.sessions.filter((s) => s.userId !== id);
    this.save();
  }

  // ---- Invites -------------------------------------------------------------------------------
  async createInvite({ email, role, tokenHash, expiresAt, createdBy }) {
    this.data.invites = this.data.invites.filter((i) => i.email !== email.toLowerCase());
    const invite = { id: crypto.randomUUID(), email: email.toLowerCase(), role, tokenHash, expiresAt, createdBy, createdAt: new Date().toISOString() };
    this.data.invites.push(invite);
    this.save();
    return clone(invite);
  }
  async findInvite(tokenHash) {
    return clone(this.data.invites.find((i) => i.tokenHash === tokenHash));
  }
  async listInvites() {
    return this.data.invites.map(({ tokenHash, ...i }) => clone(i));
  }
  async deleteInvite(id) {
    this.data.invites = this.data.invites.filter((i) => i.id !== id);
    this.save();
  }

  // ---- Sessions ------------------------------------------------------------------------------
  async createSession({ tokenHash, userId, expiresAt }) {
    this.data.sessions.push({ tokenHash, userId, expiresAt, createdAt: new Date().toISOString() });
    this.save();
  }
  async findSession(tokenHash) {
    return clone(this.data.sessions.find((s) => s.tokenHash === tokenHash));
  }
  async touchSession(tokenHash, expiresAt) {
    const s = this.data.sessions.find((x) => x.tokenHash === tokenHash);
    if (s) s.expiresAt = expiresAt;
    this.save();
  }
  async deleteSession(tokenHash) {
    this.data.sessions = this.data.sessions.filter((s) => s.tokenHash !== tokenHash);
    this.save();
  }
  async deleteExpired(now = new Date().toISOString()) {
    this.data.sessions = this.data.sessions.filter((s) => s.expiresAt > now);
    this.data.invites = this.data.invites.filter((i) => i.expiresAt > now);
    this.save();
  }

  // ---- Devices (paired PCs) ------------------------------------------------------------------
  async createDevice({ name, tokenHash, createdBy }) {
    const device = { id: crypto.randomUUID(), name, tokenHash, createdBy, createdAt: new Date().toISOString(), lastSeenAt: '' };
    this.data.devices.push(device);
    this.save();
    return clone(device);
  }
  async findDeviceByToken(tokenHash) {
    return clone(this.data.devices.find((d) => d.tokenHash === tokenHash));
  }
  async listDevices() {
    return this.data.devices.map(({ tokenHash, ...d }) => clone(d));
  }
  async updateDevice(id, patch) {
    const d = this.data.devices.find((x) => x.id === id);
    if (d) Object.assign(d, patch);
    this.save();
  }
  async deleteDevice(id) {
    this.data.devices = this.data.devices.filter((d) => d.id !== id);
    this.save();
  }

  // ---- Activity log --------------------------------------------------------------------------
  async addAudit({ actor, action, detail = '' }) {
    this.data.audit.push({ at: new Date().toISOString(), actor, action, detail: String(detail).slice(0, 500) });
    if (this.data.audit.length > AUDIT_KEEP) this.data.audit = this.data.audit.slice(-AUDIT_KEEP);
    this.save();
  }
  async listAudit(limit = 100) {
    return clone(this.data.audit.slice(-limit).reverse());
  }
}

module.exports = { FileStore };
