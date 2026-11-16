'use strict';

const path = require('path');
const { MODES } = require('../services/config/schema');
const { pickRandom } = require('../services/images/imageService');
const { pickRandomSong, youtubeVideoId, songTitle } = require('../services/music/musicService');

/** The Start Stream checklist: step key → setting. */
const START_STEPS = {
  openZoom: 'openMeetingIfNeeded',
  youtube: 'goLiveOnYouTube',
  shareImage: 'shareImageOnStart',
  annotation: 'disableAnnotationOnStart',
  music: 'playMusicOnStart',
};

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
function createActions({ ctx, refreshImages, refreshSongs = () => {} }) {
  const { store, logger } = ctx;

  /** Starts a long-running workflow without waiting for it; progress arrives as state updates. */
  const runInBackground = (fn) => {
    if (ctx.workflow.state.busy) throw new Error('Another automation is already running.');
    fn().catch((err) => logger.error('workflow', err.message));
    return { ok: true };
  };

  const actionsRef = {
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

    // ---- Start Stream checklist --------------------------------------------------------------

    /** Ticks or unticks Start Stream steps, e.g. { youtube: false }. Unticked steps are skipped. */
    setStartSteps: (steps) => {
      if (!steps || typeof steps !== 'object') throw new Error('Invalid steps.');
      const entries = Object.entries(steps).filter(([k]) => k in START_STEPS);
      if (!entries.length || entries.some(([, v]) => typeof v !== 'boolean')) throw new Error('Invalid steps.');
      store.update((c) => {
        for (const [k, v] of entries) c.streaming[START_STEPS[k]] = v;
      });
      logger.info('workflow', `Start Stream steps: ${entries.map(([k, v]) => `${k} ${v ? 'on' : 'off'}`).join(', ')}.`);
      return { ok: true };
    },

    // ---- Music -------------------------------------------------------------------------------

    /** Plays the chosen music: the selected song (then the folder plays on) or the YouTube link. */
    playMusic: async () => {
      const s = store.get().streaming;
      if (s.musicSource === 'youtube') {
        if (!youtubeVideoId(s.musicYoutubeUrl)) throw new Error('Add a YouTube link for the music first.');
        await ctx.music.playYouTube(s.musicYoutubeUrl);
        return { ok: true, title: ctx.music.state.title };
      }
      refreshSongs();
      const songs = ctx.songs.list || [];
      if (!songs.length) throw new Error(ctx.songs.error || 'Choose a music folder first.');
      let song = songs.includes(s.selectedMusicPath) ? s.selectedMusicPath : pickRandomSong(songs, '');
      const select = (file) =>
        store.update((c) => {
          c.streaming.selectedMusicPath = file;
        });
      select(song);
      const next = () => {
        refreshSongs();
        const list = ctx.songs.list || [];
        song = pickRandomSong(list, song);
        if (song) select(song);
        return song;
      };
      await ctx.music.playFile(song, next);
      return { ok: true, title: songTitle(song) };
    },

    stopMusic: () => ({ ok: true, stopped: ctx.music.stop() }),

    /** Picks another random song (and plays it if a song is playing now). */
    pickRandomSong: async () => {
      refreshSongs();
      const songs = ctx.songs.list || [];
      if (!songs.length) throw new Error(ctx.songs.error || 'No songs in the music folder.');
      const chosen = pickRandomSong(songs, store.get().streaming.selectedMusicPath);
      store.update((c) => {
        c.streaming.selectedMusicPath = chosen;
      });
      logger.info('music', `Selected song: ${songTitle(chosen)}`);
      if (ctx.music.state.playing && ctx.music.state.source === 'folder') return actionsRef.playMusic();
      return { ok: true };
    },

    selectSongByName: async (name) => {
      refreshSongs();
      const file = (ctx.songs.list || []).find((f) => path.basename(f) === name);
      if (!file) throw new Error('That song is no longer in the music folder.');
      store.update((c) => {
        c.streaming.selectedMusicPath = file;
        c.streaming.musicSource = 'folder';
      });
      logger.info('music', `Selected song: ${songTitle(file)}`);
      if (ctx.music.state.playing) return actionsRef.playMusic();
      return { ok: true };
    },

    setMusicSource: (source) => {
      if (source !== 'folder' && source !== 'youtube') throw new Error('Invalid music source.');
      store.update((c) => {
        c.streaming.musicSource = source;
      });
      return { ok: true };
    },

    setMusicYoutubeUrl: (url) => {
      const u = String(url || '').trim();
      if (u && !youtubeVideoId(u)) throw new Error('That is not a YouTube video link.');
      store.update((c) => {
        c.streaming.musicYoutubeUrl = u;
        if (u) c.streaming.musicSource = 'youtube';
      });
      logger.info('music', u ? 'YouTube music link saved.' : 'YouTube music link removed.');
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
  return actionsRef;
}

module.exports = { createActions, todayIn, START_STEPS };
