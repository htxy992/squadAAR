import type { Vec3 } from '../parser/events.js';
import type { GeometryProvider } from '../geometry/provider.js';

/**
 * Projectile detection / tracking with plausibility scoring.
 *
 * Squad's vanilla logs don't contain per-shot data, so a "projectile" here is
 * reconstructed from either (a) explicit `LogSquadStats: Projectile:` telemetry
 * or (b) a hit/kill pair (attacker position -> victim position at impact time).
 *
 * Each projectile is scored for *plausibility* using three signals:
 *   1. Sightline / occlusion - does the straight line clear the terrain between
 *      shooter and target? We lack a real heightmap, so we estimate ground
 *      height from every observed entity position (a sparse point cloud) and
 *      check whether the shot passes through a hill.
 *   2. Height / elevation - implausible vertical angles for the weapon class.
 *   3. Range - distance beyond the weapon's plausible maximum.
 *
 * The result feeds both the map replay (drawn tracers) and the Auto-Mod / AAR
 * analysis panel (flagging suspicious shots, e.g. wallbangs / impossible LOS).
 */

export interface WeaponClassInfo {
  family: 'rifle' | 'mg' | 'sniper' | 'pistol' | 'at' | 'tank' | 'grenade' | 'explosive' | 'unknown';
  /** plausible maximum engagement range in metres */
  maxRangeM: number;
  /** typical muzzle velocity m/s (informational) */
  muzzleMps: number;
  /** is this a (mostly) line-of-sight direct-fire weapon? */
  directFire: boolean;
}

export function classifyWeapon(weaponRaw: string | undefined): WeaponClassInfo {
  const w = (weaponRaw ?? '').toLowerCase();
  if (/m107|sniper|svd|m110|sr-?25|ballistic|\.50|barrett/.test(w)) return { family: 'sniper', maxRangeM: 1500, muzzleMps: 850, directFire: true };
  if (/pkp|pkm|m240|m249|rpk|mg3|qjy|saw|lmg|hmg|kord|dshk|nsv|browning|m2hb/.test(w)) return { family: 'mg', maxRangeM: 1200, muzzleMps: 850, directFire: true };
  if (/rpg|at4|law|maaws|carl|tow|kornet|spg9|hj8|atgm|nlaw|panzerfaust|smaw/.test(w)) return { family: 'at', maxRangeM: 2500, muzzleMps: 300, directFire: true };
  if (/cannon|sabot|heat|main_?gun|125mm|120mm|105mm|100mm|30mm|25mm|autocannon|coax/.test(w)) return { family: 'tank', maxRangeM: 3500, muzzleMps: 1400, directFire: true };
  if (/grenade|gl|m203|gp25|ugl|frag|m67/.test(w)) return { family: 'grenade', maxRangeM: 400, muzzleMps: 76, directFire: false };
  if (/mortar|artillery|airstrike|hellfire|rocket_pod|s8|bomb|ied|mine|c4/.test(w)) return { family: 'explosive', maxRangeM: 99999, muzzleMps: 0, directFire: false };
  if (/pistol|m9|glock|makarov|m1911/.test(w)) return { family: 'pistol', maxRangeM: 120, muzzleMps: 360, directFire: true };
  if (/ak|m4|m16|g3|hk|rifle|carbine|aug|fal|qbz|scar|svt|mk17|sks|762|556|545/.test(w)) return { family: 'rifle', maxRangeM: 800, muzzleMps: 880, directFire: true };
  return { family: 'unknown', maxRangeM: 1500, muzzleMps: 700, directFire: true };
}

/* ----------------------------- terrain field ----------------------------- */

export interface TerrainField {
  grid: number; // cells per side
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** ground-height proxy per cell (cm); NaN where unknown then filled */
  cells: Float64Array;
  coverage: number; // fraction of cells with observed data
}

const STAND_OFFSET_CM = 90; // capsule half-height: entities float ~1m above ground

export function buildTerrainField(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  points: Vec3[],
  grid = 64
): TerrainField {
  const cells = new Float64Array(grid * grid).fill(NaN);
  const counts = new Int32Array(grid * grid);
  const cx = (x: number) => Math.min(grid - 1, Math.max(0, Math.floor(((x - bounds.minX) / (bounds.maxX - bounds.minX)) * grid)));
  const cy = (y: number) => Math.min(grid - 1, Math.max(0, Math.floor(((y - bounds.minY) / (bounds.maxY - bounds.minY)) * grid)));
  for (const p of points) {
    const i = cy(p.y) * grid + cx(p.x);
    const g = p.z - STAND_OFFSET_CM;
    // keep the MIN observed ground proxy per cell (lowest = closest to true ground)
    if (Number.isNaN(cells[i]) || g < cells[i]) cells[i] = g;
    counts[i]++;
  }
  let observed = 0;
  for (let i = 0; i < cells.length; i++) if (!Number.isNaN(cells[i])) observed++;
  // fill gaps by iterative neighbour averaging (cheap diffusion)
  const filled = Float64Array.from(cells);
  const globalMean = avgDefined(cells);
  for (let i = 0; i < filled.length; i++) if (Number.isNaN(filled[i])) filled[i] = globalMean;
  for (let pass = 0; pass < 12; pass++) {
    for (let y = 0; y < grid; y++) {
      for (let x = 0; x < grid; x++) {
        const i = y * grid + x;
        if (!Number.isNaN(cells[i])) continue; // keep observed
        let s = 0,
          n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && nx < grid && ny >= 0 && ny < grid) {
            s += filled[ny * grid + nx];
            n++;
          }
        }
        if (n) filled[i] = s / n;
      }
    }
  }
  return { grid, ...bounds, cells: filled, coverage: observed / cells.length };
}

