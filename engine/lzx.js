/*
 * lzx.js — LZX decompression in pure JavaScript.
 *
 * Port of lzx.c from cabextract v0.5 / CHMLib (Stuart Caie, Jed Wing),
 * which is distributed under the LGPL. This port keeps the exact
 * semantics of the reference implementation, including the documented
 * deviations from the official LZX specification.
 */

'use strict';

/* constants from the LZX specification */
const LZX_MIN_MATCH = 2;
const LZX_NUM_CHARS = 256;
const LZX_BLOCKTYPE_VERBATIM = 1;
const LZX_BLOCKTYPE_ALIGNED = 2;
const LZX_BLOCKTYPE_UNCOMPRESSED = 3;
const LZX_PRETREE_NUM_ELEMENTS = 20;
const LZX_ALIGNED_NUM_ELEMENTS = 8;
const LZX_NUM_PRIMARY_LENGTHS = 7;
const LZX_NUM_SECONDARY_LENGTHS = 249;

const LZX_PRETREE_MAXSYMBOLS = LZX_PRETREE_NUM_ELEMENTS;
const LZX_PRETREE_TABLEBITS = 6;
const LZX_MAINTREE_MAXSYMBOLS = LZX_NUM_CHARS + 50 * 8;
const LZX_MAINTREE_TABLEBITS = 12;
const LZX_LENGTH_MAXSYMBOLS = LZX_NUM_SECONDARY_LENGTHS + 1;
const LZX_LENGTH_TABLEBITS = 12;
const LZX_ALIGNED_MAXSYMBOLS = LZX_ALIGNED_NUM_ELEMENTS;
const LZX_ALIGNED_TABLEBITS = 7;

const LZX_LENTABLE_SAFETY = 64;

const EXTRA_BITS = new Uint8Array([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14,
  15, 15, 16, 16, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17, 17,
  17, 17, 17,
]);

const POSITION_BASE = new Uint32Array([
  0, 1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192,
  256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384, 24576, 32768, 49152,
  65536, 98304, 131072, 196608, 262144, 393216, 524288, 655360, 786432, 917504, 1048576, 1179648, 1310720, 1441792, 1572864, 1703936,
  1835008, 1966080, 2097152,
]);

export class LzxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LzxError';
  }
}

/*
 * make_decode_table(nsyms, nbits, length, table)
 * Builds a fast huffman decoding table from a canonical huffman code
 * lengths table (David Tritscher's algorithm, as used by cabextract).
 * Returns true on success.
 */
function makeDecodeTable(nsyms, nbits, length, table) {
  let bitNum = 1;
  let pos = 0;
  let tableMask = 1 << nbits;
  let bitMask = tableMask >>> 1;
  let nextSymbol = bitMask;

  /* fill entries for codes short enough for a direct mapping */
  while (bitNum <= nbits) {
    for (let sym = 0; sym < nsyms; sym++) {
      if (length[sym] === bitNum) {
        let leaf = pos;
        if ((pos += bitMask) > tableMask) return false; /* table overrun */
        let fill = bitMask;
        while (fill-- > 0) table[leaf++] = sym;
      }
    }
    bitMask >>>= 1;
    bitNum++;
  }

  /* if there are any codes longer than nbits */
  if (pos !== tableMask) {
    /* clear the remainder of the table */
    for (let sym = pos; sym < tableMask; sym++) table[sym] = 0;

    /* give ourselves room for codes to grow by up to 16 more bits */
    pos <<= 16;
    tableMask <<= 16;
    bitMask = 1 << 15;

    while (bitNum <= 16) {
      for (let sym = 0; sym < nsyms; sym++) {
        if (length[sym] === bitNum) {
          let leaf = pos >>> 16;
          for (let fill = 0; fill < bitNum - nbits; fill++) {
            /* if this path hasn't been taken yet, 'allocate' two entries */
            if (table[leaf] === 0) {
              table[nextSymbol << 1] = 0;
              table[(nextSymbol << 1) + 1] = 0;
              table[leaf] = nextSymbol++;
            }
            /* follow the path, select either left or right for next bit */
            leaf = table[leaf] << 1;
            if ((pos >>> (15 - fill)) & 1) leaf++;
          }
          table[leaf] = sym;
          if ((pos += bitMask) > tableMask) return false; /* table overflow */
        }
      }
      bitMask >>>= 1;
      bitNum++;
    }
  }

  /* full table? */
  if (pos === tableMask) return true;

  /* either erroneous table, or all elements are 0 - let's find out. */
  for (let sym = 0; sym < nsyms; sym++) if (length[sym]) return false;
  return true;
}

