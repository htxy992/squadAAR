/**
 * Per-map world<->image calibration.
 *
 * Squad world coordinates are centimetres in an axis-aligned frame. To draw on a
 * (square) minimap image we need the world bounds that the image covers. UE's Y
 * axis points "down→up" opposite to image pixel Y, so the transform flips Y.
 *
 * The bounds below are reasonable defaults; for pixel-perfect overlay on a real
 * captured minimap, calibrate `world` to that image's corners.
 */

export interface MapInfo {
  /** layer/classname keys this entry matches (case-insensitive substring) */
  keys: string[];
  /** display name */
  name: string;
  /** size of one map side in metres (for the grid + scale) */
  sizeMeters: number;
  /** world bounds in centimetres covered by the (square) minimap image */
  world: { minX: number; minY: number; maxX: number; maxY: number };
  /** optional minimap image filename under web/assets/maps (else procedural grid) */
  image?: string;
}

const DEFAULT_SIZE = 3000; // metres
function squareBounds(sizeMeters: number) {
  const half = (sizeMeters * 100) / 2; // cm
  return { minX: -half, minY: -half, maxX: half, maxY: half };
}

export const MAPS: MapInfo[] = [
  { keys: ['harju'], name: 'Harju', sizeMeters: 3000, world: squareBounds(3000) },
  { keys: ['narva'], name: 'Narva', sizeMeters: 2900, world: squareBounds(2900) },
  { keys: ['blackcoast', 'black_coast'], name: 'Black Coast', sizeMeters: 3600, world: squareBounds(3600) },
  { keys: ['gorodok'], name: 'Gorodok', sizeMeters: 4000, world: squareBounds(4000) },
  { keys: ['yehorivka'], name: 'Yehorivka', sizeMeters: 5000, world: squareBounds(5000) },
  { keys: ['mutaha'], name: 'Mutaha', sizeMeters: 2800, world: squareBounds(2800) },
  { keys: ['goosebay', 'goose_bay'], name: 'Goose Bay', sizeMeters: 4200, world: squareBounds(4200) },
  { keys: ['manicouagan'], name: 'Manicouagan', sizeMeters: 4000, world: squareBounds(4000) },
  { keys: ['kohat'], name: 'Kohat', sizeMeters: 4500, world: squareBounds(4500) },
  { keys: ['fallujah'], name: 'Fallujah', sizeMeters: 3200, world: squareBounds(3200) },
  { keys: ['albasrah', 'al_basrah', 'basrah'], name: 'Al Basrah', sizeMeters: 3200, world: squareBounds(3200) },
  { keys: ['tallil'], name: 'Tallil Outskirts', sizeMeters: 3600, world: squareBounds(3600) },
  { keys: ['skorpo'], name: 'Skorpo', sizeMeters: 4500, world: squareBounds(4500) },
  { keys: ['chora'], name: 'Chora', sizeMeters: 4000, world: squareBounds(4000) },
  { keys: ['anvil'], name: 'Anvil', sizeMeters: 3300, world: squareBounds(3300) },
  { keys: ['sanxian'], name: 'Sanxian Islands', sizeMeters: 3600, world: squareBounds(3600) }
];

const FALLBACK: MapInfo = { keys: [], name: 'Unknown', sizeMeters: DEFAULT_SIZE, world: squareBounds(DEFAULT_SIZE) };

/** Resolve map info from a layer or map classname (e.g. "Harju_RAAS_v1"). */
export function resolveMap(layerOrMap: string | undefined): MapInfo {
  if (!layerOrMap) return FALLBACK;
  const s = layerOrMap.toLowerCase();
  for (const m of MAPS) if (m.keys.some((k) => s.includes(k))) return m;
  return { ...FALLBACK, name: layerOrMap };
}

/** Project a world (x,y) in cm to normalized [0,1] image coords (y flipped). */
export function worldToNorm(map: MapInfo, x: number, y: number): { nx: number; ny: number } {
  const { minX, minY, maxX, maxY } = map.world;
  const nx = (x - minX) / (maxX - minX);
  const ny = 1 - (y - minY) / (maxY - minY);
  return { nx: clamp01(nx), ny: clamp01(ny) };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
