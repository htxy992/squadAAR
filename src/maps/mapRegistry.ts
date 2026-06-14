/**
 * Per-map world<->image calibration, using the real Squad SDK minimap bounds
 * (the same corner data SquadCalc uses). World coordinates in Squad logs are
 * centimetres; SDK corners are metres, so bounds below are corner*100.
 *
 * `assetKey` matches the SquadCalc/SDK folder name. If a real minimap image is
 * present at web/assets/maps/<assetKey>/basemap.webp (fetch via `npm run
 * fetch:maps`), the UI renders it; otherwise it renders reconstructed terrain.
 */

export interface MapInfo {
  keys: string[];
  name: string;
  assetKey: string;
  sizeMeters: number;
  world: { minX: number; minY: number; maxX: number; maxY: number };
  /** elevation range (metres) used to scale a grayscale heightmap into a DEM */
  heightMin?: number;
  heightMax?: number;
}

const M = 100; // metres -> centimetres
function mk(
  name: string,
  assetKey: string,
  keys: string[],
  c0: [number, number],
  c1: [number, number],
  height?: [number, number]
): MapInfo {
  return {
    name,
    assetKey,
    keys,
    sizeMeters: Math.round(c1[0] - c0[0]),
    world: { minX: c0[0] * M, minY: c0[1] * M, maxX: c1[0] * M, maxY: c1[1] * M },
    heightMin: height?.[0],
    heightMax: height?.[1]
  };
}

export const MAPS: MapInfo[] = [
  mk('Al Basrah', 'albasrah', ['albasrah', 'al_basrah', 'basrah'], [-2000, -2000], [2000, 2000]),
  mk('Anvil', 'anvil', ['anvil'], [-2040, -2040], [1020, 1020]),
  mk('Black Coast', 'blackcoast', ['blackcoast', 'black_coast'], [-2299, -2127], [2299, 2472]),
  mk('Chora', 'chora', ['chora'], [-2464, -2664], [1600, 1400]),
  mk('Fallujah', 'fallujah', ['fallujah'], [-1315, -1545], [1690, 1460]),
  mk('Fools Road', 'foolsroad', ['fools', 'foolsroad'], [-1604, -1636], [1396, 1364]),
  mk('Goose Bay', 'goosebay', ['goosebay', 'goose_bay'], [-2016, -2016], [2015, 2015]),
  mk('Gorodok', 'gorodok', ['gorodok'], [-2032, -2032], [2032, 2032]),
  mk('Harju', 'harju', ['harju'], [-2016, -2016], [2016, 2016], [0, 70]),
  mk('Kamdesh', 'kamdesh', ['kamdesh'], [-2024, -2024], [2024, 2024]),
  mk('Kohat', 'kohat', ['kohat'], [-2300, -2300], [2317, 2317]),
  mk('Kokan', 'kokan', ['kokan'], [-1334, -1334], [1334, 1334]),
  mk('Lashkar', 'lashkar', ['lashkar'], [-2755, -2755], [2245, 2245]),
  mk('Logar', 'logar', ['logar'], [-849, -849], [851, 851]),
  mk('Manicouagan', 'manicouagan', ['manicouagan'], [-2016, -2016], [2015, 2015]),
  mk('Mestia', 'mestia', ['mestia'], [-1316, -1316], [1316, 1316]),
  mk('Mutaha', 'mutaha', ['mutaha'], [-935, -1140], [1820, 1615]),
  mk('Narva', 'narva', ['narva'], [-1390, -1402], [1410, 1398]),
  mk('Sanxian Islands', 'sanxian', ['sanxian'], [-2300, -2050], [2300, 2550]),
  mk('Skorpo', 'skorpo', ['skorpo'], [-3611, -3293], [3238, 3576]),
  mk('Sumari', 'sumari', ['sumari'], [-1287, -1267], [1313, 1333]),
  mk('Tallil Outskirts', 'tallil', ['tallil'], [-2340, -2340], [2340, 2340]),
  mk('Yehorivka', 'yehorivka', ['yehorivka'], [-3302, -3302], [3048, 3048])
];

const FALLBACK: MapInfo = mk('Unknown', '', [], [-1500, -1500], [1500, 1500]);

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
