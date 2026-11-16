'use strict';

/*
 * Runs tests/firebase/*.test.js against the Firebase Emulator Suite (needs Java), then makes sure the
 * Database Emulator is stopped: on Windows `emulators:exec` can leave its Java process running, which
 * blocks port 9000 the next time.
 */

const { spawnSync, execSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
require('./build-rules');

const run = spawnSync(
  'npx',
  ['--yes', 'firebase-tools@15.34.2', 'emulators:exec', '--only', 'auth,database', '--project', 'demo-stream-remote', '"node --test --test-concurrency=1 tests/firebase/*.test.js"'],
  { cwd: root, stdio: 'inherit', shell: true },
);

if (process.platform === 'win32') {
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Where-Object { $_.CommandLine -match \'firebase-(database|firestore)-emulator\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' },
    );
  } catch {
    // Nothing left running.
  }
}

process.exit(run.status ?? 1);
