import { promises as fs } from 'node:fs';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { TerrainField } from '../analysis/ballistics.js';
import type { MapInfo } from './mapRegistry.js';

/**
 * Real DEM support: decode a grayscale heightmap PNG into a TerrainField so the
 * whole system (hillshade, contours, line-of-sight occlusion, the "why you
 * died" elevation profile) uses pixel-exact terrain instead of the
 * position-reconstructed estimate.
 *
 * Squad/SquadCalc ship heightmaps as grayscale images (often 16-bit for
 * precision); height in metres = heightMin + sample01 * (heightMax - heightMin).
 * A minimal dependency-free PNG codec is included (encoder is used to synthesize
 * a matching heightmap for the demo + tests).
 */

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export interface DecodedGray {
  width: number;
  height: number;
  /** normalized 0..1 sample of channel 0, row-major (row 0 = top) */
  data: Float64Array;
}

export function decodePNGGray(buf: Buffer): DecodedGray {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 8, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
      interlace = data.readUInt8(12);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (interlace !== 0) throw new Error('interlaced PNG not supported');
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample;
  const rowBytes = width * bpp;
  const out = new Float64Array(width * height);
  const maxVal = bitDepth === 16 ? 65535 : 255;
  const prev = new Uint8Array(rowBytes);
  const cur = new Uint8Array(rowBytes);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < rowBytes; x++) cur[x] = raw[p++];
    unfilter(filter, cur, prev, bpp);
    for (let x = 0; x < width; x++) {
      const i = x * bpp;
      const v = bytesPerSample === 2 ? (cur[i] << 8) | cur[i + 1] : cur[i];
      out[y * width + x] = v / maxVal;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

function unfilter(filter: number, cur: Uint8Array, prev: Uint8Array, bpp: number) {
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let val = cur[i];
    switch (filter) {
      case 1: val += a; break;
      case 2: val += b; break;
      case 3: val += (a + b) >> 1; break;
      case 4: val += paeth(a, b, c); break;
    }
    cur[i] = val & 0xff;
  }
}
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode a 16-bit grayscale PNG from normalized (0..1) row-major data. */
export function encodeGrayPNG16(width: number, height: number, data01: Float64Array | number[]): Buffer {
  const rowBytes = width * 2;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const v = Math.max(0, Math.min(65535, Math.round((data01[y * width + x] as number) * 65535)));
      raw[p++] = (v >> 8) & 0xff;
      raw[p++] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(16, 8); // bit depth
  ihdr.writeUInt8(0, 9); // color type: grayscale
  const chunks = [PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Build a TerrainField (cm) from a decoded heightmap, downsampled to `grid`. */
export function fieldFromHeights(
  dec: DecodedGray,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  heightMinM: number,
  heightMaxM: number,
  grid = 128
): TerrainField {
  const cells = new Float64Array(grid * grid);
  const range = heightMaxM - heightMinM;
  for (let cy = 0; cy < grid; cy++) {
    // cy = 0 -> south (minY); image row 0 -> north (maxY) => srow from (1 - fy)
    const fy = (cy + 0.5) / grid;
    const srow = Math.min(dec.height - 1, Math.floor((1 - fy) * dec.height));
    for (let cx = 0; cx < grid; cx++) {
      const fx = (cx + 0.5) / grid;
      const scol = Math.min(dec.width - 1, Math.floor(fx * dec.width));
      const norm = dec.data[srow * dec.width + scol];
      cells[cy * grid + cx] = (heightMinM + norm * range) * 100; // cm
    }
  }
  return { grid, ...bounds, cells, coverage: 1 };
}

/** Load web/assets/maps/<assetKey>/heightmap.png as a TerrainField, or null. */
export function tryLoadHeightmapField(map: MapInfo): TerrainField | null {
  if (!map.assetKey) return null;
  const file = path.resolve(process.cwd(), 'web/assets/maps', map.assetKey, 'heightmap.png');
  try {
    if (!fsSync.existsSync(file)) return null;
    const dec = decodePNGGray(fsSync.readFileSync(file));
    return fieldFromHeights(dec, map.world, map.heightMin ?? 0, map.heightMax ?? 300);
  } catch {
    return null;
  }
}

export async function writeHeightmapPNG(assetKey: string, png: Buffer): Promise<string> {
  const dir = path.resolve(process.cwd(), 'web/assets/maps', assetKey);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'heightmap.png');
  await fs.writeFile(file, png);
  return file;
}
