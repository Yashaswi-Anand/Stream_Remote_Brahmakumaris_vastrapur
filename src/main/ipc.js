'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { app, ipcMain, dialog, shell, net, powerMonitor } = require('electron');
const { checkWakeReadiness } = require('../services/power/wakeCheck');
const { hibernate, biosCapability, describeBios, systemPowerInfo, restartToFirmware, openWindowsPage, confirmBiosPowerOn } = require('../services/power/powerActions');
const { WAKE_TEST_ARG, WAKE_TEST_TASK, registerWakeTest, deleteTask } = require('../services/scheduler/windowsTask');
const { MODES, BIOS_REPEATS } = require('../services/config/schema');
const { pickRandom, listImages } = require('../services/images/imageService');
const { compareVersions, fetchManifest, isHttpsUrl, isReleaseAsset, DEFAULT_UPDATE_SOURCE } = require('../services/updates/updateService');

const isBool = (v) => typeof v === 'boolean';
const isInt = (min, max) => (v) => Number.isInteger(v) && v >= min && v <= max;

/** Settings the renderer may change, with a validator and the config location of each. */
const EDITABLE_SETTINGS = {
  biosPowerOnTime: { valid: (v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), set: (c, v) => (c.app.biosPowerOn.time = v) },
  biosPowerOnRepeat: { valid: (v) => BIOS_REPEATS.includes(v), set: (c, v) => (c.app.biosPowerOn.repeat = v) },
  meetingName: { valid: (v) => typeof v === 'string' && v.length <= 200, set: (c, v) => (c.zoom.meetingName = v.trim()) },
  meetingLink: { valid: (v) => typeof v === 'string' && v.length <= 500, set: (c, v) => (c.zoom.meetingLink = /^[\d\s-]+$/.test(v.trim()) ? v.replace(/[\s-]/g, '') : v.trim()) },
  defaultMode: { valid: (v) => MODES.includes(v), set: (c, v) => (c.streaming.defaultMode = v) },
  openMeetingIfNeeded: { valid: isBool, set: (c, v) => (c.streaming.openMeetingIfNeeded = v) },
  goLiveOnYouTube: { valid: isBool, set: (c, v) => (c.streaming.goLiveOnYouTube = v) },
  youtubeStudioUrl: {
    valid: (v) => typeof v === 'string' && (v.trim() === '' || /^https:\/\/studio\.youtube\.com\/channel\/UC[\w-]{20,24}\/livestreaming\/?$/.test(v.trim())),
    set: (c, v) => (c.streaming.youtubeStudioUrl = v.trim()),
  },
  youtubeAccountEmail: { valid: (v) => typeof v === 'string' && (v.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim())) && v.length <= 254, set: (c, v) => (c.streaming.youtubeAccountEmail = v.trim()) },
  shareSound: { valid: isBool, set: (c, v) => (c.streaming.shareSound = v) },
  shareComputerAudio: { valid: isBool, set: (c, v) => (c.streaming.shareComputerAudio = v) },
  endMeetingAfterStream: { valid: isBool, set: (c, v) => (c.streaming.endMeetingAfterStream = v) },
  autoClickGoLive: { valid: isBool, set: (c, v) => (c.streaming.autoClickGoLive = v) },
  liveConfirmTimeoutMinutes: { valid: isInt(1, 30), set: (c, v) => (c.streaming.liveConfirmTimeoutMinutes = v) },
  launchOnWindowsStartup: { valid: isBool, set: (c, v) => (c.app.launchOnWindowsStartup = v) },
  runInBackground: { valid: isBool, set: (c, v) => (c.app.runInBackground = v) },
  logRetention: { valid: isInt(20, 5000), set: (c, v) => (c.app.logRetention = v) },
  releaseManifestUrl: { valid: (v) => v === '' || (typeof v === 'string' && v.length <= 1000 && isHttpsUrl(v)), set: (c, v) => (c.updates.releaseManifestUrl = v) },
};

