import type { VehiclePool } from './pools.js';

/**
 * Vehicle classname -> Elo pool. The SquadStats documentation ships a 250+ row
 * lookup (Anhang 6.2); reproducing every skin verbatim is brittle (PDF line
 * wraps), so we combine a curated exact-match table for common vehicles with a
 * robust keyword classifier that generalizes to arbitrary classnames.
 *
 * "Transport"/"Logistics"/boats/bikes are unrated (return null).
 */

const EXACT: Record<string, VehiclePool> = {
  // MBTs
  M1A1: 'MBT',
  M1A1_USMC: 'MBT',
  M1A2: 'MBT',
  T62: 'MBT',
  T72B3: 'MBT',
  T72AV: 'MBT',
  M60T: 'MBT',
  '2A6': 'MBT',
  ZTZ99: 'MBT',
  Challenger2: 'MBT',
  // Heavy IFV
  BMP2: 'Heavy IFV',
  BMD4M: 'Heavy IFV',
  BFV: 'Heavy IFV',
  M1128: 'Heavy IFV',
  Sprut: 'Heavy IFV',
  ZBD04A: 'Heavy IFV',
  ZTD05: 'Heavy IFV',
  // Light IFV
  BMP1: 'Light IFV',
  BMD1M: 'Light IFV',
  LAV25: 'Light IFV',
  LAV6: 'Light IFV',
  M1126: 'Light IFV',
  BTR82A: 'Light IFV',
  ACV15: 'Light IFV',
  PARS3: 'Light IFV',
  ZBL08: 'Light IFV',
  ZBD05: 'Light IFV',
  // APC
  AAVP7A1: 'APC',
  BTR80: 'APC',
  MTLB: 'APC',
  M113A3: 'APC',
  LAV2_Coyote: 'APC',
  // Scout
  MATV: 'Scout',
  Tigr: 'Scout',
  MRAP: 'Scout',
  M1151: 'Scout',
  Cobra2: 'Scout',
  BRDM: 'Scout',
  TAPV: 'Scout',
  CSK131: 'Scout',
  // Heli
  UH1H: 'Heli',
  UH1Y: 'Heli',
  UH60: 'Heli',
  MI8: 'Heli',
  MI17: 'Heli',
  Z8G: 'Heli',
  Z8J: 'Heli'
};

const KEYWORDS: Array<[RegExp, VehiclePool]> = [
  [/m1a1|m1a2|t72|t62|t90|2a6|m60t|ztz99|leopard|challenger|abrams|leclerc|^t-?72|^t-?80/i, 'MBT'],
  [/bmp2|bmd4|\bbfv\b|bradley|m1128|sprut|zbd04|ztd05/i, 'Heavy IFV'],
  [/bmp1|bmd1|lav25|lav6|m1126|btr82|acv-?15|pars3|zbl08|zbd05/i, 'Light IFV'],
  [/aav|aavp7|btr80|btr-?d|mtlb|m113|coyote|btrm/i, 'APC'],
  [/matv|tigr|mrap|m1151|cobra2|brdm|tapv|csk131|tow|safir|spg9.*car|technical.*(m2|dshk|spg9|zu23)/i, 'Scout'],
  [/uh1|uh60|mi-?8|mi-?17|z8|ch-?146|blackhawk|huey|helicopter|\bheli\b/i, 'Heli']
];

const UNRATED = /logi|transport|truck|util|ural|kamaz|rhib|boat|bike|minsk|quad|gator|m-gator/i;

/** Returns the rated vehicle pool for a classname, or null if unrated. */
export function classifyVehicleType(classname: string | undefined): VehiclePool | null {
  if (!classname) return null;
  const base = classname.replace(/^BP_/, '').replace(/_C(_\d+)?$/, '');
  // exact match (case-insensitive) against curated table
  for (const [k, v] of Object.entries(EXACT)) {
    if (base.toLowerCase() === k.toLowerCase() || base.toLowerCase().startsWith(k.toLowerCase() + '_')) return v;
  }
  if (UNRATED.test(base) && !/btr-?d_kord|btr-?d_pkm/i.test(base)) {
    // logi/transport variants are unrated unless they are an armed APC variant
    if (!/(m2|dshk|kord|pkm|spg9|zu23|mg3|qjz|hj8|atgm)/i.test(base)) return null;
  }
  for (const [re, v] of KEYWORDS) if (re.test(base)) return v;
  return null;
}
