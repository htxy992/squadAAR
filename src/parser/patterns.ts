import { iterateIDs, capitalID } from './idParser.js';
import type { Pattern, ParserContext } from './store.js';
import type { Vec3 } from './events.js';

function rememberPlayer(ctx: ParserContext, ref: { eosID?: string; steamID?: string; name?: string; controller?: string; ip?: string }) {
  const { store } = ctx;
  if (ref.eosID) {
    const cur = store.players[ref.eosID] ?? {};
    store.players[ref.eosID] = { ...cur, ...ref };
    if (ref.controller) store.controllerToEOS[ref.controller] = ref.eosID;
    if (ref.name) store.nameToEOS[ref.name] = ref.eosID;
  }
}

function attackerIDsFrom(idsStr: string): { attackerEOSID?: string; attackerSteamID?: string } {
  const out: { attackerEOSID?: string; attackerSteamID?: string } = {};
  for (const { platform, id } of iterateIDs(idsStr)) {
    (out as any)['attacker' + capitalID(platform)] = id;
  }
  return out;
}

function vec(x: string, y: string, z: string): Vec3 {
  return { x: parseFloat(x), y: parseFloat(y), z: parseFloat(z) };
}

/* ------------------------------------------------------------------ *
 * VANILLA dedicated-server lines (syntax verified against SquadJS).
 * ------------------------------------------------------------------ */

