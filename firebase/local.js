'use strict';

/*
 * Runs the Stream Remote website on this PC with the Firebase emulators (no Firebase project needed):
 *   website  http://localhost:5555  (and http://<this PC's Wi-Fi address>:5555 for a phone on the same Wi-Fi)
 * Local test data only; it is wiped when this stops. Usage: npm run web:local
 */

const { spawn, execSync } = require('child_process');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const SETUP_CODE = process.env.LOCAL_SETUP_CODE || 'LOCAL-SETUP-CODE';
require('./build-rules');

const child = spawn('npx', ['--yes', 'firebase-tools@15.34.2', 'emulators:start', '--only', 'auth,database,hosting', '--project', 'demo-stream-remote'], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'inherit'],
  shell: true,
});
child.stdout.on('data', (d) => process.stdout.write(d));

const stopJava = () => {
  if (process.platform !== 'win32') return;
  try {
    execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'java.exe\'\\" | Where-Object { $_.CommandLine -match \'firebase-(database|firestore)-emulator\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore' },
    );
  } catch {
    // Nothing left running.
  }
};
child.on('exit', (code) => {
  stopJava();
  process.exit(code ?? 0);
});
process.on('SIGINT', () => child.kill('SIGINT'));

(async () => {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    try {
      const res = await fetch('http://127.0.0.1:9000/secrets/setupCode.json?ns=demo-stream-remote-default-rtdb', {
        method: 'PUT',
        headers: { Authorization: 'Bearer owner' },
        body: JSON.stringify(SETUP_CODE),
      });
      const site = await fetch('http://127.0.0.1:5555/config.json').catch(() => null);
      if (res.ok && site && site.ok) break;
    } catch {
      // Not ready yet.
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal && !/^169\.254\./.test(i.address))
    .map((i) => `http://${i.address}:5555`);
  console.log('\n────────────────────────────────────────────────────────────');
  console.log(' Stream Remote (local test, Firebase emulators)');
  console.log('   On this PC:     http://localhost:5555');
  for (const u of lan) console.log(`   On your Wi-Fi:  ${u}`);
  console.log(`   Setup code:     ${SETUP_CODE}   (first visit: create the owner account)`);
  console.log('   Desktop app → Remote tab: website http://localhost:5555 + a code from Admin → Add a PC');
  console.log('   Test data is wiped when this stops (Ctrl+C).');
  console.log('────────────────────────────────────────────────────────────\n');
})();
