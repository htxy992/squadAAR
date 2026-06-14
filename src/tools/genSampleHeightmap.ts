/**
 * Synthesize a 16-bit grayscale heightmap PNG for the sample round (Harju) that
 * exactly matches the terrain used by the log generator, so the demo shows the
 * real-DEM pipeline end to end (crisp hillshade/contours + pixel-exact
 * line-of-sight and engagement profiles).
 *
 * For real maps, drop the in-game heightmap.png in place instead.
 */
import { terrainZ } from './generateSampleLog.js';
import { resolveMap } from '../maps/mapRegistry.js';
import { encodeGrayPNG16, writeHeightmapPNG } from '../maps/heightmap.js';

export async function writeSampleHeightmap(): Promise<string> {
  const map = resolveMap('Harju_RAAS_v1');
  const W = 512, H = 512;
  const hMin = map.heightMin ?? 0;
  const hMax = map.heightMax ?? 70;
  const range = hMax - hMin || 1;
  const data = new Float64Array(W * H);
  const { minX, minY, maxX, maxY } = map.world;
  for (let py = 0; py < H; py++) {
    // image row 0 = north (maxY)
    const wy = minY + ((H - 1 - py + 0.5) / H) * (maxY - minY);
    for (let px = 0; px < W; px++) {
      const wx = minX + ((px + 0.5) / W) * (maxX - minX);
      const m = terrainZ(wx, wy) / 100; // cm -> m
      data[py * W + px] = Math.max(0, Math.min(1, (m - hMin) / range));
    }
  }
  const png = encodeGrayPNG16(W, H, data);
  return writeHeightmapPNG(map.assetKey, png);
}

if (process.argv[1] && process.argv[1].includes('genSampleHeightmap')) {
  const f = await writeSampleHeightmap();
  console.log('Wrote', f);
}
