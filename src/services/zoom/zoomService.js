'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { getLabels } = require('./labels');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An automation failure with a message the user can act on. */
class AutomationError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint || '';
  }
}

/** Converts a Zoom web join link (https://…zoom.us/j/123?pwd=…) or a bare meeting ID into a zoommtg:// URI. */
function toZoomUri(link) {
  const value = String(link || '').trim();
  if (!value) return null;
  if (/^zoommtg:\/\//i.test(value)) return value;
  const digits = value.replace(/[\s-]/g, '');
  if (/^\d{9,12}$/.test(digits)) return `zoommtg://zoom.us/join?action=join&confno=${digits}`;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!/(^|\.)zoom\.(us|com)$|(^|\.)zoomgov\.com$/i.test(url.hostname)) return null;
  const match = url.pathname.match(/\/(?:j|s|w|wc\/join)\/(\d{9,12})/);
  if (!match) return null;
  const params = new URLSearchParams({ action: 'join', confno: match[1] });
  const pwd = url.searchParams.get('pwd');
  if (pwd) params.set('pwd', pwd);
  return `zoommtg://${url.hostname}/join?${params.toString()}`;
}

/** Regex body matching a meeting name; apostrophes match ' ’ and ` and whitespace runs are flexible. */
function meetingNameBody(name) {
  return String(name || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/['’`]/g, "['’`]")
    .replace(/\s+/g, '\\s+');
}

/** Regex for the "Start <topic>" / "Join <topic>" buttons in Zoom's home calendar list. */
function meetingButtonPattern(name) {
  return `^(Start|Join)\\s+${meetingNameBody(name)}$`;
}

const centre = (r) => ({ x: Math.round(r[0] + r[2] / 2), y: Math.round(r[1] + r[3] / 2) });

class ZoomService {
  constructor({ uia, store, logger }) {
    this.uia = uia;
    this.store = store;
    this.logger = logger;
  }

  get labels() {
    return getLabels(this.store.get().zoom.labelOverrides);
  }

  findExecutable() {
    const configured = this.store.get().zoom.executablePath;
    const candidates = [
      configured,
      process.env.APPDATA && path.join(process.env.APPDATA, 'Zoom', 'bin', 'Zoom.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Zoom', 'bin', 'Zoom.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Zoom', 'bin', 'Zoom.exe'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Zoom', 'bin', 'Zoom.exe'),
    ].filter(Boolean);
    return candidates.find((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    }) || null;
  }

  /** Lists visible Zoom top-level windows (cheap: Win32 enumeration only). */
  async getWindows() {
    const res = await this.uia.call('windows', { scope: 'zoom' });
    return res.running ? res.windows : null;
  }

  classifyWindows(windows) {
    const L = this.labels;
    const re = (s) => new RegExp(s, 'i');
    const real = windows.filter((w) => w.rect && w.rect[2] > 0 && w.rect[3] > 0);
    const meeting = real.find((w) => !re(L.homeWindowClass).test(w.cls) && (re(L.meetingWindowClass).test(w.cls) || re(L.meetingWindowTitle).test(w.title)));
    const shareToolbar = real.find((w) => re(L.shareToolbarClass).test(w.cls));
    return { meeting: meeting || null, shareToolbar: shareToolbar || null };
  }

  async getStatus() {
    const exe = this.findExecutable();
    let windows = null;
    try {
      windows = await this.getWindows();
    } catch (err) {
      return { installed: !!exe, running: false, inMeeting: false, sharingDetected: false, status: exe ? 'unknown' : 'not_installed', executablePath: exe, error: err.message };
    }
    const running = windows !== null;
    const { meeting, shareToolbar } = running ? this.classifyWindows(windows) : {};
    const status = running ? 'connected' : exe ? 'disconnected' : 'not_installed';
    return {
      installed: !!exe || running,
      running,
      inMeeting: !!meeting,
      meetingTitle: meeting ? meeting.title : '',
      sharingDetected: !!shareToolbar,
      status,
      executablePath: exe,
    };
  }

  launch(uri) {
    const exe = this.findExecutable();
    if (!exe) throw new AutomationError('Zoom is not installed.', 'Install the Zoom desktop client from zoom.us/download, or set its path in settings.');
    const args = uri ? [`--url=${uri}`] : [];
    const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
  }

  /** Zoom's home window in any state (it can start minimized or hidden in the tray), or null. */
  async findHome() {
    const re = new RegExp(this.labels.homeWindowClass, 'i');
    const res = await this.uia.call('windows', { scope: 'zoom', includeHidden: true }).catch(() => null);
    return (res && res.running && res.windows.find((w) => re.test(w.cls))) || null;
  }

  /** Waits for Zoom to finish starting. A cold start after boot can take over a minute. */
  async waitUntilRunning(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wins = await this.getWindows().catch(() => null);
      if (wins && this.classifyWindows(wins).meeting) return true;
      if (await this.findHome()) return true;
      await sleep(1000);
    }
    return false;
  }

  /**
   * Waits for the meeting window. `onPreview(title)` is called while Zoom shows its video preview
   * (titled with the meeting name), which waits for the user to press Start/Join.
   */
  async waitForMeeting(timeoutMs, onPreview, isCancelled = () => false) {
    const deadline = Date.now() + timeoutMs;
    const previewRe = new RegExp(this.labels.previewWindowClass, 'i');
    while (Date.now() < deadline) {
      if (isCancelled()) throw new AutomationError('Cancelled by user.');
      const wins = await this.getWindows().catch(() => null);
      const meeting = wins && this.classifyWindows(wins).meeting;
      if (meeting) return meeting;
      const preview = wins && wins.find((w) => previewRe.test(w.cls) && w.rect && w.rect[2] > 0);
      if (preview && onPreview) await onPreview(preview);
      await sleep(1500);
    }
    return null;
  }

  /** Brings Zoom's home window forward (launching Zoom shows it) and returns it, or null. */
  /** Presses Start/Join in Zoom's video preview window. Returns true if the button was found and clicked. */
  async pressPreviewStart(preview, physical = false) {
    // Bring the preview to the front first, so the click lands on it and not on a window above it.
    await this.uia.call('focus', { scope: 'zoom', hwnd: preview.hwnd }).catch(() => {});
    await sleep(300);
    const res = await this.clickText({ hwnd: preview.hwnd, region: [0.4, 0.8, 1, 1], patterns: this.labels.previewStart, timeoutMs: 1500, physical }).catch(() => ({ clicked: false }));
    return !!res.clicked;
  }

  async showHome(timeoutMs = 60000) {
    const re = new RegExp(this.labels.homeWindowClass, 'i');
    // Launching Zoom again brings its home window out of the tray; a minimized window is restored by focus.
    this.launch();
    let relaunched = Date.now();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wins = await this.getWindows().catch(() => null);
      const home = wins && wins.find((w) => re.test(w.cls) && w.rect && w.rect[2] > 0 && !w.minimized);
      if (home) return home;
      const any = await this.findHome();
      if (any && (any.minimized || any.visible)) {
        await this.uia.call('focus', { scope: 'zoom', hwnd: any.hwnd }).catch(() => {});
      } else if (Date.now() - relaunched > 15000) {
        this.launch(); // still hidden in the tray: ask Zoom once more to show itself
        relaunched = Date.now();
      }
      await sleep(1000);
    }
    return null;
  }

  /**
   * Finds a meeting by its name (topic) in Zoom's home calendar and presses its Start/Join button.
   * Returns { found, action, name }. The caller waits for the meeting window.
   */
  async clickMeetingByName(name) {
    const home = await this.showHome();
    if (!home) throw new AutomationError('The Zoom home window did not open within 45 seconds.', 'Open Zoom and sign in, then try again.');
    await this.uia.call('focus', { scope: 'zoom', hwnd: home.hwnd });
    // Zoom's home list is drawn as web content that is not always exposed to UI Automation, so it is read
    // with text recognition first: find the meeting's name, then the Start/Join button in the same card.
    const nameRe = new RegExp(`^${meetingNameBody(name)}$`, 'i');
    const deadline = Date.now() + 15000;
    let listedAt = null; // the meeting's time line when it is listed but has no Start/Join (its slot is over)
    while (Date.now() < deadline) {
      const lines = await this.readText({ hwnd: home.hwnd }).catch((err) => {
        this.logger.warn('zoom', `Text recognition failed: ${err.message}`);
        return [];
      });
      const title = lines.find((l) => nameRe.test(l.text.trim()));
      if (title) {
        const [tx, ty, tw, th] = title.rect;
        const button = lines
          .flatMap((l) => l.words)
          .find((w) => /^(start|join)$/i.test(w.text) && w.rect[1] > ty && w.rect[1] < ty + th * 12 && w.rect[0] >= tx - th * 3 && w.rect[0] < tx + Math.max(tw, th * 25));
        if (button) {
          await this.uia.call('clickAt', centre(button.rect));
          const action = /^start/i.test(button.text) ? 'start' : 'join';
          return { found: true, action, name: `${action === 'start' ? 'Start' : 'Join'} ${title.text.trim()}` };
        }
        const timeLine = lines.find((l) => l.rect[1] > ty && l.rect[1] < ty + th * 6 && /\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}/.test(l.text));
        listedAt = timeLine ? timeLine.text.trim() : listedAt || '';
      }
      if (!lines.length) break;
      await sleep(1000);
    }
    const res = await this.uia.call('click', { scope: 'zoom', hwnd: home.hwnd, patterns: [meetingButtonPattern(name)], types: ['Button'], timeoutMs: 0 }, 40000).catch(() => ({ clicked: false }));
    if (!res.clicked) return { found: false, listedWithoutStart: listedAt !== null, listedAt: listedAt || '' };
    return { found: true, action: /^start/i.test(res.name) ? 'start' : 'join', name: res.name };
  }

  // ---- Text recognition helpers (Zoom draws most meeting controls itself) ------------------

  async readText(args) {
    const res = await this.uia.call('ocr', args, 30000);
    return res.lines || [];
  }

  async findText(args) {
    return this.uia.call('findText', args, 30000 + (Number(args.timeoutMs) || 0));
  }

  async clickText(args) {
    return this.uia.call('clickText', args, 30000 + (Number(args.timeoutMs) || 0));
  }

  async requireMeeting() {
    const wins = await this.getWindows();
    if (!wins) throw new AutomationError('Zoom is not running.', 'Open Zoom and start or join a meeting first.');
    const meeting = this.classifyWindows(wins).meeting;
    if (!meeting) throw new AutomationError('No active Zoom meeting window was found.', 'Start or join a meeting in Zoom, or set a meeting link and use "Start Zoom and YouTube Streaming".');
    return meeting;
  }

  /** Brings the meeting window forward, fully on screen (Zoom can open it with the toolbar under the taskbar). */
  async showMeeting(meeting) {
    await this.uia.call('focus', { scope: 'zoom', hwnd: meeting.hwnd, fitOnScreen: true });
  }

  /**
   * Where the meeting controls are: Zoom's floating sharing toolbar while sharing, otherwise the
   * bottom toolbar of the meeting window. `hover` wakes the auto-hiding toolbar just before reading it.
   */
  async controlsArea(meeting) {
    const wins = (await this.getWindows()) || [];
    const { shareToolbar, meeting: current } = this.classifyWindows(wins);
    // The sharing toolbar window is partly see-through; read only its top strip so text from windows behind it is ignored.
    if (shareToolbar) return { hwnd: shareToolbar.hwnd, region: [0, 0, 1, 0.45], hover: [0.5, 0.15], sharing: true };
    const win = current || meeting;
    if (!win) throw new AutomationError('No active Zoom meeting window was found.', 'Start or join a meeting first.');
    await this.showMeeting(win);
    return { hwnd: win.hwnd, region: [0, 0.8, 1, 1], hover: [0.5, 0.6], sharing: false };
  }

  /** Clicks a meeting toolbar button by its label, read with text recognition. */
  /**
   * Clicks a meeting toolbar button by its label. Clicks are sent to the window without moving the mouse
   * pointer; `physical` (or the last retry) uses a real click and hover, with the pointer put straight back.
   */
  async clickToolbar(meeting, patterns, { physical = false } = {}) {
    // A meeting that just opened may still be settling (window moves, audio prompts), so retry a few times.
    let res = { clicked: false };
    for (let attempt = 0; attempt < 3 && !res.clicked; attempt++) {
      if (attempt) await sleep(1500);
      const real = physical || attempt === 2;
      const { sharing, ...area } = await this.controlsArea(meeting);
      res = await this.clickText({ ...area, patterns, timeoutMs: 2500, physical: real, physicalHover: real });
    }
    if (!res.clicked) this.logger.warn('zoom', `Toolbar text seen: ${(res.seen || []).join(' | ').slice(0, 400) || '(none)'}`);
    return res;
  }

  /** Waits for a Zoom window that was not in `before` (a menu, dialog or popup that just opened). */
  async waitNewWindow(before, timeoutMs = 3000, clsPattern = null) {
    const known = new Set(before.map((w) => w.hwnd));
    const ignore = /tooltips|SysShadow|ZoomShadowFrameClass|zMeetingNotification|Annotat|MonitorNumberIndicator/i;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wins = (await this.getWindows().catch(() => null)) || [];
      const fresh = wins.find((w) => !known.has(w.hwnd) && w.rect && w.rect[2] > 60 && w.rect[3] > 40 && !ignore.test(w.cls) && (!clsPattern || new RegExp(clsPattern, 'i').test(w.cls)));
      if (fresh) return fresh;
      await sleep(250);
    }
    return null;
  }

  /**
   * Opens the toolbar's "More" menu and clicks the first item matching `itemPatterns`.
   * `viaPatterns` names an intermediate item (e.g. a "Live stream" tile) that opens a submenu.
   */
  async clickMoreMenuItem(meeting, itemPatterns, viaPatterns = null) {
    const L = this.labels;
    const before = (await this.getWindows()) || [];
    const more = await this.clickToolbar(meeting, L.moreButton);
    if (!more.clicked) {
      throw new AutomationError('Could not find the "More" button in the Zoom meeting toolbar.', 'Make sure the meeting window is visible, not minimized and not covered by other windows.');
    }
    let menu = await this.waitNewWindow(before, 3000);
    if (!menu) {
      // The cursor-free click did not open the menu: try once with a real click.
      const again = (await this.getWindows()) || [];
      const retry = await this.clickToolbar(meeting, L.moreButton, { physical: true });
      if (retry.clicked) menu = await this.waitNewWindow(again, 3000);
    }
    if (!menu) return { clicked: false };
    let item = await this.clickText({ hwnd: menu.hwnd, patterns: itemPatterns, timeoutMs: 1500 });
    if (!item.clicked && viaPatterns) {
      const opened = (await this.getWindows()) || [];
      const via = await this.clickText({ hwnd: menu.hwnd, patterns: viaPatterns, timeoutMs: 500 });
      if (via.clicked) {
        const sub = await this.waitNewWindow(opened, 2500);
        if (sub) {
          item = await this.clickText({ hwnd: sub.hwnd, patterns: itemPatterns, timeoutMs: 1500 });
          if (!item.clicked) await this.uia.call('close', { hwnd: sub.hwnd }).catch(() => {});
        }
      }
    }
    if (!item.clicked) await this.uia.call('close', { hwnd: menu.hwnd }).catch(() => {});
    return item;
  }

  // ---- YouTube live streaming --------------------------------------------------------------

  /** Zoom shows a "LIVE" badge in the meeting window (and sharing toolbar) while a stream is live. */
  async isLive(meeting) {
    const wins = (await this.getWindows()) || [];
    const { shareToolbar, meeting: current } = this.classifyWindows(wins);
    const win = shareToolbar || current || meeting;
    if (!win) return false;
    const hit = await this.findText({ hwnd: win.hwnd, region: shareToolbar ? null : [0, 0, 1, 0.2], patterns: this.labels.liveIndicator, timeoutMs: 0 });
    return !!hit.found;
  }

  async startYouTubeLive(meeting) {
    const item = await this.clickMoreMenuItem(meeting, this.labels.liveOnYouTube, this.labels.liveStreamMenu);
    if (!item.clicked) {
      throw new AutomationError(
        '"Live on YouTube" is not in Zoom\'s More menu.',
        'Zoom shows it only on paid plans (Pro or higher) with "Allow livestreaming of meetings" → YouTube enabled at zoom.us → Settings → In Meeting (Advanced), and only to the host.',
      );
    }
    return item;
  }

  /** Clicks YouTube's "Go Live!" button on Zoom's live-stream page in the browser, if it is visible. */
  async clickGoLiveInBrowser() {
    const res = await this.uia.call('click', { scope: 'browser', patterns: this.labels.goLiveBrowserButton, types: ['Button', 'Hyperlink'], timeoutMs: 0, onscreenOnly: true });
    return !!res.clicked;
  }

  async stopYouTubeLive(meeting) {
    const item = await this.clickMoreMenuItem(meeting, this.labels.stopLiveStream, this.labels.liveStreamMenu);
    if (!item.clicked) return false;
    await sleep(800);
    return true;
  }

  // ---- Sharing -----------------------------------------------------------------------------

  async isSharing() {
    const wins = await this.getWindows().catch(() => null);
    return !!(wins && this.classifyWindows(wins).shareToolbar);
  }

  async waitSharing(expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.isSharing()) === expected) return true;
      await sleep(400);
    }
    return false;
  }

  /** A visible meeting window to send Zoom shortcuts to (the floating video while sharing). */
  async shortcutTarget(meeting) {
    const wins = (await this.getWindows().catch(() => null)) || [];
    return this.classifyWindows(wins).meeting || meeting;
  }

  async stopSharing(meeting) {
    if (!(await this.isSharing())) return false;
    const res = await this.clickToolbar(meeting, this.labels.stopShare).catch(() => ({ clicked: false }));
    if (res.clicked && (await this.waitSharing(false, 3000))) return true;
    // Text not found, or the click did not stop it: Alt+S stops the current share.
    const target = await this.shortcutTarget(meeting);
    if (target && (await this.isSharing())) await this.uia.call('keys', { scope: 'zoom', hwnd: target.hwnd, keys: '%s' }).catch(() => {});
    if (await this.waitSharing(false, 5000)) return true;
    throw new AutomationError('Zoom is still sharing after the stop request.', 'Click "Stop share" in Zoom\'s sharing toolbar.');
  }

  async openShareDialog(meeting) {
    const L = this.labels;
    const dialogNow = async () => ((await this.getWindows()) || []).find((w) => new RegExp(L.shareDialogClass, 'i').test(w.cls) && w.rect[2] > 0);
    const before = (await this.getWindows()) || [];
    const res = await this.clickToolbar(meeting, L.shareButton);
    let dialog = res.clicked ? (await this.waitNewWindow(before, 5000, L.shareDialogClass)) || (await dialogNow()) : null;
    if (!dialog && res.clicked) {
      // The cursor-free click did not open the dialog: try once with a real click.
      await this.clickToolbar(meeting, L.shareButton, { physical: true });
      dialog = (await this.waitNewWindow(before, 4000, L.shareDialogClass)) || (await dialogNow());
    }
    if (!dialog) {
      const target = await this.shortcutTarget(meeting);
      await this.uia.call('keys', { scope: 'zoom', hwnd: (target || meeting).hwnd, keys: '%s' }); // Alt+S opens the share dialog.
      dialog = (await this.waitNewWindow(before, 6000, L.shareDialogClass)) || (await dialogNow());
    }
    if (!dialog) throw new AutomationError('Zoom\'s share dialog did not open.', 'Check that you are allowed to share in this meeting (host settings) and that the meeting window is visible.');
    await sleep(800); // window thumbnails load a moment after the dialog appears
    return dialog;
  }

  /** Reads a checkbox next to a label and sets it. Returns the state seen afterwards, or null if unknown. */
  async setCheckbox(hwnd, patterns, desired) {
    const hit = await this.findText({ hwnd, patterns, timeoutMs: 1500 });
    if (!hit.found) return null;
    const [x, y, , h] = hit.rect;
    const size = Math.round(h * 1.6);
    const box = [x - Math.round(h * 2.6), Math.round(y + h / 2 - size / 2), size, size];
    const read = async () => (await this.uia.call('sample', { rect: box })).blueFraction > 0.3;
    let on = await read();
    if (on !== !!desired) {
      await this.uia.call('clickAt', centre(hit.rect));
      await sleep(400);
      on = await read();
      if (on !== !!desired) {
        // The cursor-free click did not change the tick: try once with a real click.
        await this.uia.call('clickAt', { ...centre(hit.rect), physical: true });
        await sleep(400);
        on = await read();
      }
    }
    return on;
  }

  /**
   * Opens Zoom's share dialog, selects the tile labelled with one of `tilePatterns`, sets "Share sound"
   * and presses Share. Returns { audio } where audio is the checkbox state read back (null = unknown).
   */
  async shareSource(meeting, tilePatterns, { shareSound, sourceLabel }) {
    const L = this.labels;
    const dialog = await this.openShareDialog(meeting);
    const close = () => this.uia.call('close', { hwnd: dialog.hwnd }).catch(() => {});
    await this.uia.call('focus', { scope: 'zoom', hwnd: dialog.hwnd }).catch(() => {});
    // Tiles are labelled with the screen or window title; the options panel on the right is excluded.
    const region = [0, 0.12, 0.74, 0.95];
    let tile = await this.clickText({ hwnd: dialog.hwnd, region, patterns: tilePatterns, timeoutMs: 5000 });
    // With many windows open (e.g. browser windows), the tile can be further down the list: scroll and look again.
    for (let i = 0; !tile.clicked && i < 4; i++) {
      await this.uia.call('scroll', { scope: 'zoom', hwnd: dialog.hwnd, fx: 0.37, fy: 0.55, clicks: -3 }).catch(() => {});
      await sleep(700);
      tile = await this.clickText({ hwnd: dialog.hwnd, region, patterns: tilePatterns, timeoutMs: 1500 });
      if (tile.clicked) this.logger.info('zoom', `Found "${sourceLabel}" after scrolling the share dialog.`);
    }
    if (!tile.clicked) {
      this.logger.warn('zoom', `Share dialog text seen: ${(tile.seen || []).join(' | ').slice(0, 300) || '(none)'}`);
      await close();
      throw new AutomationError(`Could not find "${sourceLabel}" in Zoom's share dialog.`, 'The window may be hidden or listed further down. Keep it open and visible, then try again.');
    }
    await sleep(500);

    const audio = await this.setCheckbox(dialog.hwnd, L.shareSound, !!shareSound);
    if (audio === null && shareSound) this.logger.warn('zoom', 'The "Share sound" option was not found in the share dialog.');

    const confirm = await this.clickText({ hwnd: dialog.hwnd, region: [0, 0.88, 1, 1], patterns: L.shareConfirm, timeoutMs: 2000 });
    if (!confirm.clicked) {
      await close();
      throw new AutomationError('Could not find the "Share" button in Zoom\'s share dialog.', 'Click "Share" in the dialog yourself.');
    }
    if (await this.waitSharing(true, 5000)) return { audio, verified: true };
    // The cursor-free click on Share did not start sharing: if the dialog is still open, click Share for real.
    const stillOpen = ((await this.getWindows()) || []).some((w) => w.hwnd === dialog.hwnd && w.rect[2] > 0);
    if (stillOpen) await this.clickText({ hwnd: dialog.hwnd, region: [0, 0.88, 1, 1], patterns: L.shareConfirm, timeoutMs: 1500, physical: true });
    if (await this.waitSharing(true, 6000)) return { audio, verified: true };
    throw new AutomationError('Zoom did not confirm that sharing started.', 'A permission prompt or "another participant is sharing" notice may be open in Zoom.');
  }

  /**
   * While sharing: sharing toolbar → More → "Disable annotation for others".
   * Returns 'disabled' (clicked), 'already' (menu offers "Enable…", so it is off) or 'not_found'.
   */
  async disableAnnotationForOthers(meeting) {
    const L = this.labels;
    if (!(await this.isSharing())) return 'not_sharing';
    const before = (await this.getWindows()) || [];
    const more = await this.clickToolbar(meeting, L.moreButton);
    if (!more.clicked) return 'not_found';
    const menu = await this.waitNewWindow(before, 3000);
    if (!menu) return 'not_found';
    const close = () => this.uia.call('close', { hwnd: menu.hwnd }).catch(() => {});
    const already = await this.findText({ hwnd: menu.hwnd, patterns: L.annotationDisabled, timeoutMs: 800 });
    if (already.found) {
      await close();
      return 'already';
    }
    const item = await this.clickText({ hwnd: menu.hwnd, patterns: L.disableAnnotation, timeoutMs: 1500 });
    if (!item.clicked) {
      this.logger.warn('zoom', `"Disable annotation for others" not found in the sharing toolbar's More menu. Seen: ${(item.seen || []).join(' | ').slice(0, 300)}`);
      await close();
      return 'not_found';
    }
    return 'disabled';
  }

  // ---- Meeting -----------------------------------------------------------------------------

  /** Waits for Zoom's "End meeting or leave meeting?" window. */
  async waitLeaveDialog(timeoutMs) {
    const re = new RegExp(this.labels.leaveDialogClass, 'i');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const wins = (await this.getWindows().catch(() => null)) || [];
      const dialog = wins.find((w) => re.test(w.cls) && w.rect && w.rect[2] > 0);
      if (dialog) return dialog;
      await sleep(300);
    }
    return null;
  }

  async endMeeting(meeting, endForAll) {
    const L = this.labels;
    // Alt+Q (Zoom's end/leave shortcut) opens the leave dialog reliably, also while sharing; the toolbar's
    // End button is the fallback. The confirm button is only searched inside Zoom's own dialog window.
    const target = await this.shortcutTarget(meeting);
    if (target) await this.uia.call('keys', { scope: 'zoom', hwnd: target.hwnd, keys: '%q' }).catch(() => {});
    let dialog = await this.waitLeaveDialog(4000);
    if (!dialog) {
      const end = await this.clickToolbar(meeting, L.leaveButton).catch(() => ({ clicked: false }));
      if (end.clicked) dialog = await this.waitLeaveDialog(4000);
    }
    if (!dialog) return false;
    const confirmIn = (physical) =>
      this.clickText({ hwnd: dialog.hwnd, patterns: endForAll ? L.endForAll : L.leaveMeeting, timeoutMs: 2500, physical }).then((r) =>
        r.clicked || !endForAll ? r : this.clickText({ hwnd: dialog.hwnd, patterns: L.leaveMeeting, timeoutMs: 500, physical }),
      );
    let confirm = await confirmIn(false);
    if (!confirm.clicked) {
      await this.uia.call('close', { hwnd: dialog.hwnd }).catch(() => {});
      return false;
    }
    // If the cursor-free click left the dialog open, click the same button for real.
    await sleep(1500);
    const dialogOpen = ((await this.getWindows().catch(() => null)) || []).some((w) => w.hwnd === dialog.hwnd && w.rect[2] > 0);
    if (dialogOpen) confirm = await confirmIn(true);
    for (let i = 0; i < 15; i++) {
      await sleep(600);
      const wins = await this.getWindows().catch(() => null);
      if (!wins || !this.classifyWindows(wins).meeting) return true;
    }
    return false;
  }

  /** True while any Zoom.exe process runs. */
  zoomProcessRunning() {
    return new Promise((resolve) => {
      execFile('tasklist.exe', ['/FI', 'IMAGENAME eq Zoom.exe', '/NH'], { windowsHide: true }, (err, out) => resolve(!err && /zoom\.exe/i.test(String(out))));
    });
  }

  /**
   * Closes the Zoom app completely. Asks Zoom to close first; force-closes only if it is still running
   * (Zoom normally just hides in the tray). Returns true when no Zoom process is left.
   */
  async quitZoom() {
    const kill = (force) =>
      new Promise((resolve) => {
        execFile('taskkill.exe', ['/IM', 'Zoom.exe', '/T', ...(force ? ['/F'] : [])], { windowsHide: true }, () => resolve());
      });
    if (!(await this.zoomProcessRunning())) return true;
    await kill(false);
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (!(await this.zoomProcessRunning())) return true;
    }
    await kill(true);
    for (let i = 0; i < 6; i++) {
      await sleep(500);
      if (!(await this.zoomProcessRunning())) return true;
    }
    return false;
  }

  /** Full UI tree of visible Zoom windows, for calibrating label patterns. */
  async dump() {
    const windows = await this.uia.call('windows', { scope: 'zoom', includeHidden: false });
    const tree = await this.uia.call('dump', { scope: 'zoom', depth: 14 }, 60000);
    return { windows, text: tree.text };
  }
}

module.exports = { ZoomService, AutomationError, toZoomUri, meetingButtonPattern, meetingNameBody };
