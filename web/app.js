/* Stream Automation — mobile website for the Zoom Stream Automation desktop app, on Firebase
 * (Hosting + Authentication + Realtime Database). No framework; all text is set with textContent.
 * Who may read or change what is enforced by database.rules.json, not by this page. */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js';
import {
  getAuth,
  connectAuthEmulator,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-auth.js';
import {
  getDatabase,
  connectDatabaseEmulator,
  ref,
  get,
  set,
  update,
  push,
  remove,
  onValue,
  serverTimestamp,
  onDisconnect,
  query,
  limitToLast,
} from 'https://www.gstatic.com/firebasejs/13.1.0/firebase-database.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) n.append(c.nodeType ? c : String(c));
  return n;
};
const local = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};

const S = {
  cfg: null,
  auth: null,
  db: null,
  user: null, // Firebase user
  me: null, // { uid, email, role }
  connected: false,
  offset: 0, // server time − local time
  pcs: {},
  presence: {},
  pcId: null,
  state: null,
  preview: null,
  watching: false,
  scheduleDirty: false,
  holdRouting: false,
  subs: { main: [], pc: [], frame: null, me: null },
};

const ONLINE_MS = 75000;
const COMMAND_TIMEOUT_MS = 30000;
const WATCH_REFRESH_MS = 20000;
const INVITE_DAYS = 7;
const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LABELS = {
  startStream: 'Start Stream', endStream: 'End Stream', cancel: 'Cancel', confirmLive: "I'm live", openZoom: 'Open Zoom meeting',
  shareImage: 'Share Image', shareScreen: 'Share Screen', stopShare: 'Stop Share', nextImage: 'Random image',
  dismissError: 'Dismiss error', selectImage: 'Choose image', setSchedule: 'Save schedule', setStartSteps: 'Start Stream steps',
  playMusic: 'Play music', stopMusic: 'Stop music', nextSong: 'Random song', selectSong: 'Choose song', setMusicSource: 'Music source',
  setMusicYoutube: 'YouTube music link',
};

/** The Start Stream checklist (the PC's settings; all ticked by default). */
const START_STEPS = [
  ['openZoom', 'Open Zoom and the meeting'],
  ['youtube', 'Go live on YouTube'],
  ['shareImage', 'Share the image (with sound)'],
  ['annotation', 'Disable annotation for others'],
  ['music', 'Play music'],
];

// ---- Helpers ---------------------------------------------------------------------------------

const now = () => Date.now() + S.offset;

