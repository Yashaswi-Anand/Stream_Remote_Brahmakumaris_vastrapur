'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeConfig } = require('./schema');

/**
 * Local JSON configuration store. Writes are atomic (temp file + rename) and debounced;
 * a corrupted file is moved aside and replaced with defaults.
 */
class ConfigStore {
  constructor(dir, version) {
    this.dir = dir;
    this.version = version;
    this.file = path.join(dir, 'config.json');
    this.data = null;
    this.saveTimer = null;
    this.recoveryNote = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    let raw = null;
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^﻿/, ''));
      } catch (err) {
        const backup = path.join(this.dir, `config.corrupt-${Date.now()}.json`);
        try {
          fs.renameSync(this.file, backup);
        } catch {
          // Leave the file in place; it will be overwritten by defaults.
        }
        this.recoveryNote = `Configuration file was corrupted (${err.message}). Defaults restored; the old file was saved as ${path.basename(backup)}.`;
      }
    }
    this.data = normalizeConfig(raw, this.version);
    this.saveNow();
    return this.data;
  }

  get() {
    return this.data;
  }

  /** Applies a mutation to the in-memory config and schedules a save. */
  update(mutator) {
    mutator(this.data);
    this.data = normalizeConfig(this.data, this.version);
    this.scheduleSave();
    return this.data;
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 250);
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { ConfigStore };
