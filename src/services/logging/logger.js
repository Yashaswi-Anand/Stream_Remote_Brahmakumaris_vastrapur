'use strict';

const fs = require('fs');
const path = require('path');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 3;

/**
 * Activity log. Recent entries live in config.json (trimmed to app.logRetention);
 * every entry is also appended to logs/app.log, rotated at 1 MB with 3 generations kept.
 */
class Logger {
  constructor(store, logDir) {
    this.store = store;
    this.logDir = logDir;
    this.file = path.join(logDir, 'app.log');
    this.listeners = new Set();
    fs.mkdirSync(logDir, { recursive: true });
  }

  onEntry(fn) {
    this.listeners.add(fn);
  }

  log(level, source, message) {
    const entry = { ts: new Date().toISOString(), level, source, message: String(message).slice(0, 2000) };
    this.store.update((c) => {
      c.logs.push(entry);
      const keep = c.app.logRetention;
      if (c.logs.length > keep) c.logs.splice(0, c.logs.length - keep);
    });
    this.writeFile(entry);
    for (const fn of this.listeners) fn(entry);
    return entry;
  }

  info(source, message) {
    return this.log('info', source, message);
  }
  success(source, message) {
    return this.log('success', source, message);
  }
  warn(source, message) {
    return this.log('warn', source, message);
  }
  error(source, message) {
    return this.log('error', source, message);
  }

  clear() {
    this.store.update((c) => {
      c.logs = [];
    });
  }

  writeFile(entry) {
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_FILE_BYTES) this.rotate();
      fs.appendFileSync(this.file, `${entry.ts} [${entry.level.toUpperCase()}] [${entry.source}] ${entry.message}\n`, 'utf8');
    } catch {
      // File logging is best-effort; the in-config log still records the entry.
    }
  }

  rotate() {
    for (let i = MAX_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
  }
}

module.exports = { Logger };
