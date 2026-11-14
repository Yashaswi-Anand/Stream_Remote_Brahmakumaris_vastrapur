'use strict';

/* Stream Remote — mobile website for the Zoom Stream Automation desktop app. No framework; all text is set with textContent. */

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
const store = {
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
  me: null,
  devices: [],
  deviceId: null,
  state: null,
  preview: null,
  ws: null,
  wsRetry: 0,
  watching: false,
  frameUrl: null,
  pending: new Map(),
  scheduleDirty: false,
};

// ---- Helpers ---------------------------------------------------------------------------------

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-ZSR': '1' },
    credentials: 'same-origin',
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(message, hint = '', tone = '') {
  const t = el('div', { class: `toast ${tone}` }, message, hint ? el('span', {}, hint) : null);
  $('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'error' ? 8000 : 3500);
}

function confirmDialog(title, text, yes = 'Yes') {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-yes').textContent = yes;
    $('confirm').hidden = false;
    const done = (v) => {
      $('confirm').hidden = true;
      $('confirm-yes').onclick = $('confirm-no').onclick = null;
      resolve(v);
    };
    $('confirm-yes').onclick = () => done(true);
    $('confirm-no').onclick = () => done(false);
  });
}

const timeText = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
const clockText = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const setPill = (node, text, tone = '') => {
  node.textContent = text;
  node.className = `pill ${tone}`;
};

function formError(form, message) {
  form.querySelector('[data-error]').textContent = message || '';
}

// ---- Routing ---------------------------------------------------------------------------------

function show(view) {
  $('boot').hidden = true;
  for (const v of document.querySelectorAll('[data-view]')) v.hidden = v.dataset.view !== view;
  const inApp = view === 'home' || view === 'admin' || view === 'download';
  $('topbar').hidden = !inApp;
  $('nav-admin').hidden = !(S.me && S.me.role === 'owner');
  $('nav-home').hidden = view === 'home';
  $('nav-admin').hidden = $('nav-admin').hidden || view === 'admin';
  $('nav-download').hidden = view === 'download';
  if (inApp) connect();
  if (view === 'admin') loadAdmin();
  if (view === 'download') loadDownloads();
  if (view !== 'home') setWatching(false);
}

function go(path) {
  if (location.pathname !== path) history.pushState({}, '', path);
  route();
}

async function route() {
  const path = location.pathname;
  const invite = path.match(/^\/invite\/([\w-]{20,100})$/);
  if (invite) return showInvite(invite[1]);
  let me;
  try {
    me = await api('GET', '/api/me');
  } catch {
    $('boot').textContent = 'Cannot reach the server. Check your connection and reload.';
    return;
  }
  S.me = me.user;
  if (!S.me) return show(me.needsSetup ? 'setup' : 'login');
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
      formError(form, err.message);
    } finally {
      btn.disabled = false;
    }
  });
}

bindForm('login-form', async (v) => {
  const res = await api('POST', '/api/login', { email: v.email, password: v.password });
  S.me = res.user;
  $('login-form').reset();
  go('/');
});

bindForm('setup-form', async (v) => {
  if (v.password !== v.password2) throw new Error('The passwords do not match.');
  const res = await api('POST', '/api/setup', { code: v.code, email: v.email, password: v.password });
  S.me = res.user;
  go('/');
});

let inviteToken = '';
async function showInvite(token) {
  inviteToken = token;
  try {
    const inv = await api('GET', `/api/invite/${token}`);
    document.querySelector('[data-invite-email]').textContent = inv.email;
    show('invite');
  } catch (err) {
    $('boot').hidden = false;
    $('boot').textContent = err.message;
  }
}

bindForm('invite-form', async (v) => {
  if (v.password !== v.password2) throw new Error('The passwords do not match.');
  const res = await api('POST', '/api/invite/accept', { token: inviteToken, password: v.password });
  S.me = res.user;
  go('/');
});

$('nav-logout').onclick = async () => {
  await api('POST', '/api/logout').catch(() => {});
  S.me = null;
  disconnect();
  go('/');
};
$('nav-admin').onclick = () => go('/admin');
$('nav-download').onclick = () => go('/download');
$('nav-home').onclick = () => go('/');

