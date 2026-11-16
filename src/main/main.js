'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const os = require('os');
const { app, BrowserWindow, protocol, net, dialog, safeStorage, desktopCapturer, screen, nativeImage, Tray, Menu } = require('electron');

const { ConfigStore } = require('../services/config/configStore');
const { Logger } = require('../services/logging/logger');
const { UiaClient } = require('../services/zoom/uiaClient');
const { ZoomService } = require('../services/zoom/zoomService');
const { YouTubeLiveService } = require('../services/youtube/youtubeLive');
const { SchedulerService } = require('../services/scheduler/scheduler');
const { SCHEDULED_ARG, WAKE_TEST_ARG, WAKE_TEST_TASK, deleteTask } = require('../services/scheduler/windowsTask');
const { lastResume, isSessionLocked, systemPowerInfo, confirmBiosPowerOn } = require('../services/power/powerActions');
const { listImages, isInsideFolder } = require('../services/images/imageService');
const { StreamWorkflow } = require('../services/streaming/workflow');
const { ImageWindow } = require('./imageWindow');
const { registerIpc } = require('./ipc');
const { createActions } = require('./actions');
const { RemoteClient, remoteState } = require('./remote');

const APP_ID = 'com.zoomstreamautomation.app';
const LOGIN_ITEM_NAME = 'ZoomStreamAutomation';
const STARTUP_ARG = '--startup';
const REMOVE_DATA_MARKER = 'remove-data-on-uninstall';