export class LzxState {
  /**
   * @param {number} windowBits LZX window size in bits (15..21)
   */
  constructor(windowBits) {
    if (windowBits < 15 || windowBits > 21) {
      throw new LzxError(`unsupported LZX window size: 2^${windowBits}`);
    }
    const wndSize = 1 << windowBits;

    this.window = new Uint8Array(wndSize);
    this.windowSize = wndSize;
    this.windowPosn = 0;

    /* calculate required position slots */
    let posnSlots;
    if (windowBits === 20) posnSlots = 42;
    else if (windowBits === 21) posnSlots = 50;
    else posnSlots = windowBits << 1;

    this.R0 = 1;
    this.R1 = 1;
    this.R2 = 1;
    this.mainElements = LZX_NUM_CHARS + (posnSlots << 3);
    this.headerRead = false;
    this.framesRead = 0;
    this.blockType = 0;
    this.blockLength = 0;
    this.blockRemaining = 0;
    this.intelFilesize = 0;
    this.intelCurpos = 0;
    this.intelStarted = false;

    this.PRETREE_table = new Uint16Array((1 << LZX_PRETREE_TABLEBITS) + (LZX_PRETREE_MAXSYMBOLS << 1));
    this.PRETREE_len = new Uint8Array(LZX_PRETREE_MAXSYMBOLS + LZX_LENTABLE_SAFETY);
    this.MAINTREE_table = new Uint16Array((1 << LZX_MAINTREE_TABLEBITS) + (LZX_MAINTREE_MAXSYMBOLS << 1));
    this.MAINTREE_len = new Uint8Array(LZX_MAINTREE_MAXSYMBOLS + LZX_LENTABLE_SAFETY);
    this.LENGTH_table = new Uint16Array((1 << LZX_LENGTH_TABLEBITS) + (LZX_LENGTH_MAXSYMBOLS << 1));
    this.LENGTH_len = new Uint8Array(LZX_LENGTH_MAXSYMBOLS + LZX_LENTABLE_SAFETY);
    this.ALIGNED_table = new Uint16Array((1 << LZX_ALIGNED_TABLEBITS) + (LZX_ALIGNED_MAXSYMBOLS << 1));
    this.ALIGNED_len = new Uint8Array(LZX_ALIGNED_MAXSYMBOLS + LZX_LENTABLE_SAFETY);
  }

  reset() {
    this.R0 = 1;
    this.R1 = 1;
    this.R2 = 1;
    this.headerRead = false;
    this.framesRead = 0;
    this.blockType = 0;
    this.blockRemaining = 0;
    this.intelCurpos = 0;
    this.intelStarted = false;
    this.windowPosn = 0;
    this.MAINTREE_len.fill(0);
    this.LENGTH_len.fill(0);
  }