const vanilla: Pattern[] = [
  {
    name: 'NEW_GAME',
    // LogWorld: Bringing World /Harju/Maps/Gameplay_Layers/Harju_RAAS_v1.Harju_RAAS_v1
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogWorld: Bringing World \/([A-z0-9]+)\/(?:Maps\/)?([A-z0-9-]+)\/(?:.+\/)?([A-z0-9-]+)(?:\.[A-z0-9-]+)/,
    handle: (m, ctx) => {
      if (m[5] === 'TransitionMap') return;
      ctx.emit({ type: 'NEW_GAME', ...ctx.base(m), dlc: m[3], mapClassname: m[4], layerClassname: m[5] });
    }
  },
  {
    name: 'ROUND_RESULT',
    // LogSquadGameEvents: Display: Team 1, <subfac> ( <fac> ) has won the match with 250 Tickets on layer <layer> (level <level>)!
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadGameEvents: Display: Team ([0-9]), (.*) \( ?(.*?) ?\) has (won|lost) the match with ([0-9]+) Tickets on layer (.*) \(level (.*)\)!/,
    handle: (m, ctx) => {
      const team = +m[3];
      const faction = m[5];
      const action = m[6];
      const tickets = +m[7];
      const layer = m[8];
      // Stash and emit a consolidated ROUND_ENDED when the winner line is seen.
      if (action === 'won') {
        ctx.emit({
          type: 'ROUND_ENDED',
          ...ctx.base(m),
          winnerTeam: team,
          winnerFaction: faction,
          tickets,
          layer
        });
      }
    }
  },
  {
    name: 'ROUND_ENDED_STATE',
    regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogGameState: Match State Changed from InProgress to WaitingPostMatch/,
    handle: (m, ctx) => {
      // Marker only; ROUND_RESULT already carries the winner. Kept for completeness.
    }
  },
  {
    name: 'PLAYER_CONNECTED',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: PostLogin: NewPlayer: .*?BP_PlayerController(?:|.+)_C .+PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs:([^)|]+)\|?([^)]*)\)/,
    handle: (m, ctx) => {
      const ids: Record<string, string> = {};
      for (const { platform, id } of iterateIDs(m[5] + ' ' + (m[6] ?? ''))) ids[platform.toLowerCase() + 'ID'] = id;
      const ref = { playercontroller: m[3], ip: m[4], eosID: ids.eosID, steamID: ids.steamID };
      rememberPlayer(ctx, { eosID: ids.eosID, steamID: ids.steamID, controller: m[3], ip: m[4] });
      ctx.store.joinRequests[ctx.base(m).chainID] = { eosID: ids.eosID, steamID: ids.steamID, controller: m[3], ip: m[4] };
      ctx.emit({ type: 'PLAYER_CONNECTED', ...ctx.base(m), playercontroller: m[3], ip: m[4], eosID: ids.eosID, steamID: ids.steamID });
    }
  },
  {
    name: 'JOIN_SUCCEEDED',
    regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogNet: Join succeeded: (.+)/,
    handle: (m, ctx) => {
      const chainID = ctx.base(m).chainID;
      const pending = ctx.store.joinRequests[chainID];
      delete ctx.store.joinRequests[chainID];
      const name = m[3];
      if (pending?.eosID) rememberPlayer(ctx, { ...pending, name });
      ctx.emit({
        type: 'JOIN_SUCCEEDED',
        ...ctx.base(m),
        playerSuffix: name,
        eosID: pending?.eosID,
        steamID: pending?.steamID,
        playercontroller: pending?.controller
      });
    }
  },
  {
    name: 'PLAYER_DISCONNECTED',
    regex:
      /^\[([\d.:-]+)]\[([ \d]*)]LogNet: UChannel::Close: Sending CloseBunch\..+RemoteAddr: ([\d.]+).+PC: (\w+PlayerController(?:|.+)_C_\d+),.+UniqueId: RedpointEOS:([\d\w]+)/,
    handle: (m, ctx) => {
      ctx.store.disconnected[m[5]] = true;
      ctx.emit({ type: 'PLAYER_DISCONNECTED', ...ctx.base(m), ip: m[3], playerController: m[4], eosID: m[5] });
    }
  },
  {
    name: 'PLAYER_POSSESS',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQPlayerController::)?OnPossess\(\): PC=(.+) \(Online IDs:([^)]+)\) Pawn=([A-z0-9_]+)_C/,
    handle: (m, ctx) => {
      const ids: Record<string, string> = {};
      for (const { platform, id } of iterateIDs(m[4])) ids[platform.toLowerCase() + 'ID'] = id;
      rememberPlayer(ctx, { eosID: ids.eosID, steamID: ids.steamID, name: m[3] });
      ctx.emit({ type: 'PLAYER_POSSESS', ...ctx.base(m), playerSuffix: m[3], possessClassname: m[5], eosID: ids.eosID, steamID: ids.steamID });
    }
  },
  {
    name: 'PLAYER_UNPOSSESS',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQPlayerController::)?OnUnPossess\(\): PC=(.+) \(Online IDs:([^)]+)\)/,
    handle: (m, ctx) => {
      if (m[4].includes('INVALID')) return;
      const ids: Record<string, string> = {};
      for (const { platform, id } of iterateIDs(m[4])) ids[platform.toLowerCase() + 'ID'] = id;
      ctx.emit({ type: 'PLAYER_UNPOSSESS', ...ctx.base(m), playerSuffix: m[3], eosID: ids.eosID });
    }
  },
  {
    name: 'PLAYER_DAMAGED',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: Player:(.+) ActualDamage=([0-9.]+) from (.+) \(Online IDs:([^|]+)\| Player Controller ID: ([^ ]+)\)caused by ([A-z_0-9-]+)_C/,
    handle: (m, ctx) => {
      if (m[6].includes('INVALID')) return;
      const atk = attackerIDsFrom(m[6]);
      const data = {
        victimName: m[3],
        damage: parseFloat(m[4]),
        attackerName: m[5],
        attackerController: m[7],
        weapon: m[8],
        ...atk
      };
      ctx.store.session[m[3]] = data;
      if (data.attackerEOSID) {
        const ref = ctx.store.players[data.attackerEOSID] ?? {};
        ref.controller = data.attackerController;
        ref.name = data.attackerName;
        ctx.store.players[data.attackerEOSID] = ref;
        ctx.store.nameToEOS[data.attackerName] = data.attackerEOSID;
      }
      ctx.emit({ type: 'PLAYER_DAMAGED', ...ctx.base(m), ...data });
    }
  },
  {
    name: 'PLAYER_WOUNDED',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Controller ID: ([\w\d]+)\) caused by ([A-z_0-9-]+)_C/,
    handle: (m, ctx) => {
      if (m[6].includes('INVALID')) return;
      const atk = attackerIDsFrom(m[6]);
      const prev = ctx.store.session[m[3]] ?? {};
      ctx.emit({
        type: 'PLAYER_WOUNDED',
        ...ctx.base(m),
        victimName: m[3],
        damage: parseFloat(m[4]),
        attackerPlayerController: m[5],
        weapon: m[8] || prev.weapon,
        attackerEOSID: atk.attackerEOSID ?? prev.attackerEOSID,
        attackerSteamID: atk.attackerSteamID ?? prev.attackerSteamID
      });
    }
  },
  {
    name: 'PLAYER_DIED',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQSoldier::)?Die\(\): Player:(.+) KillingDamage=(?:-)*([0-9.]+) from ([A-z_0-9]+) \(Online IDs:([^)|]+)\| Contoller ID: ([\w\d]+)\) caused by ([A-z_0-9-]+)_C/,
    handle: (m, ctx) => {
      if (m[6].includes('INVALID')) return;
      const atk = attackerIDsFrom(m[6]);
      const prev = ctx.store.session[m[3]] ?? {};
      ctx.emit({
        type: 'PLAYER_DIED',
        ...ctx.base(m),
        victimName: m[3],
        damage: parseFloat(m[4]),
        attackerPlayerController: m[5],
        weapon: m[8] || prev.weapon,
        attackerEOSID: atk.attackerEOSID ?? prev.attackerEOSID,
        attackerSteamID: atk.attackerSteamID ?? prev.attackerSteamID
      });
    }
  },
  {
    name: 'PLAYER_REVIVED',
    regex: /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquad: (.+) \(Online IDs:([^)]+)\) has revived (.+) \(Online IDs:([^)]+)\)\./,
    handle: (m, ctx) => {
      const reviver: Record<string, string> = {};
      for (const { platform, id } of iterateIDs(m[4])) reviver[platform.toLowerCase() + 'ID'] = id;
      const victim: Record<string, string> = {};
      for (const { platform, id } of iterateIDs(m[6])) victim[platform.toLowerCase() + 'ID'] = id;
      ctx.emit({
        type: 'PLAYER_REVIVED',
        ...ctx.base(m),
        reviverName: m[3],
        victimName: m[5],
        reviverEOSID: reviver.eosID,
        victimEOSID: victim.eosID
      });
    }
  },
  {
    name: 'DEPLOYABLE_DAMAGED',
    regex:
      /^\[([0-9.:-]+)]\[([ 0-9]*)]LogSquadTrace: \[DedicatedServer](?:ASQDeployable::)?TakeDamage\(\): ([A-z0-9_]+)_C_[0-9]+: ([0-9.]+) damage attempt by causer ([A-z0-9_]+)_C_[0-9]+ instigator (.+) with damage type ([A-z0-9_]+)_C health remaining ([0-9.-]+)/,
    handle: (m, ctx) => {
      ctx.emit({
        type: 'DEPLOYABLE_DAMAGED',
        ...ctx.base(m),
        deployable: m[3],
        damage: parseFloat(m[4]),
        weapon: m[5],
        playerSuffix: m[6],
        damageType: m[7],
        healthRemaining: parseFloat(m[8])
      });
    }
  }
];

