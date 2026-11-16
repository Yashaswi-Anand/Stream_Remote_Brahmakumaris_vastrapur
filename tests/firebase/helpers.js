'use strict';

/* Shared setup for tests that run against the Firebase Emulator Suite (npm run test:firebase). */

const { FirebaseRest, SERVER_TIME } = require('../../src/main/firebaseRest');

const port = (envName, fallback) => {
  const v = process.env[envName] || '';
  const m = v.match(/:(\d+)$/);
  return m ? m[1] : fallback;
};

const PROJECT = process.env.GCLOUD_PROJECT || 'demo-stream-remote';
const config = {
  apiKey: 'demo-key',
  projectId: PROJECT,
  databaseURL: '',
  emulators: {
    auth: `http://127.0.0.1:${port('FIREBASE_AUTH_EMULATOR_HOST', '9099')}`,
    database: `http://127.0.0.1:${port('FIREBASE_DATABASE_EMULATOR_HOST', '9000')}`,
  },
};

const fb = new FirebaseRest({ config });
const ADMIN = { admin: true };
const SETUP_CODE = 'TEST-SETUP-CODE-123';

/** Clears the emulator's database and accounts, then stores the setup code (as the console would). */
async function reset() {
  await fb.db('PUT', '', null, ADMIN);
  await fetch(`${config.emulators.auth}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
  await fb.db('PUT', 'secrets/setupCode', SETUP_CODE, ADMIN);
}

let n = 0;
async function newUser(email = `user${++n}-${Date.now()}@test.local`, password = 'longpassword1') {
  const u = await fb.signUpWithPassword(email, password);
  return { ...u, email: email.toLowerCase(), password, token: u.idToken };
}

/** Expects the promise to fail with a permission error. */
async function denied(p) {
  try {
    await p;
  } catch (err) {
    if (err.code === 'PERMISSION_DENIED' || err.status === 401 || err.status === 403) return true;
    throw err;
  }
  throw new Error('Expected the database to refuse this, but it was allowed.');
}

module.exports = { fb, config, ADMIN, SETUP_CODE, SERVER_TIME, reset, newUser, denied, PROJECT };