// ---- Live connection -------------------------------------------------------------------------

function connect() {
  if (S.ws && S.ws.readyState <= 1) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'blob';
  S.ws = ws;
  ws.onopen = () => {
    S.wsRetry = 0;
    if (S.deviceId) send({ type: 'select', deviceId: S.deviceId });
    if (S.watching) send({ type: 'watch', on: true });
    renderPc();
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return showFrame(e.data);
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    onMessage(msg);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    S.ws = null;
    renderPc();
    if (e.code === 4005 || !S.me) return; // Signed out.
    const delay = Math.min(30000, 1000 * 2 ** S.wsRetry++);
    setTimeout(() => {
      if (S.me && !S.ws) api('GET', '/api/me').then((m) => (m.user ? connect() : go('/'))).catch(() => setTimeout(connect, delay));
    }, delay);
  };
}

function disconnect() {
  const ws = S.ws;
  S.ws = null;
  if (ws) ws.close();
}

const send = (msg) => S.ws && S.ws.readyState === 1 && S.ws.send(JSON.stringify(msg));

function onMessage(msg) {
  if (msg.type === 'devices') {
    S.devices = msg.devices;
    const remembered = store.get('zsr-device');
    const pick = S.devices.find((d) => d.id === S.deviceId) || S.devices.find((d) => d.id === remembered) || S.devices.find((d) => d.online) || S.devices[0];
    if (pick && pick.id !== S.deviceId) selectDevice(pick.id);
    renderPc();
    if (!$('device-list').closest('[data-view]').hidden) renderDevices();
  } else if (msg.type === 'state' && msg.deviceId === S.deviceId) {
    S.state = msg.state;
    render();
  } else if (msg.type === 'preview' && msg.deviceId === S.deviceId) {
    S.preview = msg;
    renderPreview();
  } else if (msg.type === 'result') {
    const p = S.pending.get(msg.id);
    S.pending.delete(msg.id);
    if (p) p(msg);
  }
}

function selectDevice(id) {
  S.deviceId = id;
  S.state = null;
  S.preview = null;
  store.set('zsr-device', id);
  send({ type: 'select', deviceId: id });
  if (S.watching) send({ type: 'watch', on: true });
  render();
}

/** Sends a command to the PC and waits for its answer. */
function command(action, args = {}, button = null) {
  return new Promise((resolve) => {
    if (!S.ws || S.ws.readyState !== 1) {
      toast('Not connected to the server.', 'Check your internet connection.', 'error');
      return resolve(false);
    }
    const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    if (button) button.classList.add('busy');
    S.pending.set(id, (res) => {
      if (button) button.classList.remove('busy');
      if (!res.ok) toast(res.error || 'The PC could not do that.', res.hint, 'error');
      resolve(res.ok);
    });
    send({ type: 'command', id, action, args });
  });
}

// ---- Dashboard -------------------------------------------------------------------------------

const current = () => S.devices.find((d) => d.id === S.deviceId);

function renderPc() {
  const d = current();
  const serverOk = !!(S.ws && S.ws.readyState === 1);
  $('pc-line').textContent = d ? d.name : S.devices.length ? '' : 'No PC paired yet';
  if (!serverOk) setPill($('pc-pill'), 'Server offline', 'bad');
  else if (!d) setPill($('pc-pill'), 'No PC');
  else setPill($('pc-pill'), d.online ? 'PC online' : 'PC offline', d.online ? 'ok' : 'bad');

  const banner = $('offline-banner');
  if (!serverOk) banner.textContent = 'Reconnecting to the server…';
  else if (!d) banner.textContent = S.me?.role === 'owner' ? 'No PC is paired yet. Open Admin → Add a PC.' : 'No PC is paired yet. Ask the owner to pair the stream PC.';
  else if (!d.online) banner.textContent = `${d.name} is offline${d.lastSeenAt ? ` (last seen ${timeText(d.lastSeenAt)})` : ''}. Make sure the PC is on, signed in and Zoom Stream Automation is open.`;
  banner.hidden = serverOk && !!d && d.online;

  const sel = $('pc-select');
  $('pc-select-row').hidden = S.devices.length < 2;
  sel.replaceChildren(...S.devices.map((x) => el('option', { value: x.id }, `${x.name}${x.online ? '' : ' (offline)'}`)));
  if (S.deviceId) sel.value = S.deviceId;
  render();
}
$('pc-select').onchange = (e) => selectDevice(e.target.value);