function toast(message, hint = '', tone = '') {
  const t = el('div', { class: `toast ${tone}` }, message, hint ? el('span', {}, hint) : null);
  $('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'error' ? 8000 : 3500);
}

function confirmDialog(title, text, yes = 'Yes', { input = null, check = null } = {}) {
  return new Promise((resolve) => {
    const box = $('confirm-input');
    const err = $('confirm-error');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yes;
    $('confirm-yes').className = input == null ? 'btn danger' : 'btn primary';
    box.hidden = input == null;
    box.value = input ?? '';
    err.hidden = true;
    $('confirm').hidden = false;
    if (input != null) box.focus(), box.select();
    const done = (v) => {
      $('confirm').hidden = true;
      $('confirm-yes').onclick = $('confirm-no').onclick = box.onkeydown = null;
      resolve(v);
    };
    $('confirm-yes').onclick = () => {
      if (input == null) return done(true);
      const problem = check ? check(box.value) : '';
      if (problem) {
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      done(box.value);
    };
    box.onkeydown = (e) => e.key === 'Enter' && $('confirm-yes').onclick();
    $('confirm-no').onclick = () => done(input == null ? false : null);
  });
}

/** Owner only: give a paired system a new name (shown in the dropdown and in the desktop app). */
async function renamePc(id) {
  const pc = S.pcs[id];
  if (!pc || S.me?.role !== 'owner') return;
  const name = await confirmDialog('Rename this system', `New name for "${pc.name}":`, 'Save', {
    input: pc.name,
    check: (v) => (!v.trim() ? 'Type a name.' : v.trim().length > 60 ? 'Use at most 60 characters.' : Object.entries(S.pcs).some(([k, x]) => k !== id && x.name.trim().toLowerCase() === v.trim().toLowerCase()) ? 'Another system already has this name.' : ''),
  });
  if (name == null || name.trim() === pc.name) return;
  try {
    await set(ref(S.db, `pcs/${id}/name`), name.trim());
    audit('Renamed a PC', `${pc.name} → ${name.trim()}`);
    toast(`Renamed to "${name.trim()}".`);
  } catch (err) {
    toast(niceError(err), '', 'error');
  }
}

const timeText = (t) => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const clockText = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const setPill = (node, text, tone = '') => {
  node.textContent = text;
  node.className = `pill ${tone}`;
};
const formError = (form, message) => (form.querySelector('[data-error]').textContent = message || '');
const randomToken = (bytes = 24) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const pairingCode = () => {
  const b = crypto.getRandomValues(new Uint8Array(8));
  const c = [...b].map((x) => PAIR_ALPHABET[x % PAIR_ALPHABET.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
};

/** Plain-language messages for Firebase errors. */
function niceError(err) {
  const code = err?.code || '';
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found' || code === 'auth/invalid-login-credentials') return 'Wrong email or password.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes or reset your password.';
  if (code === 'auth/weak-password') return 'Choose a longer password (8+ characters).';
  if (code === 'auth/invalid-email') return 'That email address is not valid.';
  if (code === 'auth/network-request-failed') return 'No internet connection.';
  if (code === 'auth/requires-recent-login') return 'Sign in again, then try once more.';
  if (/PERMISSION_DENIED|permission/i.test(code + (err?.message || ''))) return 'Not allowed.';
  return err?.message || 'Something went wrong.';
}

function audit(action, detail = '') {
  if (!S.me) return;
  push(ref(S.db, 'audit'), { at: serverTimestamp(), actor: S.user.email, action, ...(detail ? { detail: String(detail).slice(0, 500) } : {}) }).catch(() => {});
}

// ---- Routing ---------------------------------------------------------------------------------

function show(view) {
  $('boot').hidden = true;
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== view;
  const inApp = view === 'home' || view === 'admin' || view === 'download';
  $('topbar').hidden = !inApp;
  // Menu tabs stay visible; the current page is highlighted.
  $('nav-admin').hidden = !(S.me && S.me.role === 'owner');
  for (const [id, v] of [['nav-home', 'home'], ['nav-download', 'download'], ['nav-admin', 'admin']]) {
    $(id).classList.toggle('active', view === v);
    if (view === v) $(id).setAttribute('aria-current', 'page');
    else $(id).removeAttribute('aria-current');
  }
  if (inApp) startLive();
  if (view === 'admin') loadAdmin();
  if (view === 'download') loadDownloads();
  if (view !== 'home') setWatching(false);
}

function go(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  route();
}

async function route() {
  if (S.holdRouting) return;
  const path = location.pathname;
  const invite = path.match(/^\/invite\/([\w-]{24,100})$/);
  if (invite) return showInvite(invite[1]);
  if (!S.user) {
    const owner = await get(ref(S.db, 'owner/uid')).catch(() => null);
    return show(owner && !owner.exists() ? 'setup' : 'login');
  }
  if (!S.me) {
    const owner = await get(ref(S.db, 'owner/uid')).catch(() => null);
    if (owner && !owner.exists()) return show('setup');
    $('noaccess-email').textContent = S.user.email || '';
    return show('noaccess');
  }
  if (path === '/admin' && S.me.role === 'owner') return show('admin');
  if (path === '/download') return show('download');
  if (path !== '/') history.replaceState({}, '', '/');
  show('home');
}

window.addEventListener('popstate', route);

// ---- Sign in, setup, invite ------------------------------------------------------------------

function bindForm(id, handler) {
  const form = $(id);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError(form, '');
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      await handler(Object.fromEntries(new FormData(form)), form);
    } catch (err) {
      formError(form, niceError(err));
    } finally {
      btn.disabled = false;
    }
  });
}

/** Signs in, or creates the account first when it does not exist yet. */
async function signInOrCreate(email, password) {
  try {
    return (await createUserWithEmailAndPassword(S.auth, email, password)).user;
  } catch (err) {
    if (err.code !== 'auth/email-already-in-use') throw err;
    return (await signInWithEmailAndPassword(S.auth, email, password)).user;
  }
}

/** Runs account changes without the page jumping to another view half-way, then routes once. */
async function holdRouting(fn) {
  S.holdRouting = true;
  try {
    await fn();
  } finally {
    S.holdRouting = false;
    await loadMe();
    route();
  }
}

bindForm('login-form', async (v) => {
  await signInWithEmailAndPassword(S.auth, v.email.trim(), v.password);
  $('login-form').reset();
});

$('btn-forgot').onclick = async () => {
  const email = $('login-form').email.value.trim();
  if (!email) return formError($('login-form'), 'Type your email above first.');
  try {
    await sendPasswordResetEmail(S.auth, email);
  } catch (err) {
    if (err.code === 'auth/invalid-email') return formError($('login-form'), niceError(err));
  }
  toast('If an account exists for that email, a reset link was sent.', 'Check the inbox and spam folder.');
};

bindForm('setup-form', async (v) => {
  if (v.password !== v.password2) throw new Error('The passwords do not match.');
  if (v.password.length < 8) throw new Error('Use at least 8 characters.');
  await holdRouting(async () => {
    const user = await signInOrCreate(v.email.trim(), v.password);
    try {
      await update(ref(S.db), {
        owner: { uid: user.uid, code: v.code.trim() },
        [`users/${user.uid}`]: { email: user.email.toLowerCase(), role: 'owner', createdAt: serverTimestamp() },
      });
    } catch {
      throw new Error('Wrong setup code, or this website already has an owner.');
    }
  });
  audit('Owner account created');
  go('/');
});

let invite = null;
async function showInvite(token) {
  try {
    const snap = await get(ref(S.db, `invites/${token}`));
    const inv = snap.val();
    if (!inv) throw new Error('This invite link is not valid. Ask the owner for a new one.');
    if (inv.usedBy) throw new Error('This invite link was already used. Sign in instead, or ask the owner for a new one.');
    if (inv.expiresAt < now()) throw new Error('This invite link has expired. Ask the owner for a new one.');
    if (location.pathname !== `/invite/${token}`) return; // The page moved on meanwhile.
    invite = { token, ...inv };
    document.querySelector('[data-invite-email]').textContent = inv.email;
    show('invite');
  } catch (err) {
    if (location.pathname !== `/invite/${token}`) return;
    $('boot').hidden = false;
    $('boot').textContent = niceError(err);
    for (const v of document.querySelectorAll('[data-view]')) v.hidden = true;
  }
}

bindForm('invite-form', async (v) => {
  if (v.password !== v.password2) throw new Error('The passwords do not match.');
  if (v.password.length < 8) throw new Error('Use at least 8 characters.');
  await holdRouting(async () => {
    const user = await signInOrCreate(invite.email, v.password);
    try {
      await update(ref(S.db), {
        [`users/${user.uid}`]: { email: user.email.toLowerCase(), role: invite.role, createdAt: serverTimestamp(), invite: invite.token },
        [`invites/${invite.token}/usedBy`]: user.uid,
      });
    } catch {
      throw new Error('This invite could not be used (expired, already used, or you already have access).');
    }
    history.replaceState({}, '', '/'); // Leave the (now used) invite link before the page routes again.
  });
  audit('Joined with an invite', invite.role);
});

async function logout() {
  setWatching(false);
  stopLive();
  await signOut(S.auth).catch(() => {});
  go('/');
}
$('nav-logout').onclick = logout;

// Phones: the menu sits behind the ☰ button.
const setMenu = (open) => {
  $('topbar').classList.toggle('menu-open', open);
  $('menu-btn').setAttribute('aria-expanded', String(open));
};
$('menu-btn').onclick = (e) => {
  e.stopPropagation();
  setMenu(!$('topbar').classList.contains('menu-open'));
};
$('top-nav').addEventListener('click', () => setMenu(false));
document.addEventListener('click', (e) => {
  if (!$('topbar').contains(e.target)) setMenu(false);
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && setMenu(false));
$('btn-noaccess-logout').onclick = logout;
$('nav-admin').onclick = () => go('/admin');
$('nav-download').onclick = () => go('/download');
$('nav-home').onclick = () => go('/');

/** Reads this person's role; listens so a removal signs them out of the controls at once. */
async function loadMe() {
  S.subs.me?.();
  S.subs.me = null;
  S.me = null;
  if (!S.user) return;
  const r = ref(S.db, `users/${S.user.uid}`);
  const snap = await get(r).catch(() => null);
  if (!snap || !snap.exists()) return;
  S.me = { uid: S.user.uid, ...snap.val() };
  S.subs.me = onValue(
    r,
    (s) => {
      if (!s.exists() && S.me) {
        S.me = null;
        stopLive();
        route();
      }
    },
    () => {},
  );
}

// ---- Live data -------------------------------------------------------------------------------

function startLive() {
  if (S.subs.main.length) return;
  const sub = (path, fn) => S.subs.main.push(onValue(ref(S.db, path), (s) => fn(s.val()), () => {}));
  sub('.info/connected', (v) => {
    S.connected = !!v;
    renderPc();
  });
  sub('.info/serverTimeOffset', (v) => (S.offset = Number(v) || 0));
  sub('pcs', (v) => {
    S.pcs = v || {};
    const ids = Object.keys(S.pcs);
    const remembered = local.get('zsr-device');
    if (!S.pcs[S.pcId]) selectPc(ids.includes(remembered) ? remembered : ids.find((id) => isOnline(id)) || ids[0] || null);
    renderPc();
    if (!$('device-list').closest('[data-view]').hidden) renderDevices();
    pairCheck();
  });
  sub('presence', (v) => {
    S.presence = v || {};
    renderPc();
    if (!$('device-list').closest('[data-view]').hidden) renderDevices();
  });
  // Online/offline depends on time passing too.
  S.subs.main.push(((t) => () => clearInterval(t))(setInterval(renderPc, 15000)));
}

function stopLive() {
  for (const off of [...S.subs.main, ...S.subs.pc]) off();
  S.subs.main = [];
  S.subs.pc = [];
  S.pcId = null;
  S.state = null;
  S.preview = null;
}

function isOnline(id) {
  const p = S.presence[id];
  return !!(p && p.online && now() - p.lastSeen < ONLINE_MS);
}

function selectPc(id) {
  if (S.pcId === id) return;
  setWatching(false);
  for (const off of S.subs.pc) off();
  S.subs.pc = [];
  S.pcId = id;
  S.state = null;
  S.preview = null;
  if (id) {
    local.set('zsr-device', id);
    S.subs.pc.push(onValue(ref(S.db, `state/${id}`), (s) => ((S.state = s.val()), render()), () => {}));
    S.subs.pc.push(onValue(ref(S.db, `preview/${id}`), (s) => ((S.preview = s.val()), renderPreview()), () => {}));
  }
  render();
}

/** Sends a command to the PC and waits for its answer. */
async function command(action, args = null, button = null) {
  const pc = S.pcs[S.pcId];
  if (!S.connected) {
    toast('No internet connection.', 'Check the phone connection.', 'error');
    return false;
  }
  if (!pc || !isOnline(S.pcId)) {
    toast('The PC is offline.', 'Check that it is on, signed in and Zoom Stream Automation is open.', 'error');
    return false;
  }
  if (button) button.classList.add('busy');
  const pcId = S.pcId;
  const cmdRef = push(ref(S.db, `commands/${pcId}`));
  try {
    await set(cmdRef, { action, ...(args ? { args } : {}), uid: S.user.uid, by: S.user.email, at: serverTimestamp() });
  } catch (err) {
    if (button) button.classList.remove('busy');
    toast('The command was refused.', niceError(err), 'error');
    return false;
  }
  const detail = action === 'setSchedule' ? `${args.time}, ${args.enabled ? 'on' : 'off'}` : action === 'selectImage' ? args.name : '';
  audit(LABELS[action] || action, `${pc.name}${detail ? `: ${detail}` : ''}`);
  const res = await new Promise((resolve) => {
    let off = null;
    const timer = setTimeout(() => {
      off?.();
      remove(cmdRef).catch(() => {});
      resolve({ ok: false, error: 'The PC did not answer in time.', hint: 'It may be busy, asleep or offline.' });
    }, COMMAND_TIMEOUT_MS);
    off = onValue(
      ref(S.db, `results/${pcId}/${cmdRef.key}`),
      (s) => {
        if (!s.exists()) return;
        clearTimeout(timer);
        off?.();
        resolve(s.val());
      },
      () => {},
    );
  });
  if (button) button.classList.remove('busy');
  if (!res.ok) toast(res.error || 'The PC could not do that.', res.hint || '', 'error');
  return !!res.ok;
}

// ---- Dashboard -------------------------------------------------------------------------------

function renderPc() {
  const pc = S.pcs[S.pcId];
  const online = !!pc && isOnline(S.pcId);
  const count = Object.keys(S.pcs).length;
  $('pc-line').textContent = pc ? pc.name : count ? '' : 'No PC paired yet';
  // Two or more systems: the name in the header becomes a dropdown; buttons control only the selected system.
  const sw = $('pc-switch');
  $('pc-line').hidden = count >= 2;
  sw.hidden = count < 2;
  const opts = Object.entries(S.pcs)
    .sort(([, a], [, b]) => String(a.name).localeCompare(String(b.name)))
    .map(([id, x]) => [id, isOnline(id) ? x.name : `${x.name} · offline`]);
  const sig = JSON.stringify(opts);
  if (sw.dataset.sig !== sig) {
    sw.dataset.sig = sig;
    sw.replaceChildren(...opts.map(([id, label]) => el('option', { value: id }, label)));
  }
  if (S.pcId && document.activeElement !== sw) sw.value = S.pcId;
  $('pc-rename').hidden = !pc || S.me?.role !== 'owner';
  if (!S.connected) setPill($('pc-pill'), 'No connection', 'bad');
  else if (!pc) setPill($('pc-pill'), 'No PC');
  else setPill($('pc-pill'), online ? 'PC online' : 'PC offline', online ? 'ok' : 'bad');

  const banner = $('offline-banner');
  const last = S.presence[S.pcId]?.lastSeen;
  if (!S.connected) banner.textContent = 'Connecting…';
  else if (!pc) banner.textContent = S.me?.role === 'owner' ? 'No PC is paired yet. Open Admin → Add a PC.' : 'No PC is paired yet. Ask the owner to pair the stream PC.';
  else if (!online) banner.textContent = `${pc.name} is offline${last ? ` (last seen ${timeText(last)})` : ''}. Make sure the PC is on and signed in to Windows; Zoom Stream Automation starts by itself in the background (version 2.3.0 or later).`;
  banner.hidden = S.connected && !!pc && online;

  render();
}
$('pc-rename').onclick = () => renamePc(S.pcId);
$('pc-switch').onchange = (e) => {
  selectPc(e.target.value);
  renderPc();
  toast(`Now controlling ${S.pcs[S.pcId]?.name || 'this system'}.`, 'Buttons act only on this system.');
};

const STEP_MARK = { done: '✓', failed: '✕', running: '…', waiting: '…', skipped: '–', pending: '○' };
const ZOOM_TEXT = { connected: ['Connected', 'ok'], disconnected: ['Not running', 'bad'], not_installed: ['Not installed', 'bad'], unknown: ['Checking…', ''] };

function render() {
  const online = S.connected && !!S.pcId && isOnline(S.pcId);
  const st = online ? S.state : null;
  const wf = st?.workflow;
  const busy = !!wf?.busy;
  const live = !!wf?.stream?.live;
  const sharing = !!wf?.share?.type || !!st?.zoom?.sharingDetected;
  const inMeeting = !!st?.zoom?.inMeeting;

  // Stream
  if (!st) setPill($('stream-pill'), '—');
  else if (busy) setPill($('stream-pill'), wf.action === 'end' ? 'Ending…' : 'Working…', 'busy');
  else if (live) setPill($('stream-pill'), 'LIVE', 'live');
  else if (wf.stream?.phase === 'sharing') setPill($('stream-pill'), 'Sharing', 'ok');
  else setPill($('stream-pill'), 'Idle');
  $('stream-message').textContent = !st ? '' : wf.message || (live && wf.stream.startedAt ? `Live since ${clockText(wf.stream.startedAt)}` : '');
  $('btn-start').disabled = !st || busy || live;
  $('btn-end').disabled = !st || (busy && wf.action === 'end') || (!live && !inMeeting && !sharing && !busy);
  $('btn-cancel').hidden = !busy;
  $('btn-live').hidden = !(busy && wf.waitingForUser);
  $('steps').replaceChildren(
    ...(wf?.steps || []).map((s) =>
      el('li', { class: s.status }, el('span', { class: 'mark' }, STEP_MARK[s.status] || '○'), el('span', {}, s.label, s.detail ? el('span', { class: 'detail' }, s.detail) : null)),
    ),
  );
  const err = wf?.error;
  $('error-box').hidden = !err;
  $('error-text').textContent = err?.message || '';
  $('error-hint').textContent = err?.hint || '';
  $('btn-dismiss').hidden = busy;

  renderStartSteps(st, busy);
  renderMusic(st, busy);

  // Share
  const shareType = wf?.share?.type;
  setPill($('share-pill'), !st ? '—' : shareType === 'image' ? 'Image' : shareType === 'screen' ? 'Screen' : sharing ? 'Sharing' : 'Not sharing', sharing ? 'ok' : '');
  $('btn-share-image').disabled = !st || busy || !inMeeting || !st.images?.selectedName;
  $('btn-share-screen').disabled = !st || busy || !inMeeting;
  $('btn-stop-share').disabled = !st || busy || !sharing;

  // Images
  const imgs = st?.images;
  $('image-count').textContent = imgs ? `${imgs.count} image(s)` : '';
  $('image-name').textContent = imgs?.selectedName || '';
  $('image-name').title = imgs?.selectedName || '';
  const sel = $('image-select');
  const names = imgs?.names || [];
  if (sel.dataset.sig !== names.join('|')) {
    sel.dataset.sig = names.join('|');
    sel.replaceChildren(el('option', { value: '' }, names.length ? 'Choose an image…' : 'No images in the folder'), ...names.map((n) => el('option', { value: n }, n)));
  }
  sel.value = imgs?.selectedName && names.includes(imgs.selectedName) ? imgs.selectedName : '';
  sel.disabled = !st || busy || !names.length;
  $('btn-next-image').disabled = !st || busy || names.length < 2;
  renderPreview();

  // Schedule
  const sc = st?.schedule;
  if (sc && !S.scheduleDirty && document.activeElement !== $('schedule-time')) {
    $('schedule-time').value = sc.time || '05:50';
    $('schedule-enabled').checked = !!sc.enabled;
  }
  setPill($('schedule-pill'), !sc ? '—' : sc.enabled ? `On · ${sc.time}` : 'Off', sc?.enabled ? 'ok' : '');
  $('schedule-next').textContent = !sc ? '' : sc.nextRun ? `Next stream: ${timeText(sc.nextRun)}` : sc.enabled ? 'No upcoming run.' : 'Automatic start is off.';
  $('btn-save-schedule').disabled = !st;
  $('schedule-time').disabled = $('schedule-enabled').disabled = !st;

  // Screen
  $('btn-watch').disabled = !online;
  if (!online && S.watching) setWatching(false);

  // Zoom
  const [zt, ztone] = ZOOM_TEXT[st?.zoom?.status] || ['—', ''];
  setPill($('zoom-pill'), st ? (inMeeting ? 'In meeting' : zt) : '—', inMeeting ? 'ok' : ztone);
  $('zoom-meeting').textContent = st?.meetingId ? `Meeting ID ${st.meetingId}` : st ? 'No meeting ID is set in the desktop app.' : '';
  $('btn-open-zoom').disabled = !st || busy || inMeeting;

  // Logs
  $('logs').replaceChildren(
    ...(st?.logs || [])
      .slice()
      .reverse()
      .map((l) => el('li', { class: l.level }, el('time', {}, clockText(l.ts)), l.message)),
  );
}

function renderStartSteps(st, busy) {
  const steps = st?.startSteps;
  const box = $('start-steps');
  box.hidden = !steps;
  if (!steps) return;
  const sig = JSON.stringify([steps, busy]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.replaceChildren(
    el('p', { class: 'checklist-title' }, 'Start Stream will:'),
    ...START_STEPS.map(([key, label]) => {
      const blocked = key === 'annotation' && !steps.shareImage;
      const on = !!steps[key] && !blocked;
      const input = el('input', { type: 'checkbox' });
      input.checked = on;
      input.disabled = busy || blocked;
      input.addEventListener('change', async () => {
        input.disabled = true;
        const ok = await command('setStartSteps', { [key]: input.checked });
        if (!ok) input.checked = !input.checked;
        input.disabled = false;
      });
      return el('label', { class: `check-row${on ? '' : ' off'}${blocked ? ' disabled' : ''}` }, input, el('span', {}, label));
    }),
  );
}

function renderMusic(st, busy) {
  const m = st?.music;
  const yt = m?.source === 'youtube';
  $('music-src-folder').className = !yt ? 'active' : '';
  $('music-src-youtube').className = yt ? 'active' : '';
  $('music-src-folder').disabled = $('music-src-youtube').disabled = !m;
  $('music-folder-box').hidden = yt;
  $('music-youtube-box').hidden = !yt;
  setPill($('music-pill'), !m ? '—' : m.playing ? 'Playing' : 'Stopped', m?.playing ? 'ok' : '');
  $('music-count').textContent = !m ? '' : m.count ? `${m.count} song(s) in the PC's music folder.` : m.error || 'No music folder is chosen in the desktop app.';
  const sel = $('music-select');
  const names = m?.names || [];
  if (sel.dataset.sig !== names.join('|')) {
    sel.dataset.sig = names.join('|');
    sel.replaceChildren(el('option', { value: '' }, names.length ? 'Choose a song…' : 'No songs'), ...names.map((n) => el('option', { value: n }, n)));
  }
  sel.value = m?.selectedName && names.includes(m.selectedName) ? m.selectedName : '';
  sel.disabled = !m || !names.length;
  $('btn-next-song').disabled = !m || names.length < 2;
  if (document.activeElement !== $('music-url') && !S.musicUrlDirty) $('music-url').value = m?.youtubeUrl || '';
  $('btn-save-music-url').hidden = !S.musicUrlDirty;
  $('music-now').hidden = !(m?.playing && m.title);
  $('music-now').textContent = m?.title ? `♪ ${m.title}` : '';
  $('btn-play-music').disabled = !m || (yt ? !m.youtubeUrl : !m.count);
  $('btn-stop-music').disabled = !m?.playing;
}

function renderPreview() {
  const p = S.preview;
  const selected = S.state?.images?.selectedName;
  const ok = p && p.dataUrl && p.name === selected && /^data:image\/jpeg;base64,/.test(p.dataUrl);
  $('preview').hidden = !ok;
  $('preview-empty').hidden = !!ok;
  if (ok && $('preview').src !== p.dataUrl) $('preview').src = p.dataUrl;
}

$('btn-start').onclick = (e) => command('startStream', null, e.currentTarget);
$('btn-end').onclick = async (e) => {
  const btn = e.currentTarget;
  if (await confirmDialog('End the stream?', 'This stops the YouTube live stream and sharing, ends the Zoom meeting for everyone and closes Zoom.', 'End Stream')) command('endStream', null, btn);
};
$('btn-cancel').onclick = (e) => command('cancel', null, e.currentTarget);
$('btn-live').onclick = (e) => command('confirmLive', null, e.currentTarget);
$('btn-dismiss').onclick = (e) => command('dismissError', null, e.currentTarget);
$('btn-share-image').onclick = (e) => command('shareImage', null, e.currentTarget);
$('btn-share-screen').onclick = (e) => command('shareScreen', null, e.currentTarget);
$('btn-stop-share').onclick = (e) => command('stopShare', null, e.currentTarget);
$('btn-next-image').onclick = (e) => command('nextImage', null, e.currentTarget);
$('image-select').onchange = (e) => e.target.value && command('selectImage', { name: e.target.value });
$('btn-open-zoom').onclick = (e) => command('openZoom', null, e.currentTarget);
$('music-src-folder').onclick = () => command('setMusicSource', { source: 'folder' });
$('music-src-youtube').onclick = () => command('setMusicSource', { source: 'youtube' });
$('music-select').onchange = (e) => e.target.value && command('selectSong', { name: e.target.value });
$('btn-next-song').onclick = (e) => command('nextSong', null, e.currentTarget);
$('btn-play-music').onclick = (e) => command('playMusic', null, e.currentTarget);
$('btn-stop-music').onclick = (e) => command('stopMusic', null, e.currentTarget);
$('music-url').oninput = () => {
  S.musicUrlDirty = true;
  $('btn-save-music-url').hidden = false;
};
$('btn-save-music-url').onclick = async (e) => {
  const url = $('music-url').value.trim();
  if (url && !/^https:\/\/(www\.|m\.|music\.)?(youtube\.com\/(watch\?v=|shorts\/|live\/)|youtu\.be\/)[A-Za-z0-9_-]{11}/.test(url)) {
    return toast('That is not a YouTube video link.', 'Copy the link from the YouTube app or website (Share → Copy link).', 'error');
  }
  if (await command('setMusicYoutube', { url }, e.currentTarget)) {
    S.musicUrlDirty = false;
    toast('YouTube link saved on the PC.');
  }
};
$('schedule-time').oninput = $('schedule-enabled').onchange = () => (S.scheduleDirty = true);
$('btn-save-schedule').onclick = async (e) => {
  const time = $('schedule-time').value;
  if (!/^\d{2}:\d{2}$/.test(time)) return toast('Choose a start time.', '', 'error');
  if (await command('setSchedule', { time, enabled: $('schedule-enabled').checked }, e.currentTarget)) {
    S.scheduleDirty = false;
    toast('Schedule saved on the PC.');
  }
};

// ---- Live screen -----------------------------------------------------------------------------

let watchTimer = null;
let watchRef = null;

function setWatching(on) {
  on = !!on && !!S.pcId && !!S.me;
  if (on === S.watching) return;
  S.watching = on;
  clearInterval(watchTimer);
  S.subs.frame?.();
  S.subs.frame = null;
  if (watchRef) {
    remove(watchRef).catch(() => {});
    onDisconnect(watchRef).cancel().catch(() => {});
    watchRef = null;
  }
  $('screen-box').hidden = !on;
  $('btn-watch').textContent = on ? 'Hide live screen' : 'Show live screen';
  setPill($('screen-pill'), on ? 'Waiting…' : 'Off', on ? 'busy' : '');
  if (!on) {
    $('screen').removeAttribute('src');
    return;
  }
  // Tell the PC someone is watching (refreshed, so it stops if this phone disappears).
  watchRef = ref(S.db, `watch/${S.pcId}/${S.user.uid}`);
  const beat = () => set(watchRef, serverTimestamp()).catch(() => {});
  onDisconnect(watchRef).remove().catch(() => {});
  beat();
  watchTimer = setInterval(beat, WATCH_REFRESH_MS);
  S.subs.frame = onValue(
    ref(S.db, `frames/${S.pcId}`),
    (s) => {
      const f = s.val();
      if (!S.watching || !f?.jpeg) return;
      $('screen').src = `data:image/jpeg;base64,${f.jpeg}`;
      const fresh = now() - f.at < 15000;
      setPill($('screen-pill'), fresh ? `Live · ${clockText(f.at)}` : `Last frame ${clockText(f.at)}`, fresh ? 'ok' : 'busy');
    },
    () => {},
  );
}

$('btn-watch').onclick = () => setWatching(!S.watching);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.watching) setWatching(false); // Don't stream the screen to a phone in the pocket.
});

