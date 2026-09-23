/*
 * chm.js — CHM (ITSS/ITSF) container parser.
 *
 * Pure module: no DOM / worker dependencies, so it runs both inside a
 * Web Worker (backed by FileReaderSync) and under Node.js (backed by fs)
 * for testing. Structure layouts follow CHMLib (chm_lib.c).
 *
 * The reader interface passed to ChmFile.open():
 *   { size: number, read(offset: number, length: number): Uint8Array }
 */

'use strict';

import { LzxState, LzxError } from './lzx.js';

const ITSF_V2_LEN = 0x58;
const ITSF_V3_LEN = 0x60;
const ITSP_V1_LEN = 0x54;
const PMGL_LEN = 0x14;
const RESET_TABLE_LEN = 0x28;

const CHM_UNCOMPRESSED = 0;
const CHM_COMPRESSED = 1;

const UNIT_RESET_TABLE =
  '::DataSpace/Storage/MSCompressed/Transform/' +
  '{7FC28940-9D31-11D0-9B27-00A0C91E9C7C}/' +
  'InstanceData/ResetTable';
const UNIT_CONTENT = '::DataSpace/Storage/MSCompressed/Content';
const UNIT_LZXC_CONTROLDATA = '::DataSpace/Storage/MSCompressed/ControlData';

export class ChmError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChmError';
  }
}

