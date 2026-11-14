'use strict';

const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/** Magic-byte check so renamed or truncated files are not offered for sharing. */
function hasImageSignature(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(12);
    const n = fs.readSync(fd, buf, 0, 12, 0);
    if (n < 4) return false;
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return true;
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
    if (n >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true;
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Lists valid images in a folder (non-recursive). Returns { images, skipped, error }. */
function listImages(folder) {
  if (!folder) return { images: [], skipped: 0, error: 'No image folder is configured.' };
  let entries;
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true });
  } catch (err) {
    return { images: [], skipped: 0, error: err.code === 'ENOENT' ? 'The image folder no longer exists.' : `Cannot read the image folder (${err.code || err.message}).` };
  }
  const images = [];
  let skipped = 0;
  for (const e of entries) {
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!IMAGE_EXTENSIONS.includes(ext)) continue;
    const full = path.join(folder, e.name);
    if (hasImageSignature(full)) images.push(full);
    else skipped++;
  }
  images.sort((a, b) => a.localeCompare(b));
  return { images, skipped, error: images.length ? null : 'The folder has no PNG, JPG, JPEG or WebP images.' };
}

/** Picks a random image, avoiding the current one when there is a choice. */
function pickRandom(images, current) {
  if (!images.length) return null;
  const pool = images.length > 1 ? images.filter((p) => p !== current) : images;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** True when `file` is a supported image directly inside `folder`. */
function isInsideFolder(file, folder) {
  if (!file || !folder) return false;
  const rel = path.relative(path.resolve(folder), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !rel.includes(path.sep) && IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

module.exports = { IMAGE_EXTENSIONS, listImages, pickRandom, isInsideFolder, hasImageSignature };