const STEP_MARK = { done: '✓', failed: '✕', running: '…', waiting: '…', skipped: '–', pending: '○' };
const ZOOM_TEXT = { connected: ['Connected', 'ok'], disconnected: ['Not running', 'bad'], not_installed: ['Not installed', 'bad'], unknown: ['Checking…', ''] };

function render() {
  const online = !!current()?.online && !!S.ws;
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
  else if (wf.stream.phase === 'sharing') setPill($('stream-pill'), 'Sharing', 'ok');
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

function renderPreview() {
  const p = S.preview;
  const selected = S.state?.images?.selectedName;
  const ok = p && p.dataUrl && p.name === selected;
  $('preview').hidden = !ok;
  $('preview-empty').hidden = !!ok;
  if (ok && $('preview').src !== p.dataUrl) $('preview').src = p.dataUrl;
}

$('btn-start').onclick = (e) => command('startStream', {}, e.currentTarget);
$('btn-end').onclick = async (e) => {
  const btn = e.currentTarget;
  if (await confirmDialog('End the stream?', 'This stops the YouTube live stream and sharing, ends the Zoom meeting for everyone and closes Zoom.', 'End Stream')) command('endStream', {}, btn);
};
$('btn-cancel').onclick = (e) => command('cancel', {}, e.currentTarget);
$('btn-live').onclick = (e) => command('confirmLive', {}, e.currentTarget);
$('btn-dismiss').onclick = (e) => command('dismissError', {}, e.currentTarget);
$('btn-share-image').onclick = (e) => command('shareImage', {}, e.currentTarget);
$('btn-share-screen').onclick = (e) => command('shareScreen', {}, e.currentTarget);
$('btn-stop-share').onclick = (e) => command('stopShare', {}, e.currentTarget);
$('btn-next-image').onclick = (e) => command('nextImage', {}, e.currentTarget);
$('image-select').onchange = (e) => e.target.value && command('selectImage', { name: e.target.value });
$('btn-open-zoom').onclick = (e) => command('openZoom', {}, e.currentTarget);
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

function setWatching(on) {
  S.watching = on;
  send({ type: 'watch', on });
  $('screen-box').hidden = !on;
  $('btn-watch').textContent = on ? 'Hide live screen' : 'Show live screen';
  setPill($('screen-pill'), on ? 'Waiting…' : 'Off', on ? 'busy' : '');
  if (!on && S.frameUrl) {
    URL.revokeObjectURL(S.frameUrl);
    S.frameUrl = null;
    $('screen').removeAttribute('src');
  }
}

function showFrame(blob) {
  if (!S.watching) return;
  const url = URL.createObjectURL(blob);
  const old = S.frameUrl;
  S.frameUrl = url;
  $('screen').src = url;
  if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);
  setPill($('screen-pill'), `Live · ${clockText(new Date().toISOString())}`, 'ok');
}

$('btn-watch').onclick = () => setWatching(!S.watching);
document.addEventListener('visibilitychange', () => {
  if (document.hidden && S.watching) setWatching(false); // Don't stream the screen to a phone in the pocket.
});

// ---- Admin -----------------------------------------------------------------------------------

// ---- Download page ---------------------------------------------------------------------------

const KIND_TEXT = {
  setup: ['Download installer', 'Recommended. Installs the app and adds it to the Start menu; updates keep your settings.'],
  portable: ['Download portable', 'Runs without installing (for example from a USB drive).'],
};

const sizeText = (bytes) => `${(bytes / 1048576).toFixed(0)} MB`;