function registerIpc({ ctx, actions, remote, buildState, pushState, refreshImages, refreshSongs, applyLoginItem, uninstallerPath, removeDataMarker, launchCommand }) {
  const { store, logger } = ctx;

  /** Wraps a handler so failures reach the renderer as { ok: false, error } instead of rejections. */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!ctx.mainWindow || event.sender !== ctx.mainWindow.webContents) return { ok: false, error: 'Unauthorized sender.' };
      try {
        const result = await fn(...args);
        pushState();
        return result && typeof result === 'object' && 'ok' in result ? result : { ok: true, result };
      } catch (err) {
        pushState();
        return { ok: false, error: err.message, hint: err.hint || '' };
      }
    });

  handle('state:get', async () => ({ ok: true, state: buildState() }));

  // ---- Zoom --------------------------------------------------------------------------------
  handle('zoom:open', async () => actions.openZoom('user'));
  handle('zoom:locate', async () => {
    const res = await dialog.showOpenDialog(ctx.mainWindow, { title: 'Locate Zoom.exe', properties: ['openFile'], filters: [{ name: 'Zoom', extensions: ['exe'] }] });
    if (res.canceled || !res.filePaths[0]) return { ok: true, cancelled: true };
    const file = res.filePaths[0];
    if (!/^zoom\.exe$/i.test(path.basename(file))) return { ok: false, error: 'Please choose Zoom.exe.' };
    store.update((c) => {
      c.zoom.executablePath = file;
    });
    logger.info('zoom', `Zoom location set to ${file}.`);
  });
  handle('zoom:diagnostics', async () => {
    const dump = await ctx.zoom.dump();
    const dir = path.join(app.getPath('userData'), 'diagnostics');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `zoom-ui-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    const header = `Zoom UI snapshot ${new Date().toISOString()}\nWindows:\n${JSON.stringify(dump.windows, null, 2)}\n\nUI Automation tree:\n`;
    fs.writeFileSync(file, header + dump.text, 'utf8');
    logger.info('diagnostics', `Saved Zoom UI snapshot to ${file}.`);
    shell.showItemInFolder(file);
    return { ok: true, file };
  });

  // ---- Streaming ---------------------------------------------------------------------------
  handle('stream:start', async (mode) => actions.startStream(mode, 'user'));
  handle('stream:end', async () => actions.endStream());
  handle('stream:cancel', async () => actions.cancel());
  handle('stream:confirmLive', async () => actions.confirmLive());
  handle('share:image', async () => actions.shareImage());
  handle('share:screen', async () => actions.shareScreen());
  handle('share:stop', async () => actions.stopShare());
  handle('workflow:dismissError', async () => actions.dismissError());

  // ---- Images ------------------------------------------------------------------------------
  handle('images:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(ctx.mainWindow, { title: 'Choose image folder', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: true, cancelled: true };
    store.update((c) => {
      c.streaming.imageFolderPath = res.filePaths[0];
      c.streaming.selectedImagePath = '';
    });
    refreshImages();
    if (ctx.images.list.length) {
      const chosen = pickRandom(ctx.images.list, '');
      store.update((c) => {
        c.streaming.selectedImagePath = chosen;
      });
    }
    logger.info('images', `Image folder set to ${res.filePaths[0]} (${ctx.images.count} image(s)${ctx.images.skipped ? `, ${ctx.images.skipped} invalid skipped` : ''}).`);
  });
  handle('images:pickRandom', async () => actions.pickRandomImage());
  handle('images:chooseImage', async () => {
    const folder = store.get().streaming.imageFolderPath;
    const res = await dialog.showOpenDialog(ctx.mainWindow, {
      title: 'Choose the image to share',
      defaultPath: folder || undefined,
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: true, cancelled: true };
    const file = res.filePaths[0];
    const dir = path.dirname(file);
    // Same checks as the folder scan: right extension and real image contents.
    const { images } = listImages(dir);
    if (!images.includes(file)) throw new Error('That file is not a valid PNG, JPG, JPEG or WebP image.');
    const folderChanged = path.resolve(dir).toLowerCase() !== path.resolve(folder || '.').toLowerCase();
    store.update((c) => {
      c.streaming.imageFolderPath = dir;
      c.streaming.selectedImagePath = file;
    });
    refreshImages();
    logger.info('images', `Selected image: ${path.basename(file)}${folderChanged ? ` (image folder is now ${dir})` : ''}.`);
  });
  handle('images:refresh', async () => refreshImages());

  // ---- Start Stream checklist and music ----------------------------------------------------
  handle('steps:set', async (steps) => actions.setStartSteps(steps));
  handle('music:chooseFolder', async () => {
    const res = await dialog.showOpenDialog(ctx.mainWindow, { title: 'Choose music folder', properties: ['openDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { ok: false };
    store.update((c) => {
      c.streaming.musicFolderPath = res.filePaths[0];
      c.streaming.selectedMusicPath = '';
      c.streaming.musicSource = 'folder';
    });
    refreshSongs();
    logger.info('music', `Music folder set to ${res.filePaths[0]} (${ctx.songs.count} song(s)${ctx.songs.skipped ? `, ${ctx.songs.skipped} invalid skipped` : ''}).`);
    return { ok: true };
  });
  handle('music:play', async () => actions.playMusic());
  handle('music:stop', async () => actions.stopMusic());
  handle('music:pickRandom', async () => actions.pickRandomSong());
  handle('music:selectSong', async (name) => {
    if (typeof name !== 'string' || name.length > 260) throw new Error('Invalid song.');
    return actions.selectSongByName(name);
  });
  handle('music:setSource', async (source) => actions.setMusicSource(source));
  handle('music:setYoutubeUrl', async (url) => {
    if (typeof url !== 'string' || url.length > 300) throw new Error('Invalid link.');
    return actions.setMusicYoutubeUrl(url);
  });

  // ---- Settings ----------------------------------------------------------------------------
  handle('settings:update', async (patch) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
    for (const [key, value] of Object.entries(patch)) {
      const def = EDITABLE_SETTINGS[key];
      if (!def) throw new Error(`Unknown setting "${key}".`);
      if (!def.valid(value)) throw new Error(`Invalid value for "${key}".`);
    }
    store.update((c) => {
      for (const [key, value] of Object.entries(patch)) EDITABLE_SETTINGS[key].set(c, value);
    });
    if ('runInBackground' in patch) logger.info('app', `Keep running in the background when the window is closed: ${patch.runInBackground ? 'on' : 'off'}.`);
    if ('launchOnWindowsStartup' in patch) {
      applyLoginItem(patch.launchOnWindowsStartup);
      logger.info('app', `Launch on Windows sign-in ${patch.launchOnWindowsStartup ? 'enabled' : 'disabled'}.`);
    }
  });

  // ---- Schedule ----------------------------------------------------------------------------
  handle('schedule:save', async (input) => {
    if (!input || typeof input !== 'object') throw new Error('Invalid schedule.');
    return ctx.scheduler.save(input);
  });
  handle('schedule:setEnabled', async (enabled) => {
    if (!isBool(enabled)) throw new Error('Invalid value.');
    return ctx.scheduler.setEnabled(enabled);
  });
  handle('schedule:delete', async () => ctx.scheduler.remove());
  handle('schedule:wakeCheck', async () => {
    await ctx.scheduler.refreshTaskInfo().catch(() => null);
    const bios = describeBios(await biosCapability());
    return checkWakeReadiness({ onBattery: powerMonitor.isOnBatteryPower(), task: ctx.scheduler.getInfo().task, bios, wakeTest: store.get().app.wakeTest });
  });

  // ---- Power: wake test and hibernate -------------------------------------------------------
  // Hibernate saves the session to disk and powers off; Windows can power the PC back on for a
  // scheduled task when the firmware supports waking from hibernate. The wake test proves it on this PC.
  handle('power:wakeTest', async (minutes, thenHibernate) => {
    if (!Number.isInteger(minutes) || minutes < 2 || minutes > 30) throw new Error('Choose 2 to 30 minutes.');
    if (!isBool(thenHibernate)) throw new Error('Invalid value.');
    if (ctx.workflow.state.busy || ctx.workflow.state.stream.live) throw new Error('Finish or end the current stream before testing wake.');
    const at = Math.ceil((Date.now() + minutes * 60000) / 60000) * 60000;
    const { command, args } = launchCommand(WAKE_TEST_ARG);
    await registerWakeTest(at, command, args);
    store.update((c) => {
      c.app.wakeTest = { scheduledFor: new Date(at).toISOString(), startedAt: new Date().toISOString(), wokeAt: '', result: 'pending', detail: thenHibernate ? 'Hibernating now; the PC should power on at the test time.' : 'Put the PC to sleep or hibernate it yourself before the test time.' };
    });
    logger.info('power', `Wake test set for ${new Date(at).toLocaleTimeString()}${thenHibernate ? '; hibernating in 10 seconds' : ''}.`);
    if (thenHibernate) setTimeout(() => hibernate(), 10000);
    return { scheduledFor: new Date(at).toISOString() };
  });
  handle('power:cancelWakeTest', async () => {
    await deleteTask(WAKE_TEST_TASK).catch(() => {});
    store.update((c) => {
      c.app.wakeTest = { scheduledFor: '', startedAt: '', wokeAt: '', result: '', detail: '' };
    });
    logger.info('power', 'Wake test cancelled.');
  });
  // ---- Auto Power On tab: read-only system info, Windows settings shortcuts, restart to BIOS ----
  handle('power:info', async () => {
    const info = await systemPowerInfo();
    return { info, bootMatchesBiosTime: confirmBiosPowerOn({ store, logger, info }) };
  });
  handle('power:open', async (page) => {
    if (!['signInOptions', 'recovery', 'netplwiz', 'powerButtons'].includes(page)) throw new Error('Unknown page.');
    openWindowsPage(page);
  });
  handle('power:restartToBios', async () => {
    if (ctx.workflow.state.busy || ctx.workflow.state.stream.live) throw new Error('Finish or end the current stream before restarting.');
    try {
      await restartToFirmware();
    } catch {
      throw new Error('Restart was not started (administrator approval was declined or is not available).');
    }
    logger.info('power', 'Restarting into BIOS/UEFI setup in 15 seconds.');
  });
  handle('power:hibernate', async () => {
    if (ctx.workflow.state.busy || ctx.workflow.state.stream.live) throw new Error('Finish or end the current stream before hibernating.');
    const info = ctx.scheduler.getInfo();
    if (!info.nextRun) throw new Error('There is no upcoming scheduled stream to wake for.');
    await ctx.scheduler.refreshTaskInfo().catch(() => null);
    if (!ctx.scheduler.getInfo().task) throw new Error('The Windows scheduled task is not registered, so Windows would not wake the PC. Save the schedule again.');
    logger.info('power', `Hibernating until the next stream (${new Date(info.nextRun).toLocaleString()}).`);
    setTimeout(() => hibernate(), 5000);
    return { nextRun: info.nextRun };
  });
  handle('schedule:respond', async (accept) => {
    if (!isBool(accept)) throw new Error('Invalid value.');
    return { ok: ctx.workflow.respondConfirmation(accept) };
  });

  // ---- Updates & uninstall -----------------------------------------------------------------
  /** Checks the update source (GitHub Releases unless another one is set). `quiet`: no error thrown. */
  ctx.checkUpdates = async ({ quiet = false } = {}) => {
    const url = store.get().updates.releaseManifestUrl || DEFAULT_UPDATE_SOURCE;
    ctx.updateStatus = { ...ctx.updateStatus, checking: true, error: '' };
    pushState();
    try {
      const portable = !!process.env.PORTABLE_EXECUTABLE_FILE;
      const manifest = await fetchManifest(url, (u, o) => net.fetch(u, o), 10000, { portable });
      store.update((c) => {
        Object.assign(c.updates, { latestVersion: manifest.version, releaseNotes: manifest.releaseNotes, downloadUrl: manifest.downloadUrl, lastCheckedAt: new Date().toISOString() });
      });
      const newer = compareVersions(manifest.version, app.getVersion()) > 0;
      ctx.updateStatus = { ...ctx.updateStatus, checking: false, error: '', checkedThisSession: true, downloadSize: manifest.downloadSize || 0 };
      if (!quiet || newer) logger.info('updates', newer ? `Version ${manifest.version} is available.` : `Up to date (latest is ${manifest.version}).`);
      pushState();
      return { ok: true, newer };
    } catch (err) {
      ctx.updateStatus = { ...ctx.updateStatus, checking: false, error: err.message, checkedThisSession: true };
      if (!quiet) logger.warn('updates', `Update check failed: ${err.message}`);
      pushState();
      if (quiet) return { ok: false, error: err.message };
      throw err;
    }
  };
  handle('updates:check', async () => ctx.checkUpdates());
  handle('updates:openDownload', async () => {
    const url = store.get().updates.downloadUrl;
    if (!isHttpsUrl(url)) throw new Error('No download link is available.');
    await shell.openExternal(url);
  });

  /**
   * Upgrades the installed app: downloads the newer Setup exe from this app's GitHub releases, checks it,
   * starts the installer (which keeps settings and the schedule) and closes the app so files can be replaced.
   */
  handle('updates:install', async () => {
    const u = store.get().updates;
    if (!app.isPackaged || process.env.PORTABLE_EXECUTABLE_FILE) throw new Error('Only the installed version can upgrade itself. For the portable version, download the new exe instead.');
    if (!u.latestVersion || compareVersions(u.latestVersion, app.getVersion()) <= 0) throw new Error('No newer version is available.');
    if (!isReleaseAsset(u.downloadUrl) || !/Setup-\d+\.\d+\.\d+\.exe$/.test(u.downloadUrl) || !u.downloadUrl.includes(`-${u.latestVersion}.exe`)) {
      throw new Error('The download link is not an installer of this app. Check for updates again.');
    }
    if (ctx.workflow.state.busy || ctx.workflow.state.stream.live) throw new Error('Wait until the stream and any automation have finished, then upgrade.');
    const name = decodeURIComponent(u.downloadUrl.split('/').pop());
    const file = path.join(app.getPath('temp'), name);
    const progress = (received, total) => {
      ctx.updateStatus = { ...ctx.updateStatus, installing: true, error: '', received, total };
      pushState();
    };
    progress(0, ctx.updateStatus.downloadSize || 0);
    logger.info('updates', `Downloading version ${u.latestVersion}…`);
    try {
      const res = await net.fetch(u.downloadUrl);
      if (!res.ok || !res.body) throw new Error(`The download failed (HTTP ${res.status}).`);
      const total = Number(res.headers.get('content-length')) || ctx.updateStatus.downloadSize || 0;
      const out = fs.createWriteStream(file);
      let received = 0;
      let last = 0;
      for await (const chunk of res.body) {
        received += chunk.length;
        if (!out.write(Buffer.from(chunk))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - last > 500) {
          last = Date.now();
          progress(received, total);
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (received < 1024 * 1024 || (total && received !== total)) throw new Error('The download was incomplete. Try again.');
      const head = Buffer.alloc(2);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, head, 0, 2, 0);
      fs.closeSync(fd);
      if (head.toString('latin1') !== 'MZ') throw new Error('The downloaded file is not a Windows installer.');
    } catch (err) {
      fs.rmSync(file, { force: true });
      ctx.updateStatus = { ...ctx.updateStatus, installing: false, error: err.message };
      logger.warn('updates', `Upgrade failed: ${err.message}`);
      pushState();
      throw err;
    }
    logger.info('updates', `Starting the installer for version ${u.latestVersion}. The app closes now and the installer keeps your settings.`);
    store.saveNow();
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 800);
    return { ok: true };
  });

  handle('app:uninstall', async (opts) => {
    const removeData = !!(opts && opts.removeData);
    const uninstaller = uninstallerPath();
    if (!uninstaller) throw new Error('No installer-registered uninstaller was found. The portable version is removed by deleting its .exe file.');
    if (removeData) fs.writeFileSync(removeDataMarker, new Date().toISOString(), 'utf8');
    logger.info('app', `Launching the uninstaller${removeData ? ' (settings will be removed)' : ''}.`);
    store.saveNow();
    const child = spawn(uninstaller, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => app.quit(), 500);
    return { ok: true, launched: true };
  });
  handle('app:cleanup', async () => {
    await ctx.scheduler.remove();
    store.update((c) => {
      c.app.launchOnWindowsStartup = false;
    });
    applyLoginItem(false);
    logger.info('app', 'Removed the scheduled task and the Windows sign-in entry.');
  });

  // ---- Remote control website ----------------------------------------------------------------
  handle('remote:pair', async (serverUrl, code) => {
    if (typeof serverUrl !== 'string' || typeof code !== 'string' || serverUrl.length > 300 || code.length > 20) throw new Error('Invalid values.');
    const result = await remote.pair(serverUrl, code);
    // A paired PC should come back online by itself after a restart: start (hidden) at Windows sign-in.
    if (!store.get().app.backgroundStartupApplied) {
      store.update((c) => {
        c.app.launchOnWindowsStartup = true;
        c.app.backgroundStartupApplied = true;
      });
      applyLoginItem(true);
      logger.info('app', 'The app now starts in the background at Windows sign-in, so this PC stays reachable from the website.');
    }
    pushState();
    return { ok: true, result };
  });
  handle('remote:setEnabled', async (enabled) => {
    if (!isBool(enabled)) throw new Error('Invalid value.');
    remote.setEnabled(enabled);
  });
  handle('remote:unpair', async () => remote.unpair());
  handle('remote:rename', async (name) => remote.rename(name));

  // ---- Logs --------------------------------------------------------------------------------
  handle('logs:clear', async () => logger.clear());
  handle('logs:openFolder', async () => {
    await shell.openPath(path.join(app.getPath('userData'), 'logs'));
  });
}

module.exports = { registerIpc };
