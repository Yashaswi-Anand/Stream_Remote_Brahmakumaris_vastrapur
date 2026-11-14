'use strict';

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');

/**
 * Client for the long-running PowerShell UI Automation helper (resources/zoom-uia.ps1).
 * The script is loaded as a script block so it runs regardless of the machine's execution policy setting.
 */
class UiaClient {
  constructor(scriptPath, logger) {
    this.scriptPath = scriptPath;
    this.logger = logger;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.queue = Promise.resolve();
  }

  start() {
    if (this.proc) return;
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`Automation helper is missing: ${this.scriptPath}`);
    }
    const escaped = this.scriptPath.replace(/'/g, "''");
    const bootstrap = `$ProgressPreference = 'SilentlyContinue'; . ([scriptblock]::Create([IO.File]::ReadAllText('${escaped}')))`;
    // Passed with -Command, not -EncodedCommand: on current Windows builds, creating a script block inside an
    // -EncodedCommand session with redirected input hangs. The bootstrap has no double quotes, so it passes safely.
    const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', bootstrap], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    readline.createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line));
    proc.stderr.on('data', (d) => this.logger?.warn('automation', `Helper stderr: ${String(d).trim().slice(0, 500)}`));
    proc.on('exit', (code) => {
      if (this.proc === proc) this.proc = null;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`Automation helper exited (code ${code}).`));
      }
      this.pending.clear();
    });
    proc.on('error', (err) => this.logger?.error('automation', `Helper failed to start: ${err.message}`));
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line.replace(/^﻿/, ''));
    } catch {
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.result);
    else entry.reject(new Error(msg.error || 'Automation command failed.'));
  }

  /** Runs one helper command. Commands are serialized because the helper is single-threaded. */
  call(cmd, args = {}, timeoutMs = 20000) {
    const run = () =>
      new Promise((resolve, reject) => {
        try {
          this.start();
        } catch (err) {
          reject(err);
          return;
        }
        const id = this.nextId++;
        const helperTimeout = Number(args.timeoutMs) || 0;
        const timer = setTimeout(() => {
          this.pending.delete(id);
          // A hung UI Automation call leaves the helper unusable, so restart it on the next command.
          this.stop();
          reject(new Error(`Automation command '${cmd}' timed out.`));
        }, timeoutMs + helperTimeout);
        this.pending.set(id, { resolve, reject, timer });
        this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + '\n');
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  stop() {
    if (!this.proc) return;
    try {
      this.proc.stdin.end();
      this.proc.kill();
    } catch {
      // Process already gone.
    }
    this.proc = null;
  }
}

module.exports = { UiaClient };