async function loadDownloads() {
  $('dl-files').replaceChildren();
  $('dl-version').textContent = '…';
  try {
    const { version, files } = await api('GET', '/api/downloads');
    $('dl-version').textContent = version ? `Version ${version}` : '—';
    $('dl-empty').hidden = files.length > 0;
    $('dl-files').replaceChildren(
      ...files.map((f) => {
        const [label, note] = KIND_TEXT[f.kind] || ['Download', ''];
        return el(
          'div',
          { class: 'dl-item' },
          el('a', { class: `btn block${f.kind === 'setup' ? ' primary' : ''}`, href: f.url, download: f.name }, `${label} (${sizeText(f.size)})`),
          el('span', { class: 'muted small' }, `${note} ${f.name}, added ${timeText(f.updatedAt)}.`),
        );
      }),
    );
  } catch (err) {
    $('dl-version').textContent = '—';
    toast(err.message, '', 'error');
  }
}

async function loadAdmin() {
  try {
    const [{ users, invites }, { entries }] = await Promise.all([api('GET', '/api/users'), api('GET', '/api/audit')]);
    renderUsers(users, invites);
    $('audit-list').replaceChildren(...entries.map((a) => el('li', {}, el('time', {}, timeText(a.at)), `${a.actor} — ${a.action}${a.detail ? `: ${a.detail}` : ''}`)));
    renderDevices();
  } catch (err) {
    toast(err.message, '', 'error');
  }
}

function renderUsers(users, invites) {
  $('user-list').replaceChildren(
    ...users.map((u) =>
      el(
        'li',
        {},
        el('div', {}, el('span', {}, u.email), el('span', { class: 'muted small' }, u.role === 'owner' ? 'Owner' : 'Client')),
        u.id === S.me.id
          ? el('span', { class: 'muted small' }, 'You')
          : el('button', {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                if (!(await confirmDialog('Remove this person?', `${u.email} will be signed out and can no longer sign in.`, 'Remove'))) return;
                await api('DELETE', `/api/users/${u.id}`).catch((err) => toast(err.message, '', 'error'));
                loadAdmin();
              },
            }, 'Remove'),
      ),
    ),
    ...invites.map((i) =>
      el(
        'li',
        {},
        el('div', {}, el('span', {}, i.email), el('span', { class: 'muted small' }, `Invited (${i.role}) · expires ${timeText(i.expiresAt)}`)),
        el('button', {
          class: 'btn small',
          type: 'button',
          onclick: async () => {
            await api('DELETE', `/api/invites/${i.id}`).catch((err) => toast(err.message, '', 'error'));
            loadAdmin();
          },
        }, 'Cancel'),
      ),
    ),
  );
}

function renderDevices() {
  $('device-list').replaceChildren(
    ...(S.devices.length
      ? S.devices.map((d) =>
          el(
            'li',
            {},
            el('div', {}, el('span', {}, d.name), el('span', { class: 'muted small' }, d.online ? `Online${d.version ? ` · app v${d.version}` : ''}` : `Offline${d.lastSeenAt ? ` · last seen ${timeText(d.lastSeenAt)}` : ''}`)),
            el('button', {
              class: 'btn small',
              type: 'button',
              onclick: async () => {
                if (!(await confirmDialog('Remove this PC?', `${d.name} will be disconnected. To use it again, pair it with a new code.`, 'Remove'))) return;
                await api('DELETE', `/api/devices/${d.id}`).catch((err) => toast(err.message, '', 'error'));
              },
            }, 'Remove'),
          ),
        )
      : [el('li', { class: 'muted' }, 'No PC paired yet.')]),
  );
}

$('btn-pair').onclick = async () => {
  try {
    const { code, expiresAt } = await api('POST', '/api/devices/pairing-code');
    $('pair-code').textContent = code;
    $('pair-expiry').textContent = `Valid until ${clockText(expiresAt)}. Website address: ${location.origin}`;
    $('pair-box').hidden = false;
  } catch (err) {
    toast(err.message, '', 'error');
  }
};

bindForm('invite-user-form', async (v, form) => {
  const res = await api('POST', '/api/invites', { email: v.email, role: v.role });
  $('invite-link').value = res.link;
  $('invite-days').textContent = res.expiresInDays;
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
  await api('POST', '/api/password', { current: v.current, next: v.next });
  form.reset();
  toast('Password changed.');
});

// ---- Start -----------------------------------------------------------------------------------

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
route();
