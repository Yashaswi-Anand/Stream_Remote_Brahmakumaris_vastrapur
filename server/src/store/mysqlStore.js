'use strict';

const crypto = require('crypto');

const AUDIT_KEEP = 2000;

const TABLES = [
  `CREATE TABLE IF NOT EXISTS zsr_users (
    id CHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, role VARCHAR(16) NOT NULL,
    password_hash VARCHAR(255) NOT NULL, created_at VARCHAR(32) NOT NULL
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS zsr_invites (
    id CHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL, role VARCHAR(16) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at VARCHAR(32) NOT NULL, created_by VARCHAR(254) NOT NULL, created_at VARCHAR(32) NOT NULL
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS zsr_sessions (
    token_hash CHAR(64) PRIMARY KEY, user_id CHAR(36) NOT NULL, expires_at VARCHAR(32) NOT NULL, created_at VARCHAR(32) NOT NULL,
    INDEX (user_id)
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS zsr_devices (
    id CHAR(36) PRIMARY KEY, name VARCHAR(100) NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE, created_by VARCHAR(254) NOT NULL,
    created_at VARCHAR(32) NOT NULL, last_seen_at VARCHAR(32) NOT NULL DEFAULT ''
  ) CHARACTER SET utf8mb4`,
  `CREATE TABLE IF NOT EXISTS zsr_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, at VARCHAR(32) NOT NULL, actor VARCHAR(254) NOT NULL, action VARCHAR(64) NOT NULL,
    detail VARCHAR(500) NOT NULL DEFAULT ''
  ) CHARACTER SET utf8mb4`,
];

const user = (r) => r && { id: r.id, email: r.email, role: r.role, passwordHash: r.password_hash, createdAt: r.created_at };
const invite = (r) => r && { id: r.id, email: r.email, role: r.role, tokenHash: r.token_hash, expiresAt: r.expires_at, createdBy: r.created_by, createdAt: r.created_at };
const session = (r) => r && { tokenHash: r.token_hash, userId: r.user_id, expiresAt: r.expires_at, createdAt: r.created_at };
const device = (r) => r && { id: r.id, name: r.name, tokenHash: r.token_hash, createdBy: r.created_by, createdAt: r.created_at, lastSeenAt: r.last_seen_at };
const without = (obj, key) => {
  const { [key]: _drop, ...rest } = obj;
  return rest;
};

/** Live-server store on the host's MySQL database. Same methods as FileStore. Tables are created on start. */
class MysqlStore {
  constructor(db) {
    this.db = db;
    this.pool = null;
  }

  async init() {
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({ ...this.db, connectionLimit: 5, waitForConnections: true });
    for (const sql of TABLES) await this.pool.query(sql);
  }

