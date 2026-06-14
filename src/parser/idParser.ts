/**
 * Online-ID parsing, faithful to SquadJS `core/id-parser`.
 *
 * Squad logs encode online identities inline, e.g.:
 *   `Online IDs: EOS: 000212a3...a5b steam: 12345678912345678`
 * This turns that fragment into `{ eosID, steamID }` style keys.
 */

const ID_MATCHER = /\s*([^\s:]+)\s*:\s*([^\s|)]+)/g;

export type OnlineIDs = {
  eosID?: string;
  steamID?: string;
  [k: string]: string | undefined;
};

/** "First letter upper + rest + ID", matching SquadJS (`EOS` -> `EOSID`, `steam` -> `SteamID`). */
export function capitalID(platform: string): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1) + 'ID';
}

/** Lowercased platform + ID (`EOS` -> `eosID`, `steam` -> `steamID`). */
export function lowerID(platform: string): string {
  return platform.toLowerCase() + 'ID';
}

/** Iterate the platform/id pairs found in an inline "Online IDs" fragment. */
export function iterateIDs(idsStr: string): Array<{ platform: string; id: string }> {
  const out: Array<{ platform: string; id: string }> = [];
  for (const m of idsStr.matchAll(ID_MATCHER)) {
    out.push({ platform: m[1], id: m[2] });
  }
  return out;
}

/** Convenience: parse an "Online IDs" fragment straight into `{ eosID, steamID }`. */
export function parseOnlineIDs(idsStr: string): OnlineIDs {
  const ids: OnlineIDs = {};
  for (const { platform, id } of iterateIDs(idsStr)) {
    ids[lowerID(platform)] = id;
  }
  return ids;
}
