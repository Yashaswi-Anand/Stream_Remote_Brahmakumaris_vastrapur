'use strict';

const fs = require('fs');
const path = require('path');

const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.webm'];

/** Checks the first bytes so renamed or broken files are not offered (MP3, MP4/M4A, WAV, OGG, FLAC, WebM, AAC). */
function hasAudioSignature(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(12);
    const n = fs.readSync(fd, b, 0, 12, 0);
    if (n < 4) return false;
    const ascii = (s, e) => b.toString('ascii', s, e);
    if (ascii(0, 3) === 'ID3') return true; // MP3 with tags
    if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // MPEG audio / AAC (ADTS) frame
    if (n >= 8 && ascii(4, 8) === 'ftyp') return true; // M4A / MP4
    if (ascii(0, 4) === 'RIFF' && n >= 12 && ascii(8, 12) === 'WAVE') return true;
    if (ascii(0, 4) === 'OggS' || ascii(0, 4) === 'fLaC') return true;
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // WebM / Matroska
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Lists playable songs in a folder (non-recursive). Returns { songs, skipped, error }. */
function listSongs(folder) {
  if (!folder) return { songs: [], skipped: 0, error: 'No music folder is chosen.' };
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    return { songs: [], skipped: 0, error: err.code === 'ENOENT' ? 'The music folder no longer exists.' : `Cannot read the music folder (${err.code || err.message}).` };
  }
  const songs = [];
  let skipped = 0;
  for (const e of entries) {
    if (!e.isFile() || !AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) continue;
    const full = path.join(folder, e.name);
    if (hasAudioSignature(full)) songs.push(full);
    else skipped++;
  }
  songs.sort((a, b) => a.localeCompare(b));
  return { songs, skipped, error: songs.length ? null : 'The folder has no MP3, M4A, WAV, OGG, FLAC or WebM songs.' };
}

/**
 * The 11-character video id of a YouTube link, or '' when it is not one:
 * youtube.com/watch?v=…, youtu.be/…, youtube.com/shorts/…, youtube.com/live/…, music.youtube.com/watch?v=…
 */
function youtubeVideoId(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return '';
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
  const host = u.hostname.replace(/^www\.|^m\./, '');
  let id = '';
  if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
  else if (host === 'youtube.com' || host === 'music.youtube.com') {
    if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else {
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{11})/);
      if (m) id = m[2];
    }
  }
  return /^[\w-]{11}$/.test(id) ? id : '';
}

const youtubeWatchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;

/** Picks a random song, avoiding the current one when there is a choice. */
function pickRandomSong(songs, current) {
  if (!songs.length) return null;
  const pool = songs.length > 1 ? songs.filter((s) => s !== current) : songs;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** A display name for a song file ("Om Shanti.mp3" → "Om Shanti"). */
const songTitle = (file) => path.basename(file, path.extname(file));

module.exports = { listSongs, youtubeVideoId, youtubeWatchUrl, pickRandomSong, songTitle, AUDIO_EXTENSIONS };
