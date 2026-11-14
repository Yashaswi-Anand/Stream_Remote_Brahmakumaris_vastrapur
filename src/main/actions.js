'use strict';

const path = require('path');
const { MODES } = require('../services/config/schema');
const { pickRandom } = require('../services/images/imageService');

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function todayIn(timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * The stream controls, shared by the app window (IPC) and the remote website, so both follow
 * exactly the same rules (one automation at a time, no second stream while live, and so on).
 */
function createActions({ ctx, refreshImages }) {
  const { store, logger } = ctx;

  /** Starts a long-running workflow without waiting for it; progress arrives as state updates. */
  const runInBackground = (fn) => {
    if (ctx.workflow.state.busy) throw new Error('Another automation is already running.');
    fn().catch((err) => logger.error('workflow', err.message));
    return { ok: true };
  };

  return {
    openZoom: (source = 'user') => runInBackground(() => ctx.workflow.openMeeting(source)),

    startStream: (mode, source = 'user') => {
      if (!MODES.includes(mode)) throw new Error('Unknown streaming mode.');
      if (ctx.workflow.state.stream.live) throw new Error('A stream is already live. End it before starting another.');
      return runInBackground(() => ctx.workflow.startStream(mode, source));
    },

    endStream: () => {
      if (ctx.workflow.state.busy && ctx.workflow.state.action !== 'start') throw new Error('Another automation is already running.');
      ctx.workflow.endStream().catch((err) => logger.error('workflow', err.message));
      return { ok: true };
    },

    cancel: () => ({ ok: ctx.workflow.cancel() }),
    confirmLive: () => ({ ok: ctx.workflow.confirmLive() }),
    shareImage: () => runInBackground(() => ctx.workflow.shareImage()),
    shareScreen: () => runInBackground(() => ctx.workflow.shareScreen()),
    stopShare: () => runInBackground(() => ctx.workflow.stopShare()),

    dismissError: () => {
      if (!ctx.workflow.state.busy) ctx.workflow.patch({ error: null, steps: [] });
      return { ok: true };
    },

    pickRandomImage: () => {
      refreshImages();
      if (!ctx.images.list.length) throw new Error(ctx.images.error || 'No images available.');
      const chosen = pickRandom(ctx.images.list, store.get().streaming.selectedImagePath);
      store.update((c) => {
        c.streaming.selectedImagePath = chosen;
      });
      logger.info('images', `Selected image: ${path.basename(chosen)}`);
      return { ok: true };
    },

    /** Selects an image of the current folder by file name (as listed to the website). */
    selectImageByName: (name) => {
      refreshImages();
      const file = (ctx.images.list || []).find((f) => path.basename(f) === name);
      if (!file) throw new Error('That image is no longer in the image folder.');
      store.update((c) => {
        c.streaming.selectedImagePath = file;
      });
      logger.info('images', `Selected image: ${name}`);
      return { ok: true };
    },

    /** Same schedule as the app's Edit Time dialog: every day at `time`, this PC's time zone, start automatically. */
    saveDailySchedule: async ({ time, enabled }) => {
      if (!TIME_RE.test(time) || typeof enabled !== 'boolean') throw new Error('Invalid schedule.');
      const s = store.get().schedule;
      const timeZone = s.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await ctx.scheduler.save({
        enabled,
        date: todayIn(timeZone),
        time,
        timeZone,
        repeat: 'daily',
        selectedDays: [],
        streamingMode: s.streamingMode || 'zoom_and_youtube',
        autoStart: true,
        requireConfirmation: false,
      });
      if (!res.ok) throw new Error((res.errors || []).join(' ') || 'The schedule could not be saved.');
      return res;
    },
  };
}

module.exports = { createActions, todayIn };