app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  // Another instance owns the app; it receives our argv through 'second-instance'.
  app.quit();
} else {
  protocol.registerSchemesAsPrivileged([{ scheme: 'zsa-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
  app.whenReady().then(init);
}

const ctx = {
  mainWindow: null,
  store: null,
  logger: null,
  uia: null,
  zoom: null,
  youtube: null,
  scheduler: null,
  workflow: null,
  imageWindow: null,
  remote: null,
  zoomStatus: { installed: false, running: false, inMeeting: false, sharingDetected: false, status: 'unknown' },
  images: { folder: '', count: 0, skipped: 0, error: null },
  updateStatus: { checking: false, error: '', checkedThisSession: false, installing: false, received: 0, total: 0, downloadSize: 0 },
  pushTimer: null,
};

function isPortable() {
  return !!process.env.PORTABLE_EXECUTABLE_FILE;
}

function uninstallerPath() {
  if (!app.isPackaged || isPortable()) return null;
  const p = path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`);
  return fs.existsSync(p) ? p : null;
}

/** The command Windows should run to launch this app (installed, portable or development). */
function launchCommand(extraArg) {
  if (app.isPackaged) {
    return { command: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: extraArg, argList: [extraArg] };
  }
  const appPath = app.getAppPath();
  return { command: process.execPath, args: `"${appPath}" ${extraArg}`, argList: [appPath, extraArg] };
}

function applyLoginItem(enabled) {
  const { command, argList } = launchCommand(STARTUP_ARG);
  app.setLoginItemSettings({ openAtLogin: !!enabled, path: command, args: argList, name: LOGIN_ITEM_NAME });
}

function refreshImages() {
  const folder = ctx.store.get().streaming.imageFolderPath;
  const { images, skipped, error } = folder ? listImages(folder) : { images: [], skipped: 0, error: null };
  ctx.images = { folder, count: images.length, skipped, error, list: images };
  const selected = ctx.store.get().streaming.selectedImagePath;
  if (selected && !images.includes(selected)) {
    ctx.store.update((c) => {
      c.streaming.selectedImagePath = '';
    });
  }
}

function buildState() {
  const c = ctx.store.get();
  const selected = c.streaming.selectedImagePath;
  return {
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      portable: isPortable(),
      uninstallerAvailable: !!uninstallerPath(),
      configPath: ctx.store.file,
      logDir: path.join(app.getPath('userData'), 'logs'),
      notice: ctx.store.recoveryNote,
    },
    settings: {
      meetingName: c.zoom.meetingName,
      meetingLink: c.zoom.meetingLink,
      zoomPath: c.zoom.executablePath,
      defaultMode: c.streaming.defaultMode,
      openMeetingIfNeeded: c.streaming.openMeetingIfNeeded,
      goLiveOnYouTube: c.streaming.goLiveOnYouTube,
      youtubeAccountEmail: c.streaming.youtubeAccountEmail,
      youtubeStudioUrl: c.streaming.youtubeStudioUrl,
      youtubeProfile: youtubeProfileInfo(c.streaming.youtubeAccountEmail),
      shareSound: c.streaming.shareSound,
      shareComputerAudio: c.streaming.shareComputerAudio,
      endMeetingAfterStream: c.streaming.endMeetingAfterStream,
      autoClickGoLive: c.streaming.autoClickGoLive,
      liveConfirmTimeoutMinutes: c.streaming.liveConfirmTimeoutMinutes,
      launchOnWindowsStartup: c.app.launchOnWindowsStartup,
      runInBackground: c.app.runInBackground,
      logRetention: c.app.logRetention,
      releaseManifestUrl: c.updates.releaseManifestUrl,
    },
    zoom: ctx.zoomStatus,
    workflow: ctx.workflow.state,
    images: {
      folder: ctx.images.folder,
      count: ctx.images.count,
      skipped: ctx.images.skipped,
      error: ctx.images.error,
      selectedPath: selected,
      selectedName: selected ? path.basename(selected) : '',
      previewUrl: selected ? `zsa-img://current/?v=${encodeURIComponent(selected)}` : '',
    },
    schedule: {
      enabled: c.schedule.enabled,
      date: c.schedule.date,
      time: c.schedule.time,
      timeZone: c.schedule.timeZone,
      repeat: c.schedule.repeat,
      selectedDays: c.schedule.selectedDays,
      streamingMode: c.schedule.streamingMode,
      autoStart: c.schedule.autoStart,
      requireConfirmation: c.schedule.requireConfirmation,
      info: ctx.scheduler.getInfo(),
    },
    updates: {
      currentVersion: app.getVersion(),
      latestVersion: c.updates.latestVersion,
      releaseNotes: c.updates.releaseNotes,
      downloadUrl: c.updates.downloadUrl,
      lastCheckedAt: c.updates.lastCheckedAt,
      manifestConfigured: true,
      customSource: !!c.updates.releaseManifestUrl,
      canInstall: app.isPackaged && !isPortable(),
      ...ctx.updateStatus,
    },
    power: { wakeTest: c.app.wakeTest, biosPowerOn: c.app.biosPowerOn },
    remote: ctx.remote ? ctx.remote.info() : { connection: 'off', paired: false, enabled: false, serverUrl: '', deviceName: '', error: '', watching: false },
    logs: c.logs.slice(-150),
  };
}

/** Pushes the full state to the renderer, coalescing bursts of changes. */
function pushState() {
  if (ctx.pushTimer) return;
  ctx.pushTimer = setTimeout(() => {
    ctx.pushTimer = null;
    if (ctx.mainWindow && !ctx.mainWindow.isDestroyed()) ctx.mainWindow.webContents.send('state', buildState());
    ctx.remote?.stateChanged();
    updateTray();
  }, 80);
}

async function pollZoom() {
  try {
    const status = await ctx.zoom.getStatus();
    const changed = status.status !== ctx.zoomStatus.status || status.inMeeting !== ctx.zoomStatus.inMeeting || status.sharingDetected !== ctx.zoomStatus.sharingDetected;
    ctx.zoomStatus = status;
    if (changed) {
      ctx.store.update((c) => {
        c.zoom.lastKnownStatus = status.status;
      });
      pushState();
    }
  } catch {
    // Status polling retries on the next interval.
  }
}

function createMainWindow({ hidden = false } = {}) {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    minWidth: 900,
    minHeight: 620,
    title: app.getName(),
    backgroundColor: '#f5f6f8',
    icon: path.join(__dirname, 'app-icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  if (!hidden) {
    win.once('ready-to-show', () => win.show());
    // Never leave an invisible window if the first paint is slow (e.g. antivirus scanning on first run).
    // Cancelled once the window was shown or hidden, so a window closed to the tray stays closed.
    const fallback = setTimeout(() => !win.isDestroyed() && !win.isVisible() && win.show(), 8000);
    win.once('show', () => clearTimeout(fallback));
    win.once('hide', () => clearTimeout(fallback));
  }
  // If the page crashes or fails to load, log it and reload instead of leaving a blank window.
  let reloads = 0;
  const recover = (why) => {
    ctx.logger?.error('app', `Window problem: ${why}.${reloads < 3 ? ' Reloading.' : ''}`);
    if (reloads++ < 3 && !win.isDestroyed()) setTimeout(() => !win.isDestroyed() && win.webContents.reload(), 1000);
  };
  win.webContents.on('render-process-gone', (_e, d) => recover(`page process ended (${d.reason})`));
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => isMainFrame && recover(`page failed to load (${code} ${desc})`));
  win.webContents.on('preload-error', (_e, file, err) => ctx.logger?.error('app', `Preload error: ${err.message}`));
  win.webContents.on('console-message', (_e, level, message) => level >= 3 && ctx.logger?.error('ui', message.slice(0, 500)));
  // The renderer never navigates or opens windows; external links go through IPC.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', (e) => {
    // Background mode: closing the window only hides it; the app keeps running in the tray.
    if (!ctx.isQuitting && ctx.store.get().app.runInBackground && tray) {
      e.preventDefault();
      win.hide();
      if (!ctx.trayHintShown) {
        ctx.trayHintShown = true;
        tray.displayBalloon({
          iconType: 'info',
          title: app.getName(),
          content: 'Still running in the background, so the website and schedule keep working. Right-click the tray icon to quit.',
        });
        ctx.logger.info('app', 'Window closed: the app keeps running in the background (system tray).');
      }
      return;
    }
    if (!ctx.workflow.state.busy) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Keep running', 'Quit anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'An automation is still running.',
      detail: 'Quitting now stops the automation midway. Zoom and any live stream keep running.',
    });
    if (choice === 0) e.preventDefault();
  });
  win.on('closed', () => {
    ctx.mainWindow = null;
    if (!tray || ctx.isQuitting || !ctx.store.get().app.runInBackground) app.quit();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', '..', 'renderer-dist', 'index.html'));
  return win;
}

// ---- YouTube browser profile ------------------------------------------------------------------

const { findProfile } = require('../services/youtube/browserProfile');
let profileCache = { email: null, at: 0, value: null };

/** Which Chrome/Edge profile is signed in as the YouTube account (checked at most every 30 s). */
function youtubeProfileInfo(email) {
  if (profileCache.email !== email || Date.now() - profileCache.at > 30000) {
    let p = null;
    try {
      p = findProfile(email);
    } catch {
      p = null;
    }
    profileCache = { email, at: Date.now(), value: p ? { browser: p.browser, profileName: p.profileName } : null };
  }
  return profileCache.value;
}

// ---- System tray (background mode) ---------------------------------------------------------

let tray = null;
let trayLabel = '';

function remoteLabel() {
  const r = ctx.remote ? ctx.remote.info() : null;
  if (!r || !r.paired) return 'Remote control: not paired';
  if (!r.enabled) return 'Remote control: off';
  return `Remote control: ${{ connected: 'connected', connecting: 'connecting…', error: 'not connected', off: 'off' }[r.connection] || r.connection}`;
}

function quitApp() {
  ctx.isQuitting = true;
  app.quit();
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'app-icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.on('click', showMainWindow);
    tray.on('double-click', showMainWindow);
    updateTray();
  } catch (err) {
    tray = null;
    ctx.logger.warn('app', `The tray icon could not be created (${err.message}); closing the window will quit the app.`);
  }
}