  async q(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async close() {
    await this.pool?.end();
  }

  async countUsers() {
    return (await this.q('SELECT COUNT(*) AS n FROM zsr_users'))[0].n;
  }
  async findUserByEmail(email) {
    return user((await this.q('SELECT * FROM zsr_users WHERE email = ?', [String(email).toLowerCase()]))[0]) || null;
  }
  async findUserById(id) {
    return user((await this.q('SELECT * FROM zsr_users WHERE id = ?', [id]))[0]) || null;
  }
  async listUsers() {
    return (await this.q('SELECT * FROM zsr_users ORDER BY created_at')).map((r) => without(user(r), 'passwordHash'));
  }
  async createUser({ email, role, passwordHash }) {
    const u = { id: crypto.randomUUID(), email: email.toLowerCase(), role, passwordHash, createdAt: new Date().toISOString() };
    await this.q('INSERT INTO zsr_users (id, email, role, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', [u.id, u.email, u.role, u.passwordHash, u.createdAt]);
    return u;
  }
  async updateUser(id, patch) {
    if (patch.passwordHash) await this.q('UPDATE zsr_users SET password_hash = ? WHERE id = ?', [patch.passwordHash, id]);
    if (patch.role) await this.q('UPDATE zsr_users SET role = ? WHERE id = ?', [patch.role, id]);
  }
  async deleteUser(id) {
    await this.q('DELETE FROM zsr_sessions WHERE user_id = ?', [id]);
    await this.q('DELETE FROM zsr_users WHERE id = ?', [id]);
  }

  async createInvite({ email, role, tokenHash, expiresAt, createdBy }) {
    const i = { id: crypto.randomUUID(), email: email.toLowerCase(), role, tokenHash, expiresAt, createdBy, createdAt: new Date().toISOString() };
    await this.q('DELETE FROM zsr_invites WHERE email = ?', [i.email]);
    await this.q('INSERT INTO zsr_invites (id, email, role, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [i.id, i.email, i.role, i.tokenHash, i.expiresAt, i.createdBy, i.createdAt]);
    return i;
  }
  async findInvite(tokenHash) {
    return invite((await this.q('SELECT * FROM zsr_invites WHERE token_hash = ?', [tokenHash]))[0]) || null;
  }
  async listInvites() {
    return (await this.q('SELECT * FROM zsr_invites ORDER BY created_at')).map((r) => without(invite(r), 'tokenHash'));
  }
  async deleteInvite(id) {
    await this.q('DELETE FROM zsr_invites WHERE id = ?', [id]);
  }

  async createSession({ tokenHash, userId, expiresAt }) {
    await this.q('INSERT INTO zsr_sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)', [tokenHash, userId, expiresAt, new Date().toISOString()]);
  }
  async findSession(tokenHash) {
    return session((await this.q('SELECT * FROM zsr_sessions WHERE token_hash = ?', [tokenHash]))[0]) || null;
  }
  async touchSession(tokenHash, expiresAt) {
    await this.q('UPDATE zsr_sessions SET expires_at = ? WHERE token_hash = ?', [expiresAt, tokenHash]);
  }
  async deleteSession(tokenHash) {
    await this.q('DELETE FROM zsr_sessions WHERE token_hash = ?', [tokenHash]);
  }
  async deleteExpired(now = new Date().toISOString()) {
    await this.q('DELETE FROM zsr_sessions WHERE expires_at <= ?', [now]);
    await this.q('DELETE FROM zsr_invites WHERE expires_at <= ?', [now]);
  }

  async createDevice({ name, tokenHash, createdBy }) {
    const d = { id: crypto.randomUUID(), name, tokenHash, createdBy, createdAt: new Date().toISOString(), lastSeenAt: '' };
    await this.q('INSERT INTO zsr_devices (id, name, token_hash, created_by, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)', [d.id, d.name, d.tokenHash, d.createdBy, d.createdAt, '']);
    return d;
  }
  async findDeviceByToken(tokenHash) {
    return device((await this.q('SELECT * FROM zsr_devices WHERE token_hash = ?', [tokenHash]))[0]) || null;
  }
  async listDevices() {
    return (await this.q('SELECT * FROM zsr_devices ORDER BY created_at')).map((r) => without(device(r), 'tokenHash'));
  }
  async updateDevice(id, patch) {
    if (patch.lastSeenAt !== undefined) await this.q('UPDATE zsr_devices SET last_seen_at = ? WHERE id = ?', [patch.lastSeenAt, id]);
    if (patch.name !== undefined) await this.q('UPDATE zsr_devices SET name = ? WHERE id = ?', [patch.name, id]);
  }
  async deleteDevice(id) {
    await this.q('DELETE FROM zsr_devices WHERE id = ?', [id]);
  }

  async addAudit({ actor, action, detail = '' }) {
    await this.q('INSERT INTO zsr_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)', [new Date().toISOString(), actor, action, String(detail).slice(0, 500)]);
    // Keep the table small: trim now and then.
    if (Math.random() < 0.02) {
      const rows = await this.q('SELECT id FROM zsr_audit ORDER BY id DESC LIMIT 1 OFFSET ' + AUDIT_KEEP);
      if (rows[0]) await this.q('DELETE FROM zsr_audit WHERE id <= ?', [rows[0].id]);
    }
  }
  async listAudit(limit = 100) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    return (await this.q(`SELECT at, actor, action, detail FROM zsr_audit ORDER BY id DESC LIMIT ${n}`)).map((r) => ({ ...r }));
  }
}

function createStore(config) {
  if (config.db) return new MysqlStore(config.db);
  const { FileStore } = require('./fileStore');
  return new FileStore(config.dataDir);
}

module.exports = { MysqlStore, createStore };