  /**
   * Decompress one chunk of LZX data.
   * @param {Uint8Array} input compressed bytes for this block
   * @param {number} outLen number of uncompressed bytes to produce
   * @returns {Uint8Array} freshly allocated buffer with outLen bytes
   */
  decompress(input, outLen) {
    const state = this;
    /* Pad input: the bit reader may fetch up to 2 bytes past the end of
     * the compressed data (mirrors the slack buffer in chm_lib.c).
     * The scratch buffer is reused across calls to avoid per-block GC. */
    if (!this._inbuf || this._inbuf.length < input.length + 8) {
      this._inbuf = new Uint8Array(input.length + 8);
    }
    const inbuf = this._inbuf;
    inbuf.set(input);
    inbuf.fill(0, input.length, input.length + 8);

    const endinp = input.length;
    const window = state.window;
    const windowSize = state.windowSize;
    let windowPosn = state.windowPosn;
    let R0 = state.R0;
    let R1 = state.R1;
    let R2 = state.R2;

    let inpos = 0;
    let bitbuf = 0;      /* uint32 */
    let bitsleft = 0;

    /* --- bitstream primitives ------------------------------------- */
    const ensureBits = (n) => {
      while (bitsleft < n) {
        bitbuf = (bitbuf | (((inbuf[inpos + 1] << 8) | inbuf[inpos]) << (16 - bitsleft))) >>> 0;
        bitsleft += 16;
        inpos += 2;
      }
    };
    const removeBits = (n) => {
      bitbuf = (bitbuf << n) >>> 0;
      bitsleft -= n;
    };
    const readBits = (n) => {
      if (n === 0) return 0;
      ensureBits(n);
      const v = bitbuf >>> (32 - n);
      removeBits(n);
      return v;
    };

    /* --- huffman primitives --------------------------------------- */
    const readHuffSym = (table, lens, tablebits, maxsymbols) => {
      ensureBits(16);
      let i = table[bitbuf >>> (32 - tablebits)];
      if (i >= maxsymbols) {
        let j = 1 << (32 - tablebits);
        do {
          j >>>= 1;
          i <<= 1;
          i |= (bitbuf & j) ? 1 : 0;
          if (!j) throw new LzxError('corrupt huffman stream');
          i = table[i];
        } while (i >= maxsymbols);
      }
      removeBits(lens[i]);
      return i;
    };

    const buildTable = (nsyms, nbits, lens, table, name) => {
      if (!makeDecodeTable(nsyms, nbits, lens, table)) {
        throw new LzxError(`failed to build ${name} huffman table`);
      }
    };

    /* READ_LENGTHS: read code lengths, stored in the special LZX way */
    const readLengths = (lens, first, last) => {
      for (let x = 0; x < 20; x++) {
        state.PRETREE_len[x] = readBits(4);
      }
      buildTable(LZX_PRETREE_MAXSYMBOLS, LZX_PRETREE_TABLEBITS, state.PRETREE_len, state.PRETREE_table, 'PRETREE');

      for (let x = first; x < last;) {
        let z = readHuffSym(state.PRETREE_table, state.PRETREE_len, LZX_PRETREE_TABLEBITS, LZX_PRETREE_MAXSYMBOLS);
        if (z === 17) {
          let y = readBits(4) + 4;
          while (y--) lens[x++] = 0;
        } else if (z === 18) {
          let y = readBits(5) + 20;
          while (y--) lens[x++] = 0;
        } else if (z === 19) {
          let y = readBits(1) + 4;
          z = readHuffSym(state.PRETREE_table, state.PRETREE_len, LZX_PRETREE_TABLEBITS, LZX_PRETREE_MAXSYMBOLS);
          z = lens[x] - z;
          if (z < 0) z += 17;
          while (y--) lens[x++] = z;
        } else {
          z = lens[x] - z;
          if (z < 0) z += 17;
          lens[x++] = z;
        }
      }
    };

    /* --- main decode loop ------------------------------------------ */
    let togo = outLen;

    /* read header if necessary */
    if (!state.headerRead) {
      let i = 0, j = 0;
      const k = readBits(1);
      if (k) {
        i = readBits(16);
        j = readBits(16);
      }
      state.intelFilesize = ((i << 16) | j) | 0; /* or 0 if not encoded */
      state.headerRead = true;
    }

    while (togo > 0) {
      /* last block finished, new block expected */
      if (state.blockRemaining === 0) {
        if (state.blockType === LZX_BLOCKTYPE_UNCOMPRESSED) {
          if (state.blockLength & 1) inpos++; /* realign bitstream to word */
          bitbuf = 0;
          bitsleft = 0;
        }

        state.blockType = readBits(3);
        const hi = readBits(16);
        const lo = readBits(8);
        state.blockRemaining = state.blockLength = ((hi << 8) | lo) >>> 0;

        switch (state.blockType) {
          case LZX_BLOCKTYPE_ALIGNED:
            for (let i = 0; i < 8; i++) {
              state.ALIGNED_len[i] = readBits(3);
            }
            buildTable(LZX_ALIGNED_MAXSYMBOLS, LZX_ALIGNED_TABLEBITS, state.ALIGNED_len, state.ALIGNED_table, 'ALIGNED');
            /* falls through: rest of aligned header is same as verbatim */

          case LZX_BLOCKTYPE_VERBATIM:
            readLengths(state.MAINTREE_len, 0, 256);
            readLengths(state.MAINTREE_len, 256, state.mainElements);
            buildTable(LZX_MAINTREE_MAXSYMBOLS, LZX_MAINTREE_TABLEBITS, state.MAINTREE_len, state.MAINTREE_table, 'MAINTREE');
            if (state.MAINTREE_len[0xE8] !== 0) state.intelStarted = true;

            readLengths(state.LENGTH_len, 0, LZX_NUM_SECONDARY_LENGTHS);
            buildTable(LZX_LENGTH_MAXSYMBOLS, LZX_LENGTH_TABLEBITS, state.LENGTH_len, state.LENGTH_table, 'LENGTH');
            break;

          case LZX_BLOCKTYPE_UNCOMPRESSED:
            state.intelStarted = true; /* because we can't assume otherwise */
            ensureBits(16);            /* get up to 16 pad bits into the buffer */
            if (bitsleft > 16) inpos -= 2; /* and align the bitstream! */
            R0 = (inbuf[inpos] | (inbuf[inpos + 1] << 8) | (inbuf[inpos + 2] << 16) | (inbuf[inpos + 3] << 24)) >>> 0;
            inpos += 4;
            R1 = (inbuf[inpos] | (inbuf[inpos + 1] << 8) | (inbuf[inpos + 2] << 16) | (inbuf[inpos + 3] << 24)) >>> 0;
            inpos += 4;
            R2 = (inbuf[inpos] | (inbuf[inpos + 1] << 8) | (inbuf[inpos + 2] << 16) | (inbuf[inpos + 3] << 24)) >>> 0;
            inpos += 4;
            break;

          default:
            throw new LzxError(`illegal LZX block type ${state.blockType}`);
        }
      }

      /* buffer exhaustion check */
      if (inpos > endinp) {
        /* it's possible to have a file where the next run is less than 16
         * bits in size; the bit reader will overshoot but those bits are
         * not real data, so only fail if it overshot too far. */
        if (inpos > endinp + 2 || bitsleft < 16) {
          throw new LzxError('input buffer exhausted');
        }
      }

      let thisRun;
      while ((thisRun = state.blockRemaining) > 0 && togo > 0) {
        if (thisRun > togo) thisRun = togo;
        togo -= thisRun;
        state.blockRemaining -= thisRun;

        /* apply 2^x-1 mask */
        windowPosn &= windowSize - 1;
        /* runs can't straddle the window wraparound */
        if (windowPosn + thisRun > windowSize) {
          throw new LzxError('run straddles window wraparound');
        }

        switch (state.blockType) {
          case LZX_BLOCKTYPE_VERBATIM:
          case LZX_BLOCKTYPE_ALIGNED: {
            const aligned = state.blockType === LZX_BLOCKTYPE_ALIGNED;
            while (thisRun > 0) {
              let mainElement = readHuffSym(state.MAINTREE_table, state.MAINTREE_len, LZX_MAINTREE_TABLEBITS, LZX_MAINTREE_MAXSYMBOLS);

              if (mainElement < LZX_NUM_CHARS) {
                /* literal: 0 to LZX_NUM_CHARS-1 */
                window[windowPosn++] = mainElement;
                thisRun--;
                continue;
              }

              /* match: LZX_NUM_CHARS + ((slot<<3) | length_header (3 bits)) */
              mainElement -= LZX_NUM_CHARS;

              let matchLength = mainElement & LZX_NUM_PRIMARY_LENGTHS;
              if (matchLength === LZX_NUM_PRIMARY_LENGTHS) {
                const lengthFooter = readHuffSym(state.LENGTH_table, state.LENGTH_len, LZX_LENGTH_TABLEBITS, LZX_LENGTH_MAXSYMBOLS);
                matchLength += lengthFooter;
              }
              matchLength += LZX_MIN_MATCH;

              let matchOffset = mainElement >>> 3;

              if (matchOffset > 2) {
                if (aligned) {
                  const extra = EXTRA_BITS[matchOffset];
                  matchOffset = POSITION_BASE[matchOffset] - 2;
                  if (extra > 3) {
                    /* verbatim and aligned bits */
                    const verbatimBits = readBits(extra - 3);
                    matchOffset += verbatimBits << 3;
                    const alignedBits = readHuffSym(state.ALIGNED_table, state.ALIGNED_len, LZX_ALIGNED_TABLEBITS, LZX_ALIGNED_MAXSYMBOLS);
                    matchOffset += alignedBits;
                  } else if (extra === 3) {
                    /* aligned bits only */
                    const alignedBits = readHuffSym(state.ALIGNED_table, state.ALIGNED_len, LZX_ALIGNED_TABLEBITS, LZX_ALIGNED_MAXSYMBOLS);
                    matchOffset += alignedBits;
                  } else if (extra > 0) {
                    /* verbatim bits only */
                    matchOffset += readBits(extra);
                  } else {
                    matchOffset = 1;
                  }
                } else {
                  /* verbatim block: not repeated offset */
                  if (matchOffset !== 3) {
                    const extra = EXTRA_BITS[matchOffset];
                    const verbatimBits = readBits(extra);
                    matchOffset = POSITION_BASE[matchOffset] - 2 + verbatimBits;
                  } else {
                    matchOffset = 1;
                  }
                }
                /* update repeated offset LRU queue */
                R2 = R1;
                R1 = R0;
                R0 = matchOffset;
              } else if (matchOffset === 0) {
                matchOffset = R0;
              } else if (matchOffset === 1) {
                matchOffset = R1;
                R1 = R0;
                R0 = matchOffset;
              } else {
                /* matchOffset === 2 */
                matchOffset = R2;
                R2 = R0;
                R0 = matchOffset;
              }

              let rundest = windowPosn;
              let runsrc = rundest - matchOffset;
              windowPosn += matchLength;
              if (windowPosn > windowSize) throw new LzxError('match overruns window');
              thisRun -= matchLength;

              /* copy any wrapped-around source data */
              while (runsrc < 0 && matchLength-- > 0) {
                window[rundest++] = window[runsrc + windowSize];
                runsrc++;
              }
              /* copy match data. Non-overlapping ranges (offset >= length)
               * can use the engine's vectorized copyWithin. */
              if (matchLength > 0) {
                if (rundest - runsrc >= matchLength && matchLength > 12) {
                  window.copyWithin(rundest, runsrc, runsrc + matchLength);
                } else {
                  while (matchLength-- > 0) window[rundest++] = window[runsrc++];
                }
              }
            }
            break;
          }

          case LZX_BLOCKTYPE_UNCOMPRESSED: {
            if (inpos + thisRun > endinp) throw new LzxError('input overrun in stored block');
            window.set(inbuf.subarray(inpos, inpos + thisRun), windowPosn);
            inpos += thisRun;
            windowPosn += thisRun;
            break;
          }

          default:
            throw new LzxError('illegal LZX block type');
        }
      }
    }

    if (togo !== 0) throw new LzxError('should never happen: bytes left to decode');

    const outStart = ((windowPosn === 0 ? windowSize : windowPosn) - outLen);
    const output = window.slice(outStart, outStart + outLen);

    state.windowPosn = windowPosn;
    state.R0 = R0;
    state.R1 = R1;
    state.R2 = R2;

    /* intel E8 decoding */
    if (state.framesRead++ < 32768 && state.intelFilesize !== 0) {
      if (outLen <= 6 || !state.intelStarted) {
        state.intelCurpos += outLen;
      } else {
        const data = output;
        const dataend = outLen - 10;
        let curpos = state.intelCurpos;
        const filesize = state.intelFilesize;

        state.intelCurpos = curpos + outLen;

        let pos = 0;
        while (pos < dataend) {
          if (data[pos++] !== 0xE8) {
            curpos++;
            continue;
          }
          const absOff = (data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24)) | 0;
          if (absOff >= -curpos && absOff < filesize) {
            const relOff = absOff >= 0 ? absOff - curpos : absOff + filesize;
            data[pos] = relOff & 0xFF;
            data[pos + 1] = (relOff >> 8) & 0xFF;
            data[pos + 2] = (relOff >> 16) & 0xFF;
            data[pos + 3] = (relOff >> 24) & 0xFF;
          }
          pos += 4;
          curpos += 5;
        }
      }
    }

    return output;
  }
}

export default LzxState;
