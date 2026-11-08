'use strict';
// Guarded unzip for KMZ and zipped shapefiles. Streams each entry and counts the bytes that really come out,
// so a zip bomb whose headers lie about the size still stops at the limit. Only the wanted entries are inflated.
const { Unzip, UnzipInflate, UnzipPassThrough } = require('fflate');

const LIMITS = { maxEntryBytes: 512 * 1024 * 1024, maxTotalBytes: 768 * 1024 * 1024, maxRatio: 1000, maxEntries: 20000 };

class ZipLimitError extends Error {}

function isZip(b) {
  return b && b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
}

/**
 * want(name) -> boolean picks entries. Returns { files: {name: Uint8Array}, names: [all entry names] }.
 * Throws ZipLimitError when an entry or the total grows past the limits, or the expansion ratio is absurd.
 */
function safeUnzip(bytes, want, limits = {}) {
  const L = { ...LIMITS, ...limits };
  if (!isZip(bytes)) throw new ZipLimitError('This file is not a ZIP package (it does not start with "PK").');
  const files = {}, names = [];
  let total = 0, err = null, pushed = 0;
  const uz = new Unzip(file => {
    if (err) return;
    names.push(file.name);
    if (names.length > L.maxEntries) { err = new ZipLimitError(`The package has more than ${L.maxEntries} entries. It was not opened.`); return; }
    if (/(^|\/)\.\.(\/|$)/.test(file.name) || !want(file.name)) return;
    const chunks = [];
    let size = 0;
    const csize = file.size || 0;
    file.ondata = (e, chunk, final) => {
      if (err) return;
      if (e) { err = new ZipLimitError(`Entry ${file.name} could not be unzipped: ${e.message || e}`); return; }
      size += chunk.length; total += chunk.length;
      // Ratio checks: against the entry's stated compressed size, and against the bytes read so far
      // (the stated size can be missing or false). Real KMZ and shapefile ZIPs stay far below 200 to 1.
      const bomb = (csize > 0 && size > 16 * 1024 * 1024 && size / csize > L.maxRatio) || (total > 64 * 1024 * 1024 && total / Math.max(1, pushed) > 200);
      if (size > L.maxEntryBytes || total > L.maxTotalBytes || bomb) {
        err = new ZipLimitError(`${file.name} unpacks to more than ${Math.round(size / 1048576)} MB from a ${Math.max(1, Math.round(bytes.length / 1024))} KB file. This looks like a zip bomb, so it was stopped and not opened.`);
        try { file.terminate(); } catch {}
        return;
      }
      chunks.push(chunk);
      if (final) {
        const out = new Uint8Array(size);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        files[file.name] = out;
      }
    };
    file.start();
  });
  uz.register(UnzipInflate);
  uz.register(UnzipPassThrough);
  // Push in 16 KB slices: deflate expands at most about 1032 times, so one call yields at most about 16 MB.
  const STEP = 16 * 1024;
  try {
    for (let o = 0; o < bytes.length && !err; o += STEP) { pushed = Math.min(bytes.length, o + STEP); uz.push(bytes.subarray(o, Math.min(bytes.length, o + STEP)), o + STEP >= bytes.length); }
  } catch (e) {
    if (!err) err = new ZipLimitError('The package could not be unzipped: ' + (e && e.message ? e.message : String(e)));
  }
  if (err) throw err;
  return { files, names };
}

module.exports = { safeUnzip, isZip, ZipLimitError, LIMITS };
