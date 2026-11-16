'use strict';

const { AutomationError } = require('../zoom/zoomService');
const { findProfile, openInProfile, STUDIO_URL_RE } = require('./browserProfile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Regexes for "today" as YouTube Studio writes a stream's date, in this PC's local date:
 * "Nov 2, 2026", "2 Nov 2026", "November 2, 2026", "02/11/2026", "11/02/2026", "Today, 5:50 AM".
 */
function todayPatterns(d = new Date()) {
  const day = d.getDate();
  const y = d.getFullYear();
  const dd = String(day).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const mon = `(${MONTHS[d.getMonth()]}|${MONTHS_LONG[d.getMonth()]})`;
  return [
    `\\b${mon}\\.?\\s+0?${day},?\\s+${y}\\b`,
    `\\b0?${day}\\s+${mon}\\.?,?\\s+${y}\\b`,
    `\\b${dd}[/.-]${mm}[/.-]${y}\\b`,
    `\\b${mm}[/.-]${dd}[/.-]${y}\\b`,
    '^Today,?\\s+\\d{1,2}:\\d{2}',
  ];
}

// Text on YouTube Studio's pages, read with text recognition (case-insensitive, whole label).
const LABELS = {
  create: ['^Create$'],
  goLiveMenu: ['^Go live$'],
  goLiveButton: ['^Go live$', '^GO LIVE$', '^Go Live$'],
  // Studio's list of scheduled streams (Live Control Room → Manage), where today's stream is listed.
  manage: ['^Manage$'],
};

/**
 * Drives the YouTube side after Zoom's "Live on YouTube":
 *   0. With a YouTube Studio live link set: open it first in the browser profile already signed in to the
 *      stream's Google account (no sign-in / 2-step verification), which also makes Zoom's page open there.
 *   1. Google account chooser: click the configured account (e.g. bkmvastrapur@gmail.com) if it is shown.
 *   2. YouTube Studio: Create → Go live.
 *   3. Select today's scheduled stream (only today's date; never another day).
 *   4. Click Go live.
 *   5. "Go Live!" on Zoom's YouTube page if it is shown (optional setting).
 * Passwords, 2-step verification and consent screens are never automated.
 * The stream is reported live only after Zoom's own live indicator appears, or the user confirms it.
 */
class YouTubeLiveService {
  constructor({ zoom, logger, profiles = { findProfile, openInProfile } }) {
    this.zoom = zoom;
    this.logger = logger;
    this.profiles = profiles;
  }

  /** Opens the channel's Studio live page in the signed-in browser profile. Returns true when it did. */
  async openStudio(accountEmail, studioUrl, onWaiting) {
    if (!studioUrl || !STUDIO_URL_RE.test(studioUrl)) return false;
    const profile = this.profiles.findProfile(accountEmail);
    if (!profile) {
      this.logger.warn('youtube', `No Chrome or Edge profile is signed in as ${accountEmail || '(no account set)'}; using the default browser (it may ask you to sign in).`);
      return false;
    }
    try {
      this.profiles.openInProfile(profile, studioUrl);
    } catch (err) {
      this.logger.warn('youtube', `Could not open YouTube Studio in ${profile.browser}: ${err.message}`);
      return false;
    }
    this.logger.info('youtube', `Opened YouTube Studio in ${profile.browser} profile "${profile.profileName}" (${accountEmail}), already signed in.`);
    onWaiting?.(`Opened YouTube Studio in ${profile.browser} (${accountEmail})…`);
    await sleep(5000);
    return true;
  }

  /** The browser window to work in: the first visible one whose title mentions YouTube/Google/Zoom. */
  async browserWindow() {
    const res = await this.zoom.uia.call('windows', { scope: 'browser' }).catch(() => null);
    const wins = (res && res.windows ? res.windows : []).filter((w) => w.rect && w.rect[2] > 200 && !w.minimized);
    return wins.find((w) => /youtube|google|zoom|sign in|accounts/i.test(w.title)) || wins[0] || null;
  }

  /** Reads the browser window and clicks the first text matching `patterns`. */
  async clickInBrowser(patterns, opts = {}) {
    const win = await this.browserWindow();
    if (!win) return { clicked: false, seen: [] };
    await this.zoom.uia.call('focus', { scope: 'browser', hwnd: win.hwnd }).catch(() => {});
    await sleep(300);
    return this.zoom.clickText({ hwnd: win.hwnd, patterns, timeoutMs: 0, ...opts }).catch(() => ({ clicked: false, seen: [] }));
  }

  /** True when text matching `patterns` is visible in the browser window. */
  async findInBrowser(patterns) {
    const win = await this.browserWindow();
    if (!win) return false;
    const res = await this.zoom.findText({ hwnd: win.hwnd, patterns, timeoutMs: 0 }).catch(() => ({ found: false }));
    return !!res.found;
  }

  async start(meeting, { autoClickGoLive, accountEmail, studioUrl, timeoutMinutes, onWaiting, isCancelled, isManuallyConfirmed }) {
    if (await this.zoom.isLive(meeting)) {
      this.logger.info('youtube', 'Zoom already reports an active live stream.');
      return { verified: true, method: 'already-live' };
    }

    const studioOpen = await this.openStudio(accountEmail, studioUrl, onWaiting);
    // The browser window just opened on top: bring the Zoom meeting back to the front before using its toolbar.
    if (studioOpen) await Promise.resolve(this.zoom.showMeeting?.(meeting)).catch(() => {});
    await this.zoom.startYouTubeLive(meeting);
    this.logger.info('youtube', 'Selected "Live on YouTube" in Zoom. Waiting for the browser.');
    onWaiting?.('Waiting for YouTube in the browser…');

    // Browser steps run in order; each is retried on every pass until it is done.
    // With the Studio live page already open, "Create → Go live" is not needed.
    const steps = [
      { id: 'account', label: accountEmail ? `Choose account ${accountEmail}` : null, optional: true, patterns: accountEmail ? [escapeRe(accountEmail)] : null },
      { id: 'create', label: 'YouTube Studio: Create', patterns: studioOpen ? null : LABELS.create },
      { id: 'menu', label: 'Create → Go live', patterns: studioOpen ? null : LABELS.goLiveMenu },
      { id: 'today', label: "Select today's stream", patterns: todayPatterns() },
      { id: 'golive', label: 'Go live', patterns: LABELS.goLiveButton },
    ].filter((s) => s.patterns);
    let next = 0;
    let lastSeen = [];
    let todayMisses = 0;
    let accountMisses = 0;
    let manageOpened = false;

    const deadline = Date.now() + timeoutMinutes * 60000;
    let goLiveClicked = false;
    while (Date.now() < deadline) {
      if (isCancelled()) throw new AutomationError('Streaming was cancelled.');
      if (isManuallyConfirmed()) return { verified: false, method: 'user-confirmed' };
      if (await this.zoom.isLive(meeting).catch(() => false)) return { verified: true, method: goLiveClicked || next >= steps.length ? 'auto-go-live' : 'zoom-indicator' };

      // The account chooser may or may not appear; check it on every pass until something later happens.
      const account = steps.find((s) => s.id === 'account');
      if (account && next === 0) {
        const res = await this.clickInBrowser(account.patterns);
        if (res.clicked) {
          this.logger.info('youtube', `Chose Google account ${accountEmail}.`);
          onWaiting?.(`Chose account ${accountEmail}. Waiting for YouTube Studio…`);
          next = 1;
          await sleep(3000);
          continue;
        }
      }

      const step = steps[next];
      if (step && step.id !== 'account') {
        let res = await this.clickInBrowser(step.patterns);
        const following = steps[next + 1];
        if (res.clicked && following) {
          // Check the click took effect (the next step's text appears); otherwise click again for real.
          await sleep(2000);
          const seenNext = await this.findInBrowser(following.patterns);
          if (!seenNext) {
            const again = await this.clickInBrowser(step.patterns, { physical: true });
            if (again.clicked) {
              this.logger.info('youtube', `${step.label}: repeated with a real click.`);
              res = again;
            }
          }
        }
        if (res.clicked) {
          this.logger.info('youtube', `${step.label}: clicked "${res.text}".`);
          onWaiting?.(`${step.label} — done. Next: ${steps[next + 1] ? steps[next + 1].label : 'waiting for Zoom to show LIVE'}…`);
          next++;
          await sleep(step.id === 'today' ? 2500 : 2000);
          continue;
        }
        lastSeen = res.seen || [];
        // Today's stream not on screen: open Studio's list of scheduled streams (only today's date is ever chosen).
        if (step.id === 'today' && !manageOpened && ++todayMisses >= 3) {
          const manage = await this.clickInBrowser(LABELS.manage);
          if (manage.clicked) {
            manageOpened = true;
            this.logger.info('youtube', "Opened Manage (scheduled streams) to find today's stream.");
            await sleep(2500);
            continue;
          }
        }
        onWaiting?.(
          step.id === 'today'
            ? "Looking for today's scheduled stream in YouTube Studio (another day is never selected)…"
            : `Waiting for "${step.label}" in the browser. Complete any sign-in or consent screen yourself.`,
        );
      } else if (step && step.id === 'account' && studioOpen) {
        // Already signed in: move on once today's stream is visible, or after a few checks (it may be under
        // Manage, which the next step opens). The account chooser, if it appears later, is still clicked above.
        if ((await this.findInBrowser(todayPatterns())) || ++accountMisses >= 2) {
          next = steps.findIndex((s) => s.id === 'today');
          continue;
        }
        onWaiting?.("Waiting for today's stream on the YouTube Studio live page…");
      } else if (step && step.id === 'account') {
        // Account chooser not shown (yet): move on once YouTube Studio's Create button is visible.
        const create = await this.clickInBrowser(LABELS.create);
        if (create.clicked) {
          this.logger.info('youtube', 'YouTube Studio: Create clicked (no account chooser shown).');
          next = steps.findIndex((s) => s.id === 'menu');
          await sleep(2000);
          continue;
        }
        lastSeen = create.seen || [];
        onWaiting?.('Waiting for the Google account chooser or YouTube Studio in the browser…');
      }

      // Zoom's own YouTube page may still show "Go Live!".
      if (autoClickGoLive && !goLiveClicked) {
        goLiveClicked = await this.zoom.clickGoLiveInBrowser().catch(() => false);
        if (goLiveClicked) {
          this.logger.info('youtube', 'Clicked "Go Live!" on the YouTube live stream page.');
          onWaiting?.('Clicked "Go Live!". Waiting for Zoom to confirm the stream is live…');
        }
      }
      await sleep(2500);
    }
    const stuck = steps[next];
    if (stuck) this.logger.warn('youtube', `Stopped at "${stuck.label}". Browser text seen: ${lastSeen.join(' | ').slice(0, 400) || '(none)'}`);
    throw new AutomationError(
      stuck && stuck.id === 'today'
        ? "No YouTube stream scheduled for today was found."
        : `Zoom did not report a live stream within ${timeoutMinutes} minute(s)${stuck ? ` (stopped at "${stuck.label}")` : ''}.`,
      stuck && stuck.id === 'today'
        ? 'Schedule today\'s stream in YouTube Studio (or use "Setup tomorrow link" the day before), then try again. Another day is never selected.'
        : 'Keep the browser window visible and in English, finish any sign-in in the browser, then press "I\'m live" if you are live.',
    );
  }

  async stop(meeting) {
    if (!(await this.zoom.isLive(meeting).catch(() => false))) return { wasLive: false, stopped: false };
    const stopped = await this.zoom.stopYouTubeLive(meeting);
    if (!stopped) {
      throw new AutomationError('"Stop Live Stream" was not found in Zoom\'s More menu.', 'Stop the stream from Zoom (More → Stop Live Stream) or from YouTube Studio.');
    }
    for (let i = 0; i < 8; i++) {
      await sleep(750);
      if (!(await this.zoom.isLive(meeting).catch(() => true))) return { wasLive: true, stopped: true };
    }
    return { wasLive: true, stopped: false };
  }
}

module.exports = { YouTubeLiveService, todayPatterns };
