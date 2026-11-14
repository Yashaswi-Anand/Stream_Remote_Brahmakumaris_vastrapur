'use strict';

const os = require('os');
const { loadConfig } = require('./src/config');
const { createStore } = require('./src/store/mysqlStore');
const { createApp } = require('./src/app');

async function main() {
  const config = loadConfig();
  const store = createStore(config);
  await store.init();
  const app = createApp({ config, store });

  await new Promise((resolve) => app.server.listen(config.port, config.host, resolve));
  console.log(`Stream Remote is running on port ${config.port} (${config.db ? 'MySQL' : 'local file'} storage).`);
  if (!config.db) {
    const lan = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${config.port}`);
    console.log(`  On this PC:     http://localhost:${config.port}`);
    for (const u of lan) console.log(`  On your Wi-Fi:  ${u}`);
  }
  const code = await app.ensureSetupCode();
  if (code) console.log(`No account yet. Open the website and create the owner account with setup code: ${config.setupCode ? '(the SETUP_CODE you set)' : code}`);

  const shutdown = async () => {
    await app.close().catch(() => {});
    await store.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(`Could not start: ${err.message}`);
  process.exit(1);
});
