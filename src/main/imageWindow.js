'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');

const TITLE = 'ZSA Stream Image';

// The page is built in memory and loaded once; later shares only swap the picture.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src zsa-img:; style-src 'unsafe-inline'">
<title>${TITLE}</title>
<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:contain;display:block}</style>
</head><body><img id="img" alt=""></body></html>`;

/**
 * A dedicated window that shows the selected image full-bleed. Zoom shares this window,
 * because the Zoom desktop client has no "share an image file" source.
 *
 * The window is created hidden when the app starts and is only hidden (not destroyed) between shares.
 * Opening a new window later needs the app's files on disk, and the portable build's launcher deletes and
 * re-unpacks those files whenever the exe is started again, so a window created later can fail to load.
 */
class ImageWindow {
  constructor(logger = null) {
    this.win = null;
    this.ready = null;
    this.logger = logger;
  }

  /** Creates the hidden window and loads its page (called at start-up; safe to call again). */
  prepare() {
    if (this.win && !this.win.isDestroyed()) return this.ready;
    const area = screen.getPrimaryDisplay().workArea;
    const width = Math.min(1280, area.width);
    const height = Math.min(720, area.height);
    const win = new BrowserWindow({
      title: TITLE,
      width,
      height,
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + Math.round((area.height - height) / 2),
      backgroundColor: '#000000',
      autoHideMenuBar: true,
      show: false,
      skipTaskbar: false,
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
    });
    this.win = win;
    win.on('page-title-updated', (e) => e.preventDefault());
    // Closing the window (e.g. by the user) only hides it, so it can be shared again without a reload.
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => {
      if (this.win === win) {
        this.win = null;
        this.ready = null;
      }
    });
    // Record why the window could not show the page (load error or a crashed page process).
    win.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => isMainFrame && this.logger?.error('image', `Image window failed to load (${code} ${desc}).`));
    win.webContents.on('render-process-gone', (_e, d) => {
      this.logger?.error('image', `Image window process ended: ${d.reason} (exit code ${d.exitCode}).`);
      this.ready = null; // reload the page on the next share
    });
    this.ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((err) => {
      this.ready = null;
      throw err;
    });
    return this.ready;
  }

  async show(imagePath) {
    if (!this.win || this.win.isDestroyed()) this.prepare();
    if (!this.ready) {
      this.ready = this.win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch((err) => {
        this.ready = null;
        throw err;
      });
    }
    await this.ready;
    // Swap the picture in the already-loaded page and wait until it is drawn.
    const version = `${Date.now()}-${path.basename(imagePath || '')}`;
    const loaded = await this.win.webContents.executeJavaScript(
      `new Promise((resolve) => { const img = document.getElementById('img'); img.onload = () => resolve(true); img.onerror = () => resolve(false); img.src = 'zsa-img://current/?v=' + ${JSON.stringify(encodeURIComponent(version))}; })`,
    );
    if (!loaded) throw new Error(`The image could not be shown: ${path.basename(imagePath || '')}.`);
    this.win.setTitle(TITLE);
    if (this.win.isMinimized()) this.win.restore();
    this.win.show();
  }

  /** Hides the window (kept for the next share). */
  close() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  /** Really closes the window (app quit). */
  destroy() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { ImageWindow, IMAGE_WINDOW_TITLE: TITLE };