/* ------------------------------------------------------------------ *
 * EXTENDED telemetry (`LogSquadStats:` lines) for the map replay.
 * See docs/LOG_FORMAT.md. A server plugin / the SquadStats SDK emits these.
 * ------------------------------------------------------------------ */

const N = '(-?[0-9.]+)';
const W = '([\\w.-]+)';
const EOS = '([0-9a-fA-F]+)';

const extended: Pattern[] = [
  {
    name: 'TICKETS',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: Tickets: team=(\\d) tickets=${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'TICKETS', ...ctx.base(m), team: +m[3], tickets: parseFloat(m[4]) })
  },
  {
    name: 'PLAYER_POS',
    regex: new RegExp(
      `^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: PlayerPos: eos=${EOS} ctrl=${W} pos=${N},${N},${N} yaw=${N} hp=${N} team=(\\d) squad=(\\d+) role=${W} state=(\\w+)`
    ),
    handle: (m, ctx) =>
      ctx.emit({
        type: 'PLAYER_POS',
        ...ctx.base(m),
        eosID: m[3],
        controller: m[4],
        pos: vec(m[5], m[6], m[7]),
        yaw: parseFloat(m[8]),
        health: parseFloat(m[9]),
        team: +m[10],
        squad: +m[11],
        role: m[12],
        state: m[13] as any
      })
  },
  {
    name: 'VEHICLE_POS',
    regex: new RegExp(
      `^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: VehiclePos: veh=${W} type=${W} pos=${N},${N},${N} yaw=${N} tyaw=${N} hp=${N}/${N} team=(\\d)`
    ),
    handle: (m, ctx) =>
      ctx.emit({
        type: 'VEHICLE_POS',
        ...ctx.base(m),
        vehicle: m[3],
        vehType: m[4],
        pos: vec(m[5], m[6], m[7]),
        yaw: parseFloat(m[8]),
        turretYaw: parseFloat(m[9]),
        health: parseFloat(m[10]),
        maxHealth: parseFloat(m[11]),
        team: +m[12]
      })
  },
  {
    name: 'VEHICLE_COMPONENT',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: VehicleComp: veh=${W} comp=${W} hp=${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'VEHICLE_COMPONENT', ...ctx.base(m), vehicle: m[3], component: m[4], health: parseFloat(m[5]) })
  },
  {
    name: 'VEHICLE_DAMAGE',
    regex: new RegExp(
      `^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: VehicleDamage: veh=${W} type=${W} attacker=${EOS} dmg=${N} dtype=${W} direct=([01])`
    ),
    handle: (m, ctx) =>
      ctx.emit({
        type: 'VEHICLE_DAMAGE',
        ...ctx.base(m),
        vehicle: m[3],
        vehType: m[4],
        attackerEOSID: m[5],
        damage: parseFloat(m[6]),
        damageType: m[7],
        direct: m[8] === '1'
      })
  },
  {
    name: 'CAPZONE',
    regex: new RegExp(
      `^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: CapZone: flag=${W} pos=${N},${N},${N} team=(\\d) progress=${N} status=${W}`
    ),
    handle: (m, ctx) =>
      ctx.emit({
        type: 'CAPZONE',
        ...ctx.base(m),
        flag: m[3],
        pos: vec(m[4], m[5], m[6]),
        team: +m[7],
        captureProgress: parseFloat(m[8]),
        status: m[9]
      })
  },
  {
    name: 'FLAG_CAPTURED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: FlagCaptured: flag=${W} team=(\\d) pos=${N},${N},${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'FLAG_CAPTURED', ...ctx.base(m), flag: m[3], team: +m[4], pos: vec(m[5], m[6], m[7]) })
  },
  {
    name: 'FOB_CREATED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: FobCreated: fob=${W} team=(\\d) pos=${N},${N},${N} creator=${EOS}`),
    handle: (m, ctx) =>
      ctx.emit({ type: 'FOB_CREATED', ...ctx.base(m), fob: m[3], team: +m[4], pos: vec(m[5], m[6], m[7]), creatorEOSID: m[8] })
  },
  {
    name: 'FOB_DESTROYED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: FobDestroyed: fob=${W} team=(\\d) pos=${N},${N},${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'FOB_DESTROYED', ...ctx.base(m), fob: m[3], team: +m[4], pos: vec(m[5], m[6], m[7]) })
  },
  {
    name: 'SPAWN_CREATED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: SpawnCreated: kind=${W} team=(\\d) squad=(\\d+) pos=${N},${N},${N}`),
    handle: (m, ctx) =>
      ctx.emit({ type: 'SPAWN_CREATED', ...ctx.base(m), kind: m[3], team: +m[4], squad: +m[5], pos: vec(m[6], m[7], m[8]) })
  },
  {
    name: 'PLAYER_SPAWN',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: PlayerSpawn: eos=${EOS} spawn=${W} pos=${N},${N},${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'PLAYER_SPAWN', ...ctx.base(m), eosID: m[3], spawnName: m[4], pos: vec(m[5], m[6], m[7]) })
  },
  {
    name: 'PLAYER_ROLE',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: PlayerRole: eos=${EOS} role=${W} lead=([01])`),
    handle: (m, ctx) => ctx.emit({ type: 'PLAYER_ROLE', ...ctx.base(m), eosID: m[3], role: m[4], isLead: m[5] === '1' })
  },
  {
    name: 'SQUAD_CREATED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: SquadCreated: team=(\\d) squad=(\\d+) name=${W} creator=${EOS}`),
    handle: (m, ctx) =>
      ctx.emit({ type: 'SQUAD_CREATED', ...ctx.base(m), team: +m[3], squadID: +m[4], squadName: m[5], creatorEOSID: m[6] })
  },
  {
    name: 'AMMO_DELIVERY',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: AmmoDelivery: fob=${W} eos=${EOS} amount=${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'AMMO_DELIVERY', ...ctx.base(m), fob: m[3], eosID: m[4], amount: parseFloat(m[5]) })
  },
  {
    name: 'MAP_MARKER',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: MapMarker: eos=${EOS} type=${W} pos=${N},${N},${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'MAP_MARKER', ...ctx.base(m), eosID: m[3], markerType: m[4], pos: vec(m[5], m[6], m[7]) })
  },
  {
    name: 'DEPLOYABLE_CREATED',
    regex: new RegExp(`^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: Deployable: type=${W} team=(\\d) pos=${N},${N},${N}`),
    handle: (m, ctx) => ctx.emit({ type: 'DEPLOYABLE_CREATED', ...ctx.base(m), deplType: m[3], team: +m[4], pos: vec(m[5], m[6], m[7]) })
  },
  {
    name: 'PROJECTILE',
    // LogSquadStats: Projectile: shooter=<eos> weapon=<w> from=x,y,z to=x,y,z speed=<v> hit=<0|1> victim=<eos|->
    regex: new RegExp(
      `^\\[([0-9.:-]+)]\\[([ 0-9]*)]LogSquadStats: Projectile: shooter=${EOS} weapon=${W} from=${N},${N},${N} to=${N},${N},${N} speed=${N} hit=([01]) victim=([0-9a-fA-F-]+)`
    ),
    handle: (m, ctx) =>
      ctx.emit({
        type: 'PROJECTILE',
        ...ctx.base(m),
        shooterEOSID: m[3],
        weapon: m[4],
        from: vec(m[5], m[6], m[7]),
        to: vec(m[8], m[9], m[10]),
        speed: parseFloat(m[11]),
        hit: m[12] === '1',
        victimEOSID: m[13] === '-' ? undefined : m[13]
      })
  }
];

export const patterns: Pattern[] = [...vanilla, ...extended];