/** Refreshes the tray tooltip and menu when the remote status changes. */
function updateTray() {
  if (!tray) return;
  const label = remoteLabel();
  if (label === trayLabel) return;
  trayLabel = label;
  tray.setToolTip(`${app.getName()} – ${label}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Zoom Stream Automation', click: showMainWindow },
      { label, enabled: false },
      { type: 'separator' },
      { label: 'Quit (the website will show this PC offline)', click: quitApp },
    ]),
  );
}

/** Diagnostics ("--zsa-selftest-image"): opens the image window once with the selected image and logs the result. */
function imageSelfTest() {
  const img = ctx.store.get().streaming.selectedImagePath || (ctx.images.list || [])[0];
  ctx.imageWindow
    .show(img)
    .then(() => ctx.logger.success('image', `Self-test: image window opened (${path.basename(img || '')}).`))
    .catch((err) => ctx.logger.error('image', `Self-test: image window failed: ${err.code || ''} ${err.message.slice(0, 200)}`));
}

function handleArgs(argv, source) {
  if (argv.includes('--zsa-selftest-image') && ctx.imageWindow && source !== 'Windows Task Scheduler') imageSelfTest();
  if (argv.includes(SCHEDULED_ARG)) ctx.scheduler.handleLaunchTrigger(source);
  if (argv.includes(WAKE_TEST_ARG)) recordWakeTest(source).catch((err) => ctx.logger.error('power', `Wake test: ${err.message}`));
}

const WAKE_TEST_WINDOW_MS = 20 * 60000;

/** The wake-test task launched the app: record when, what woke the PC and whether the screen was locked. */
async function recordWakeTest(source) {
  const wt = ctx.store.get().app.wakeTest;
  if (wt.result !== 'pending') {
    ctx.logger.info('power', 'Wake test launch ignored: no wake test is running.');
    return;
  }
  const now = Date.now();
  const due = Date.parse(wt.scheduledFor);
  const [locked, resume] = await Promise.all([isSessionLocked(), lastResume()]);
  const offset = Math.round((now - due) / 1000);
  const onTime = now >= due - 60000 && now - due <= WAKE_TEST_WINDOW_MS;
  // Proof the PC was really off/asleep: it resumed or booted after the test started.
  const started = Date.parse(wt.startedAt);
  const resumedAt = Date.parse(resume.resumedAt) || 0;
  const bootAt = Date.parse(resume.bootAt) || 0;
  const woke = resumedAt > started || bootAt > started;
  const wakeSource = (resume.wakeSource || '').trim();
  const detail = [
    `Started by ${source} ${offset >= 0 ? `${offset} s after` : `${-offset} s before`} the test time.`,
    woke
      ? `The PC ${bootAt > started ? 'booted' : 'resumed'} at ${new Date(Math.max(resumedAt, bootAt)).toLocaleTimeString()}${wakeSource ? ` (wake source: ${wakeSource})` : ''}.`
      : 'The PC did not sleep or hibernate after the test started, so this run does not prove it can power on by itself.',
    locked
      ? 'The screen was LOCKED: Windows asked for sign-in, so the app could not have controlled Zoom. Set sign-in after sleep to "Never".'
      : 'The screen was unlocked, so the app could control Zoom.',
  ].join(' ');
  const passed = onTime && woke;
  ctx.store.update((c) => {
    c.app.wakeTest = { ...c.app.wakeTest, wokeAt: new Date(now).toISOString(), result: passed ? 'passed' : 'failed', detail };
  });
  await deleteTask(WAKE_TEST_TASK).catch(() => {});
  if (passed && !locked) ctx.logger.success('power', `Wake test passed. ${detail}`);
  else ctx.logger.warn('power', `Wake test ${passed ? 'woke the PC but found a problem' : 'did not prove a wake-up'}. ${detail}`);
  showMainWindow();
  pushState();
}

/** A wake test that never reported back means the PC did not wake (or the app did not start). */
function expireWakeTest() {
  const wt = ctx.store.get().app.wakeTest;
  if (wt.result !== 'pending' || Date.now() - Date.parse(wt.scheduledFor) <= WAKE_TEST_WINDOW_MS) return;
  ctx.store.update((c) => {
    c.app.wakeTest = {
      ...c.app.wakeTest,
      result: 'failed',
      detail: 'The PC did not start the app within 20 minutes of the test time, so it most likely did not wake from hibernate/sleep by itself. Check wake timers, or that your PC supports waking from hibernate.',
    };
  });
  deleteTask(WAKE_TEST_TASK).catch(() => {});
  ctx.logger.warn('power', 'Wake test failed: the PC did not wake at the test time.');
}

async function init() {
  const userData = app.getPath('userData');
  fs.rmSync(path.join(userData, REMOVE_DATA_MARKER), { force: true });

  ctx.store = new ConfigStore(userData, app.getVersion());
  ctx.store.load();
  ctx.logger = new Logger(ctx.store, path.join(userData, 'logs'));
  ctx.logger.onEntry(() => pushState());
  if (ctx.store.recoveryNote) ctx.logger.warn('config', ctx.store.recoveryNote);

  const bundledHelper = app.isPackaged ? path.join(process.resourcesPath, 'resources', 'zoom-uia.ps1') : path.join(__dirname, '..', '..', 'resources', 'zoom-uia.ps1');
  // Run the automation helper from a copy in the settings folder: the portable build's Temp files can be
  // deleted and re-unpacked by another launch of the exe while this copy is running.
  let helperScript = bundledHelper;
  try {
    const copy = path.join(userData, 'zoom-uia.ps1');
    fs.copyFileSync(bundledHelper, copy);
    helperScript = copy;
  } catch {
    // Fall back to the bundled script.
  }
  ctx.uia = new UiaClient(helperScript, ctx.logger);
  ctx.zoom = new ZoomService({ uia: ctx.uia, store: ctx.store, logger: ctx.logger });
  ctx.youtube = new YouTubeLiveService({ zoom: ctx.zoom, logger: ctx.logger });
  ctx.imageWindow = new ImageWindow(ctx.logger);
  ctx.workflow = new StreamWorkflow({
    store: ctx.store,
    logger: ctx.logger,
    zoom: ctx.zoom,
    youtube: ctx.youtube,
    imageWindow: ctx.imageWindow,
    onChange: () => pushState(),
  });
  ctx.scheduler = new SchedulerService({
    store: ctx.store,
    logger: ctx.logger,
    getLaunchCommand: () => launchCommand(SCHEDULED_ARG),
    onDue: (run) => {
      showMainWindow();
      ctx.workflow.handleScheduledRun(run);
    },
  });

  protocol.handle('zsa-img', () => {
    const c = ctx.store.get();
    const file = c.streaming.selectedImagePath;
    if (!isInsideFolder(file, c.streaming.imageFolderPath) || !fs.existsSync(file)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // Create the (hidden) image window now, while the app's files are certainly in place.
  ctx.imageWindow.prepare().catch((err) => ctx.logger.warn('image', `Image window could not be prepared: ${err.message}`));

  refreshImages();
  // Once a PC is paired with the website, start the app (hidden) at Windows sign-in so the PC is reachable
  // after a restart. Done once; the user can turn it off again in the Remote tab.
  {
    const c = ctx.store.get();
    if (!c.app.backgroundStartupApplied && c.remote.deviceId && c.remote.serverUrl) {
      ctx.store.update((cfg) => {
        cfg.app.launchOnWindowsStartup = true;
        cfg.app.backgroundStartupApplied = true;
      });
      ctx.logger.info('app', 'This PC is paired with the website: the app now starts in the background at Windows sign-in.');
    }
  }
  applyLoginItem(ctx.store.get().app.launchOnWindowsStartup);

  const actions = createActions({ ctx, refreshImages });
  ctx.remote = createRemote(actions);
  registerIpc({ ctx, actions, remote: ctx.remote, buildState, pushState, refreshImages, applyLoginItem, uninstallerPath, removeDataMarker: path.join(userData, REMOVE_DATA_MARKER), launchCommand });

  createTray();
  // Started at Windows sign-in: stay in the tray (no window) when background mode is on.
  const startHidden = process.argv.includes(STARTUP_ARG) && !!tray && ctx.store.get().app.runInBackground;
  ctx.mainWindow = createMainWindow({ hidden: startHidden });
  ctx.logger.info('app', `Started v${app.getVersion()}${process.argv.includes(SCHEDULED_ARG) ? ' by Windows Task Scheduler' : process.argv.includes(STARTUP_ARG) ? ' at Windows sign-in' : ''}${startHidden ? ', running in the background (tray)' : ''}.`);

  ctx.mainWindow.webContents.on('did-finish-load', () => pushState());
  app.on('second-instance', (_e, argv) => {
    showMainWindow();
    handleArgs(argv, 'Windows Task Scheduler (app already open)');
  });

  ctx.scheduler.start();
  ctx.remote.start();
  // Look for a newer version shortly after start and twice a day (quietly; the Update tab shows the result).
  setTimeout(() => ctx.checkUpdates?.({ quiet: true }), 30000);
  setInterval(() => ctx.checkUpdates?.({ quiet: true }), 12 * 3600000);
  if (!process.argv.includes(WAKE_TEST_ARG)) expireWakeTest();
  handleArgs(process.argv, 'Windows Task Scheduler');

  // Confirm a BIOS automatic power-on once Windows has settled after boot.
  if (ctx.store.get().app.biosPowerOn.time) {
    setTimeout(() => {
      systemPowerInfo()
        .then((info) => confirmBiosPowerOn({ store: ctx.store, logger: ctx.logger, info }) && pushState())
        .catch(() => {});
    }, 20000);
  }

  if (process.argv.includes('--zsa-selftest-image')) imageSelfTest();

  await pollZoom();
  setInterval(pollZoom, 4000);
  setInterval(() => {
    refreshImages();
    expireWakeTest();
    pushState();
  }, 30000);
  setInterval(() => ctx.scheduler.refreshTaskInfo().then(pushState), 60000);
}

// ---- Remote control website -----------------------------------------------------------------

/** The PC's device token, encrypted by Windows for this user account (never stored in config.json). */
function remoteTokenStore() {
  const file = path.join(app.getPath('userData'), 'remote-device.bin');
  let cached = null;
  return {
    read() {
      if (cached !== null) return cached;
      try {
        cached = fs.existsSync(file) && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(fs.readFileSync(file)) : '';
      } catch {
        cached = '';
      }
      return cached;
    },
    write(token) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows encryption is not available, so the remote token cannot be stored safely.');
      fs.writeFileSync(file, safeStorage.encryptString(token));
      cached = token;
    },
    clear() {
      fs.rmSync(file, { force: true });
      cached = '';
    },
  };
}

/**
 * One frame of the main screen as JPEG, at most 960 px wide. Kept small because every frame is downloaded
 * by the phone through Firebase (the free plan includes 10 GB of downloads a month).
 */
async function captureScreenJpeg() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = Math.min(1, 960 / width);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
  const src = sources.find((x) => x.display_id === String(primary.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) return null;
  const jpeg = src.thumbnail.toJPEG(50);
  return jpeg.length > 400000 ? src.thumbnail.toJPEG(30) : jpeg;
}

/** Small JPEG of the image that will be shared, for the website's preview. */
function previewDataUrl() {
  const c = ctx.store.get().streaming;
  if (!c.selectedImagePath || !isInsideFolder(c.selectedImagePath, c.imageFolderPath)) return '';
  const img = nativeImage.createFromPath(c.selectedImagePath);
  if (img.isEmpty()) return '';
  const { width } = img.getSize();
  const small = width > 640 ? img.resize({ width: 640, quality: 'good' }) : img;
  let jpeg = small.toJPEG(70);
  if (jpeg.length > 200000) jpeg = (width > 480 ? img.resize({ width: 480, quality: 'good' }) : small).toJPEG(55);
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

const REMOTE_LABELS = {
  startStream: 'Start Stream', endStream: 'End Stream', cancel: 'Cancel', confirmLive: "I'm live", openZoom: 'Open Zoom meeting',
  shareImage: 'Share Image', shareScreen: 'Share Screen', stopShare: 'Stop Share', nextImage: 'Random image', selectImage: 'Choose image',
  setSchedule: 'Save schedule', dismissError: 'Dismiss error',
};

function createRemote(actions) {
  const commands = {
    startStream: (_a, by) => actions.startStream(ctx.store.get().streaming.defaultMode, `the website (${by})`),
    endStream: () => actions.endStream(),
    cancel: () => actions.cancel(),
    confirmLive: () => actions.confirmLive(),
    openZoom: (_a, by) => actions.openZoom(`the website (${by})`),
    shareImage: () => actions.shareImage(),
    shareScreen: () => actions.shareScreen(),
    stopShare: () => actions.stopShare(),
    nextImage: () => actions.pickRandomImage(),
    selectImage: (a) => actions.selectImageByName(String(a.name || '')),
    setSchedule: (a) => actions.saveDailySchedule({ time: a.time, enabled: a.enabled }),
    dismissError: () => actions.dismissError(),
  };
  return new RemoteClient({
    store: ctx.store,
    logger: ctx.logger,
    tokenStore: remoteTokenStore(),
    appVersion: app.getVersion(),
    defaultName: os.hostname(),
    fetchImpl: (url, opts) => net.fetch(url, opts),
    getState: () => {
      const full = buildState();
      full.images.names = (ctx.images.list || []).map((f) => path.basename(f));
      return remoteState(full);
    },
    runCommand: async (action, args, by) => {
      const fn = commands[action];
      if (!fn) throw new Error('This app version does not support that command. Update the desktop app.');
      ctx.logger.info('remote', `${by} pressed "${REMOTE_LABELS[action] || action}" on the website.`);
      const res = await fn(args, by);
      pushState();
      return res;
    },
    captureFrame: captureScreenJpeg,
    makePreview: previewDataUrl,
    onChange: () => pushState(),
  });
}

function showMainWindow() {
  if (!ctx.mainWindow) ctx.mainWindow = createMainWindow();
  if (ctx.mainWindow.isMinimized()) ctx.mainWindow.restore();
  ctx.mainWindow.show();
  ctx.mainWindow.focus();
}

app.on('window-all-closed', () => {
  if (!tray || ctx.isQuitting || !ctx.store?.get().app.runInBackground) app.quit();
});

app.on('before-quit', () => {
  ctx.isQuitting = true;
  try {
    ctx.scheduler?.stop();
    ctx.remote?.stop();
    ctx.uia?.stop();
    ctx.imageWindow?.destroy();
    ctx.store?.saveNow();
  } catch {
    // Best-effort shutdown.
  }
});
