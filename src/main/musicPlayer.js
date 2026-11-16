'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { BrowserWindow } = require('electron');
const { youtubeVideoId, youtubeWatchUrl, songTitle } = require('../services/music/musicService');

/**
 * Plays music on this PC in a hidden window, so Zoom's "Share sound" sends it into the meeting and stream.
 *  - A song file plays, then the next song comes from `nextSong()` (the folder plays on, in random order).
 *  - A YouTube link plays on a loop.
 * Nothing is downloaded; YouTube plays in its own page, as in a browser.
 */
class MusicPlayer {
  constructor({ logger, onChange }) {
    this.logger = logger;
    this.onChange = onChange;
    this.win = null;
    this.token = 0;
    this.state = { playing: false, source: '', title: '' };
  }

  window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      show: false,
      width: 480,
      height: 320,
      title: 'ZSA Music',
      skipTaskbar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        partition: 'persist:zsa-music',
      },
    });
    this.win.webContents.setAudioMuted(false);
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.on('closed', () => {
      this.win = null;
      this.set({ playing: false, source: '', title: '' });
    });
    return this.win;
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.onChange?.();
  }

  /** Plays a song file; when it ends, plays `nextSong()` (if given). */
  async playFile(file, nextSong) {
    const token = ++this.token;
    const win = this.window();
    // A small player page (file://) plays the song with an <audio> element; start it and wait for the end.
    if (!win.webContents.getURL().endsWith('/player.html')) await win.loadFile(path.join(__dirname, 'player.html'));
    const src = JSON.stringify(pathToFileURL(file).toString());
    const ended = win.webContents
      .executeJavaScript(
        `new Promise((resolve, reject) => {
          const m = document.getElementById('player');
          m.onended = () => resolve('ended');
          m.onerror = () => reject(new Error('This file cannot be played.'));
          m.loop = false;
          m.src = ${src};
          m.play().catch((e) => reject(new Error(e.message)));
        })`,
        true,
      )
      .catch((err) => (token === this.token ? Promise.reject(err) : 'stopped'));
    this.set({ playing: true, source: 'folder', title: songTitle(file) });
    this.logger.info('music', `Playing "${songTitle(file)}".`);
    ended
      .then((how) => {
        if (how !== 'ended' || token !== this.token) return;
        const next = nextSong?.();
        if (next) this.playFile(next, nextSong).catch((err) => this.failed(err));
        else this.set({ playing: false, title: '' });
      })
      .catch((err) => token === this.token && this.failed(err));
  }

  /** Plays a YouTube video on a loop. */
  async playYouTube(url) {
    const id = youtubeVideoId(url);
    if (!id) throw new Error('That is not a YouTube video link.');
    const token = ++this.token;
    const win = this.window();
    await win.loadURL(youtubeWatchUrl(id)).catch(() => {}); // YouTube may redirect/reload while opening.
    // Wait for the video (the page can reload itself meanwhile), then play it on a loop.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let started = false;
    for (let i = 0; i < 60 && !started && token === this.token; i++) {
      await sleep(500);
      started = await win.webContents
        .executeJavaScript(
          `(() => {
            const v = document.querySelector('video');
            if (!v) return false;
            v.loop = true;
            v.muted = false;
            if (v.paused) v.play().catch(() => {});
            return !v.paused && v.currentTime > 0;
          })()`,
          true,
        )
        .catch(() => false);
    }
    if (token !== this.token) return;
    if (!started) throw new Error('The YouTube video did not start (it may be private, removed or not allowed to play).');
    const title = (win.getTitle() || '').replace(/\s*-\s*YouTube\s*$/i, '').trim() || 'YouTube video';
    this.set({ playing: true, source: 'youtube', title });
    this.logger.info('music', `Playing YouTube: "${title}".`);
  }

  failed(err) {
    this.logger.warn('music', `Music stopped: ${err.message}`);
    this.set({ playing: false, title: '' });
  }

  stop() {
    this.token++;
    const was = this.state.playing;
    if (this.win && !this.win.isDestroyed()) this.win.loadURL('about:blank').catch(() => {});
    this.set({ playing: false, source: '', title: '' });
    if (was) this.logger.info('music', 'Music stopped.');
    return was;
  }

  destroy() {
    this.token++;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { MusicPlayer };