// ---- Download page ---------------------------------------------------------------------------

const INSTALLER_RE = /^Zoom-Stream-Automation-Setup-(\d+\.\d+\.\d+)\.exe$/;
const sizeText = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;
const plain = (t) => String(t).replace(/\*\*|`/g, '').trim();

/** "What's new": the bullet lines of the release notes (plain text only). */
function releaseBullets(body) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /new in/i.test(l));
  return lines
    .slice(start >= 0 ? start + 1 : 0)
    .filter((l) => /^\s*[-*]\s+/.test(l))
    .map((l) => plain(l.replace(/^\s*[-*]\s+/, '')))
    .filter(Boolean)
    .slice(0, 6);
}

async function loadDownloads() {
  const show = (id, on) => ($(id).hidden = !on);
  $('dl-version').textContent = 'Checking…';
  ['dl-size', 'dl-date', 'dl-button', 'dl-empty', 'dl-notes-card'].forEach((id) => show(id, false));
  $('dl-file').textContent = '';
  const repo = S.cfg.githubRepo;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error('No download source is set in config.json.');
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
    if (res.status === 404) {
      $('dl-version').textContent = 'Not published';
      show('dl-empty', true);
      return;
    }
    if (!res.ok) throw new Error(`The download server answered ${res.status}. Try again later.`);
    const rel = await res.json();
    const setup = (rel.assets || [])
      .map((a) => ({ a, m: a.name.match(INSTALLER_RE) }))
      .find((x) => x.m && /^https:\/\/github\.com\//.test(x.a.browser_download_url));
    if (!setup) {
      $('dl-version').textContent = rel.tag_name || 'Not published';
      show('dl-empty', true);
      return;
    }
    $('dl-version').textContent = `Version ${setup.m[1]}`;
    $('dl-size').textContent = sizeText(setup.a.size);
    show('dl-size', true);
    if (rel.published_at) {
      $('dl-date').textContent = `Published ${new Date(rel.published_at).toLocaleDateString([], { dateStyle: 'medium' })}`;
      show('dl-date', true);
    }
    $('dl-button').href = setup.a.browser_download_url;
    $('dl-button').querySelector('span').textContent = `Download installer · v${setup.m[1]}`;
    show('dl-button', true);
    $('dl-file').textContent = setup.a.name;
    const notes = releaseBullets(rel.body);
    $('dl-notes').replaceChildren(...notes.map((n) => el('li', {}, n)));
    show('dl-notes-card', notes.length > 0);
  } catch (err) {
    $('dl-version').textContent = 'Unavailable';
    toast(niceError(err), '', 'error');
  }
}

// ---- Admin -----------------------------------------------------------------------------------

async function loadAdmin() {
  try {
    const [users, invites, log] = await Promise.all([get(ref(S.db, 'users')), get(ref(S.db, 'invites')), get(query(ref(S.db, 'audit'), limitToLast(200)))]);
    renderUsers(users.val() || {}, invites.val() || {});
    const entries = Object.values(log.val() || {}).sort((a, b) => b.at - a.at);
    $('audit-list').replaceChildren(...entries.map((a) => el('li', {}, el('time', {}, timeText(a.at)), `${a.actor} — ${a.action}${a.detail ? `: ${a.detail}` : ''}`)));
    renderDevices();
  } catch (err) {
    toast(niceError(err), '', 'error');
  }
}

function renderUsers(users, invites) {
  const open = Object.entries(invites).filter(([, i]) => !i.usedBy && i.expiresAt > now());
  $('user-list').replaceChildren(
    ...Object.entries(users).map(([uid, u]) =>
      el(
        'li',
        {},
        el('div', {}, el('span', {}, u.email), el('span', { class: 'muted small' }, u.role === 'owner' ? 'Owner' : 'Client')),
        uid === S.me.uid
          ? el('span', { class: 'muted small' }, 'You')
          : el(
              'button',
              {
                class: 'btn small',
                type: 'button',
                onclick: async () => {
                  if (!(await confirmDialog('Remove this person?', `${u.email} will lose access at once.`, 'Remove'))) return;
                  try {
                    await remove(ref(S.db, `users/${uid}`));
                    audit('Removed a person', u.email);
                  } catch (err) {
                    toast(niceError(err), '', 'error');
                  }
                  loadAdmin();
                },
              },
              'Remove',
            ),
      ),
    ),
    ...open.map(([token, i]) =>
      el(
        'li',
        {},
        el('div', {}, el('span', {}, i.email), el('span', { class: 'muted small' }, `Invited (${i.role}) · expires ${timeText(i.expiresAt)}`)),
        el(
          'button',
          {
            class: 'btn small',
            type: 'button',
            onclick: async () => {
              await remove(ref(S.db, `invites/${token}`)).catch((err) => toast(niceError(err), '', 'error'));
              loadAdmin();
            },
          },
          'Cancel',
        ),
      ),
    ),
  );
}

function renderDevices() {
  const ids = Object.keys(S.pcs);
  $('device-list').replaceChildren(
    ...(ids.length
      ? ids.map((id) => {
          const d = S.pcs[id];
          const p = S.presence[id];
          const online = isOnline(id);
          return el(
            'li',
            {},
            el('div', {}, el('span', {}, d.name), el('span', { class: 'muted small' }, online ? `Online${p?.version ? ` · app v${p.version}` : ''}` : `Offline${p?.lastSeen ? ` · last seen ${timeText(p.lastSeen)}` : ''}`)),
            el('button', { class: 'btn small', type: 'button', onclick: () => renamePc(id) }, 'Rename'),
            el(
              'button',
              {
                class: 'btn small',
                type: 'button',
                onclick: async () => {
                  if (!(await confirmDialog('Remove this PC?', `${d.name} will be disconnected. To use it again, pair it with a new code.`, 'Remove'))) return;
                  const gone = {};
                  for (const node of ['pcs', 'presence', 'state', 'preview', 'frames', 'watch', 'commands', 'results']) gone[`${node}/${id}`] = null;
                  try {
                    await update(ref(S.db), gone);
                    audit('Removed a PC', d.name);
                  } catch (err) {
                    toast(niceError(err), '', 'error');
                  }
                },
              },
              'Remove',
            ),
          );
        })
      : [el('li', { class: 'muted' }, 'No PC paired yet.')]),
  );
}

// ---- Pair a new PC: code box with copy buttons, countdown and a "paired" notice ----
const PAIR_MS = 10 * 60000;
const pairing = { code: '', expiresAt: 0, timer: null };

function pairTick() {
  if (!pairing.code || !$('pair-done').hidden) return clearInterval(pairing.timer);
  const left = pairing.expiresAt - now();
  const expired = left <= 0;
  const m = Math.max(0, Math.floor(left / 60000));
  const sec = String(Math.max(0, Math.floor((left % 60000) / 1000))).padStart(2, '0');
  $('pair-expiry').textContent = expired ? 'This code has expired.' : `Expires in ${m}:${sec} (at ${clockText(pairing.expiresAt)}) · works once`;
  $('pair-bar').style.width = `${Math.max(0, Math.min(100, (left / PAIR_MS) * 100))}%`;
  $('pair-box').classList.toggle('expired', expired);
  $('pair-new').hidden = !expired;
  if (expired) clearInterval(pairing.timer);
}

/** Called when the PC list changes: a PC that used the open code is now paired. */
function pairCheck() {
  if (!pairing.code || $('pair-box').hidden) return;
  const pc = Object.values(S.pcs).find((x) => x.code === pairing.code);
  if (!pc) return;
  clearInterval(pairing.timer);
  $('pair-done').textContent = `✓ Paired: "${pc.name}" is now in your systems list.`;
  $('pair-done').hidden = false;
  $('pair-foot').hidden = true;
  $('pair-box').classList.add('paired');
}

async function newPairingCode() {
  try {
    const code = pairingCode();
    const expiresAt = now() + PAIR_MS;
    await set(ref(S.db, `pairing/${code}`), { createdBy: S.user.uid, expiresAt });
    audit('Created a PC pairing code');
    Object.assign(pairing, { code, expiresAt });
    $('pair-code').textContent = code;
    $('pair-site').textContent = location.origin;
    $('pair-done').hidden = true;
    $('pair-foot').hidden = false;
    $('pair-box').classList.remove('paired', 'expired');
    $('pair-box').hidden = false;
    $('btn-pair').hidden = true;
    clearInterval(pairing.timer);
    pairing.timer = setInterval(pairTick, 1000);
    pairTick();
    $('pair-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    toast(niceError(err), '', 'error');
  }
}
$('btn-pair').onclick = newPairingCode;
$('pair-new').onclick = newPairingCode;
$('pair-close').onclick = () => {
  clearInterval(pairing.timer);
  pairing.code = '';
  $('pair-box').hidden = true;
  $('btn-pair').hidden = false;
};
for (const b of document.querySelectorAll('[data-copy]')) {
  b.onclick = async () => {
    try {
      await navigator.clipboard.writeText($(b.dataset.copy).textContent);
      b.textContent = 'Copied ✓';
      setTimeout(() => (b.textContent = 'Copy'), 1500);
    } catch {
      toast('Could not copy. Select the text and copy it by hand.', '', 'error');
    }
  };
}

bindForm('invite-user-form', async (v, form) => {
  const email = v.email.trim().toLowerCase();
  const token = randomToken();
  await set(ref(S.db, `invites/${token}`), { email, role: v.role, createdBy: S.user.uid, createdAt: serverTimestamp(), expiresAt: now() + INVITE_DAYS * 86400000 });
  audit('Invited a person', `${email} (${v.role})`);
  $('invite-link').value = `${location.origin}/invite/${token}`;
  $('invite-days').textContent = INVITE_DAYS;
  $('invite-box').hidden = false;
  form.reset();
  loadAdmin();
});

$('btn-copy-invite').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('invite-link').value);
    toast('Link copied.');
  } catch {
    $('invite-link').select();
    toast('Select the link and copy it.');
  }
};

bindForm('password-form', async (v, form) => {
  if (v.next.length < 8) throw new Error('Use at least 8 characters.');
  await reauthenticateWithCredential(S.user, EmailAuthProvider.credential(S.user.email, v.current));
  await updatePassword(S.user, v.next);
  audit('Changed password');
  form.reset();
  toast('Password changed.');
});

// ---- Start -----------------------------------------------------------------------------------

const isLocalHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(h);

async function start() {
  try {
    S.cfg = await fetch('/config.json', { cache: 'no-store' }).then((r) => r.json());
  } catch {
    $('boot').textContent = 'Cannot load the website settings. Check your connection and reload.';
    return;
  }
  const host = location.hostname;
  const configured = !!S.cfg.firebase?.apiKey;
  // The local test server (npm run web:local, port 5555) always uses the Firebase emulators, never the live project.
  const emulate = isLocalHost(host) && (location.port === '5555' || !configured);
  if (!configured && !emulate) {
    $('boot').textContent = 'This website is not set up yet: add the Firebase settings to config.json and deploy again.';
    return;
  }
  const fbConfig = emulate
    ? { apiKey: 'demo-key', projectId: 'demo-stream-remote', authDomain: host, databaseURL: `http://${host}:9000?ns=demo-stream-remote-default-rtdb` }
    : S.cfg.firebase;
  const app = initializeApp(fbConfig);
  S.auth = getAuth(app);
  S.db = getDatabase(app);
  if (emulate) {
    connectAuthEmulator(S.auth, `http://${host}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(S.db, host, 9000);
  }
  onAuthStateChanged(S.auth, async (user) => {
    S.user = user;
    if (S.holdRouting) return;
    if (!user) {
      S.subs.me?.();
      S.subs.me = null;
      S.me = null;
      stopLive();
    } else {
      await loadMe();
    }
    route();
  });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
start();