function u32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function i32(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) | 0;
}
function u64(buf, off) {
  const lo = u32(buf, off);
  const hi = u32(buf, off + 4);
  return hi * 0x100000000 + lo;
}
function u16(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

function parseCword(buf, posRef) {
  let accum = 0;
  let temp;
  while ((temp = buf[posRef.pos++]) >= 0x80) {
    accum = accum * 128 + (temp & 0x7f);
  }
  return accum * 128 + temp;
}

const utf8Decoder =
  typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

function decodeUtf8(bytes) {
  if (utf8Decoder) return utf8Decoder.decode(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

class LruBlockCache {
  constructor(maxBlocks) {
    this.max = maxBlocks;
    this.map = new Map();
  }

  get(key) {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }
}

export class ChmFile {
  constructor(reader) {
    this.reader = reader;
    this.dirOffset = 0;
    this.dirLen = 0;
    this.dataOffset = 0;
    this.blockLen = 0;
    this.numBlocks = 0;
    this.langId = 0;
    this.timestamp = 0;
    this.entries = [];
    this.entryMap = new Map();
    this.compressionEnabled = false;
    this.windowSize = 0;
    this.resetInterval = 0;
    this.resetBlkCount = 1;
    this.resetTable = null;
    this.resetOffsets = null;
    this.contentStart = 0;
    this.contentCmpLen = 0;
    this.lzx = null;
    this.lzxWindowBits = 0;
    this.lzxLastBlock = -1;
    this.blockCache = new LruBlockCache(64);
  }

  static open(reader) {
    const chm = new ChmFile(reader);
    chm._parseHeaders();
    chm._enumerate();
    chm._initCompression();
    return chm;
  }

  _read(offset, length) {
    const buf = this.reader.read(offset, length);
    if (!buf || buf.length !== length) {
      throw new ChmError(`short read at ${offset} (+${length})`);
    }
    return buf;
  }

  _parseHeaders() {
    if (this.reader.size < ITSF_V2_LEN) throw new ChmError('file too small to be a CHM');
    const head = this._read(0, Math.min(ITSF_V3_LEN, this.reader.size));

    if (!(head[0] === 0x49 && head[1] === 0x54 && head[2] === 0x53 && head[3] === 0x46)) {
      throw new ChmError('not a CHM file (missing ITSF signature)');
    }
    const version = i32(head, 4);
    const headerLen = i32(head, 8);
    this.timestamp = u32(head, 0x10);
    this.langId = u32(head, 0x14);
    const dirOffset = u64(head, 0x48);
    const dirLen = u64(head, 0x50);

    if (version === 2) {
      if (headerLen < ITSF_V2_LEN) throw new ChmError('bad ITSF v2 header length');
      this.dataOffset = dirOffset + dirLen;
    } else if (version === 3) {
      if (headerLen < ITSF_V3_LEN || head.length < ITSF_V3_LEN) {
        throw new ChmError('bad ITSF v3 header length');
      }
      this.dataOffset = u64(head, 0x58);
    } else {
      throw new ChmError(`unsupported ITSF version ${version}`);
    }

    const itsp = this._read(dirOffset, ITSP_V1_LEN);
    if (!(itsp[0] === 0x49 && itsp[1] === 0x54 && itsp[2] === 0x53 && itsp[3] === 0x50)) {
      throw new ChmError('missing ITSP signature');
    }
    if (i32(itsp, 4) !== 1) throw new ChmError('unsupported ITSP version');
    const itspHeaderLen = i32(itsp, 8);

    this.dirOffset = dirOffset + itspHeaderLen;
    this.dirLen = dirLen - itspHeaderLen;
    this.blockLen = u32(itsp, 0x10);
    if (this.blockLen === 0 || this.blockLen > 1 << 22) {
      throw new ChmError('implausible directory chunk size');
    }
    this.numBlocks = Math.floor(this.dirLen / this.blockLen);
  }

  _enumerate() {
    const blockLen = this.blockLen;
    for (let i = 0; i < this.numBlocks; i++) {
      const chunk = this._read(this.dirOffset + i * blockLen, blockLen);
      if (!(chunk[0] === 0x50 && chunk[1] === 0x4D && chunk[2] === 0x47 && chunk[3] === 0x4C)) {
        continue;
      }
      const freeSpace = u32(chunk, 4);
      const end = blockLen - freeSpace;
      const ref = { pos: PMGL_LEN };
      while (ref.pos < end) {
        const strLen = parseCword(chunk, ref);
        if (strLen <= 0 || strLen > 4096 || ref.pos + strLen > blockLen) break;
        const path = decodeUtf8(chunk.subarray(ref.pos, ref.pos + strLen));
        ref.pos += strLen;
        const space = parseCword(chunk, ref);
        const start = parseCword(chunk, ref);
        const length = parseCword(chunk, ref);
        const entry = { path, space, start, length };
        this.entries.push(entry);
        this.entryMap.set(path.toLowerCase(), entry);
      }
    }
    if (this.entries.length === 0) {
      throw new ChmError('CHM directory contains no entries');
    }
  }

  _initCompression() {
    const rt = this.resolve(UNIT_RESET_TABLE);
    const cn = this.resolve(UNIT_CONTENT);
    const cd = this.resolve(UNIT_LZXC_CONTROLDATA);

    if (!rt || !cn || !cd ||
        rt.space !== CHM_UNCOMPRESSED ||
        cn.space !== CHM_UNCOMPRESSED ||
        cd.space !== CHM_UNCOMPRESSED) {
      this.compressionEnabled = false;
      return;
    }

    const rtData = this._readUncompressed(rt, 0, rt.length);
    if (rtData.length < RESET_TABLE_LEN || u32(rtData, 0) !== 2) {
      this.compressionEnabled = false;
      return;
    }
    const blockCount = u32(rtData, 4);
    const tableOffset = u32(rtData, 0x0c);
    const uncompressedLen = u64(rtData, 0x10);
    const compressedLen = u64(rtData, 0x18);
    const blockLen = u64(rtData, 0x20);
    if (blockLen === 0 || blockCount === 0) {
      this.compressionEnabled = false;
      return;
    }

    const offsets = new Float64Array(blockCount);
    for (let i = 0; i < blockCount; i++) {
      const off = tableOffset + i * 8;
      if (off + 8 > rtData.length) {
        this.compressionEnabled = false;
        return;
      }
      offsets[i] = u64(rtData, off);
    }

    const cdData = this._readUncompressed(cd, 0, cd.length);
    if (cdData.length < 0x18) {
      this.compressionEnabled = false;
      return;
    }
    if (!(cdData[4] === 0x4C && cdData[5] === 0x5A && cdData[6] === 0x58 && cdData[7] === 0x43)) {
      this.compressionEnabled = false;
      return;
    }
    const version = u32(cdData, 8);
    let resetInterval = u32(cdData, 0x0c);
    let windowSize = u32(cdData, 0x10);
    const windowsPerReset = u32(cdData, 0x14);
    if (version === 2) {
      resetInterval *= 0x8000;
      windowSize *= 0x8000;
    }
    if (windowSize === 0 || resetInterval === 0 || windowSize === 1 ||
        resetInterval % (windowSize / 2) !== 0) {
      this.compressionEnabled = false;
      return;
    }

    this.resetTable = { blockCount, uncompressedLen, compressedLen, blockLen };
    this.resetOffsets = offsets;
    this.windowSize = windowSize;
    this.resetInterval = resetInterval;
    this.resetBlkCount = (resetInterval / (windowSize / 2)) * (windowsPerReset || 1);
    this.contentStart = this.dataOffset + cn.start;
    this.contentCmpLen = cn.length;
    this.lzxWindowBits = Math.round(Math.log2(windowSize));
    this.compressionEnabled = true;
  }

  resolve(path) {
    if (!path) return null;
    return this.entryMap.get(path.toLowerCase()) || null;
  }

  _readUncompressed(entry, offset, length) {
    return this._read(this.dataOffset + entry.start + offset, length);
  }

  _cmpBlockBounds(block) {
    const rt = this.resetTable;
    const start = this.resetOffsets[block];
    const end = block < rt.blockCount - 1 ? this.resetOffsets[block + 1] : rt.compressedLen;
    return { start: this.contentStart + start, len: end - start };
  }

  _uncompressedBlockLen(block) {
    const rt = this.resetTable;
    if (block === rt.blockCount - 1) {
      const rem = rt.uncompressedLen - block * rt.blockLen;
      return Math.max(0, Math.min(rt.blockLen, rem));
    }
    return rt.blockLen;
  }

  _getBlock(block) {
    const cached = this.blockCache.get(block);
    if (cached) return cached;

    if (!this.lzx) {
      this.lzx = new LzxState(this.lzxWindowBits);
      this.lzxLastBlock = -1;
    }

    const groupStart = block - (block % this.resetBlkCount);
    let from;
    if (this.lzxLastBlock >= groupStart && this.lzxLastBlock < block) {
      from = this.lzxLastBlock + 1;
    } else {
      from = groupStart;
    }

    let result = null;
    for (let i = from; i <= block; i++) {
      if (i % this.resetBlkCount === 0) this.lzx.reset();
      const { start, len } = this._cmpBlockBounds(i);
      if (len < 0 || len > this.resetTable.blockLen + 6144) {
        throw new ChmError(`implausible compressed block ${i}`);
      }
      const cdata = this._read(start, len);
      let udata;
      try {
        udata = this.lzx.decompress(cdata, this._uncompressedBlockLen(i));
      } catch (err) {
        if (err instanceof LzxError) {
          throw new ChmError(`LZX decompression failed in block ${i}: ${err.message}`);
        }
        throw err;
      }
      this.lzxLastBlock = i;
      this.blockCache.set(i, udata);
      if (i === block) result = udata;
    }
    return result;
  }

  _readCompressed(entry, offset, length) {
    const rt = this.resetTable;
    if (!this.compressionEnabled || !rt) {
      throw new ChmError('archive has no working compressed section');
    }
    const out = new Uint8Array(length);
    let produced = 0;
    let pos = entry.start + offset;
    while (produced < length) {
      const block = Math.floor(pos / rt.blockLen);
      const blockOff = pos % rt.blockLen;
      if (block >= rt.blockCount) break;
      const data = this._getBlock(block);
      const n = Math.min(length - produced, data.length - blockOff);
      if (n <= 0) break;
      out.set(data.subarray(blockOff, blockOff + n), produced);
      produced += n;
      pos += n;
    }
    if (produced !== length) {
      throw new ChmError(`short object read (${produced}/${length})`);
    }
    return out;
  }

  retrieve(entry, offset = 0, length = entry.length - offset) {
    if (!entry) throw new ChmError('no entry');
    if (offset < 0 || length < 0 || offset + length > entry.length) {
      throw new ChmError('read out of object bounds');
    }
    if (length === 0) return new Uint8Array(0);
    return entry.space === CHM_COMPRESSED
      ? this._readCompressed(entry, offset, length)
      : this._readUncompressed(entry, offset, length);
  }

  readPath(path) {
    const entry = this.resolve(path);
    if (!entry) return null;
    return this.retrieve(entry);
  }

  parseSystem() {
    const map = new Map();
    const entry = this.resolve('/#SYSTEM');
    if (!entry || entry.length < 4) return map;
    let data;
    try {
      data = this.retrieve(entry);
    } catch {
      return map;
    }
    let pos = 4;
    while (pos + 4 <= data.length) {
      const code = u16(data, pos);
      const len = u16(data, pos + 2);
      pos += 4;
      if (pos + len > data.length) break;
      if (!map.has(code)) map.set(code, data.slice(pos, pos + len));
      pos += len;
    }
    return map;
  }

  dropCaches() {
    this.blockCache.clear();
    this.lzx = null;
    this.lzxLastBlock = -1;
  }
}

export default ChmFile;