function avgDefined(a: Float64Array): number {
  let s = 0,
    n = 0;
  for (const v of a) if (!Number.isNaN(v)) (s += v), n++;
  return n ? s / n : 0;
}

export function terrainHeightAt(f: TerrainField, x: number, y: number): number {
  const gx = ((x - f.minX) / (f.maxX - f.minX)) * f.grid - 0.5;
  const gy = ((y - f.minY) / (f.maxY - f.minY)) * f.grid - 0.5;
  const x0 = Math.floor(gx),
    y0 = Math.floor(gy);
  const tx = gx - x0,
    ty = gy - y0;
  const at = (cx: number, cy: number) => {
    const ix = Math.min(f.grid - 1, Math.max(0, cx));
    const iy = Math.min(f.grid - 1, Math.max(0, cy));
    return f.cells[iy * f.grid + ix];
  };
  const h00 = at(x0, y0),
    h10 = at(x0 + 1, y0),
    h01 = at(x0, y0 + 1),
    h11 = at(x0 + 1, y0 + 1);
  return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
}

/* --------------------------- projectile analysis ------------------------- */

export interface Plausibility {
  score: number; // 0..1 (1 = perfectly plausible)
  flags: string[];
  occlusionDepthM: number; // how far the line dips below terrain (m)
  rangeM: number;
  elevationDeg: number;
  withinRange: boolean;
  hasLineOfSight: boolean;
}

const OCCLUSION_MARGIN_CM = 150; // tolerance for noisy ground proxy

export function analyzeProjectile(
  field: TerrainField,
  from: Vec3,
  to: Vec3,
  weapon: WeaponClassInfo,
  samples = 24,
  geomProvider?: GeometryProvider
): Plausibility {
  const dx = to.x - from.x,
    dy = to.y - from.y,
    dz = to.z - from.z;
  const dist2d = Math.hypot(dx, dy);
  const dist3d = Math.hypot(dx, dy, dz);
  const rangeM = dist3d / 100;
  const elevationDeg = (Math.atan2(dz, dist2d) * 180) / Math.PI;

  // sightline occlusion: sample interior points, compare line height vs terrain
  let maxPenCm = 0;
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    const px = from.x + dx * t;
    const py = from.y + dy * t;
    const lineZ = from.z + dz * t;
    const ground = terrainHeightAt(field, px, py);
    const pen = ground + OCCLUSION_MARGIN_CM - lineZ; // >0 means line is below terrain
    if (pen > maxPenCm) maxPenCm = pen;
  }
  const occlusionDepthM = Math.max(0, maxPenCm / 100);
  // direct-fire weapons require LOS; lobbed/explosive weapons don't.
  const losRequired = weapon.directFire;
  const terrainClear = occlusionDepthM < 1.0;
  // building LOS: if we have SDK geometry, also check structural occlusion
  const buildingClear = !losRequired || !geomProvider || geomProvider.segmentClear(from, to);
  const hasLineOfSight = !losRequired || (terrainClear && buildingClear);

  const withinRange = rangeM <= weapon.maxRangeM;

  const flags: string[] = [];
  let score = 1;

  if (losRequired && occlusionDepthM >= 1.0) {
    flags.push(`no line-of-sight (terrain blocks shot by ~${occlusionDepthM.toFixed(0)}m)`);
    score -= Math.min(0.7, 0.25 + occlusionDepthM / 40);
  }
  if (losRequired && !buildingClear) {
    flags.push('no line-of-sight (building geometry blocks shot)');
    score -= 0.6;
  }
  if (!withinRange) {
    const over = rangeM / weapon.maxRangeM;
    flags.push(`beyond plausible range (${rangeM.toFixed(0)}m > ${weapon.maxRangeM}m for ${weapon.family})`);
    score -= Math.min(0.6, 0.2 + (over - 1) * 0.5);
  }
  if (losRequired && Math.abs(elevationDeg) > 55 && rangeM > 50) {
    flags.push(`extreme vertical angle (${elevationDeg.toFixed(0)}°)`);
    score -= 0.25;
  }
  // confidence is lower where terrain coverage is sparse -> soften occlusion penalty
  if (field.coverage < 0.08 && flags.some((f) => f.startsWith('no line-of-sight'))) {
    score += 0.1;
    flags.push('(low terrain coverage — occlusion uncertain)');
  }

  score = Math.max(0, Math.min(1, score));
  return { score, flags, occlusionDepthM, rangeM, elevationDeg, withinRange, hasLineOfSight };
}
