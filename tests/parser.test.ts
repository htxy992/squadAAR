import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLog } from '../src/parser/logParser.js';
import { parseOnlineIDs, iterateIDs } from '../src/parser/idParser.js';

const TS = '2026.06.10-19.04.52:000';
const P = (n: number, body: string) => `[${TS}][${String(n).padStart(3, ' ')}]${body}`;
const EOS_A = '000212a3456b789cdef1a23b4cdefa5b';
const EOS_B = '00025de4e8ab4c54b579fe7480af6697';

test('idParser parses inline EOS/steam ids', () => {
  const ids = parseOnlineIDs('EOS: ' + EOS_A + ' steam: 76561198000000001');
  assert.equal(ids.eosID, EOS_A);
  assert.equal(ids.steamID, '76561198000000001');
  assert.equal(iterateIDs('EOS: x steam: y').length, 2);
});

test('parses canonical dedicated-server lines', () => {
  const lines = [
    P(1, 'LogWorld: Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1.Harju_RAAS_v1'),
    P(2, `LogSquadTrace: [DedicatedServer]ASQPlayerController::OnPossess(): PC=Chad (Online IDs: EOS: ${EOS_B} steam: 76561198000000002) Pawn=BP_Soldier_RU_Rifleman1_C_222`),
    P(3, `LogSquad: Player:Chad ActualDamage=56.000000 from MilSim (Online IDs: EOS: ${EOS_A} steam: 76561198000000001 | Player Controller ID: BP_PlayerController_C_111)caused by BP_AK74M_C`),
    P(3, `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:Chad KillingDamage=-56.000000 from BP_PlayerController_C_111 (Online IDs: EOS: ${EOS_A} steam: 76561198000000001 | Controller ID: BP_PlayerController_C_111) caused by BP_Soldier_RU_Rifleman1_C`),
    P(4, `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:Chad KillingDamage=-100.000000 from BP_PlayerController_C_111 (Online IDs: EOS: ${EOS_A} steam: 76561198000000001 | Contoller ID: BP_PlayerController_C_111) caused by BP_Soldier_RU_Rifleman1_C`),
    P(5, `LogSquad: Medic1 (Online IDs: EOS: ${EOS_A} steam: 76561198000000001) has revived Chad (Online IDs: EOS: ${EOS_B} steam: 76561198000000002).`),
    P(6, 'LogSquadGameEvents: Display: Team 1, USA ( US Army ) has won the match with 200 Tickets on layer Harju RAAS v1 (level Harju)!')
  ];
  const { events } = parseLog(lines);
  const by = (t: string) => events.filter((e) => e.type === t);

  assert.equal(by('NEW_GAME').length, 1);
  assert.equal((by('NEW_GAME')[0] as any).layerClassname, 'Harju_RAAS_v1');

  const dmg = by('PLAYER_DAMAGED')[0] as any;
  assert.equal(dmg.victimName, 'Chad');
  assert.equal(dmg.damage, 56);
  assert.equal(dmg.attackerEOSID, EOS_A);

  const wound = by('PLAYER_WOUNDED')[0] as any;
  assert.equal(wound.victimName, 'Chad');
  assert.equal(wound.attackerEOSID, EOS_A);

  const died = by('PLAYER_DIED')[0] as any;
  assert.equal(died.attackerEOSID, EOS_A);

  const rev = by('PLAYER_REVIVED')[0] as any;
  assert.equal(rev.reviverEOSID, EOS_A);
  assert.equal(rev.victimEOSID, EOS_B);

  const end = by('ROUND_ENDED')[0] as any;
  assert.equal(end.winnerTeam, 1);
  assert.equal(end.winnerFaction, 'US Army');
  assert.equal(end.tickets, 200);
});

test('parses extended telemetry lines', () => {
  const lines = [
    P(1, `LogSquadStats: PlayerPos: eos=${EOS_A} ctrl=BP_PlayerController_C_111 pos=100.0,-200.5,300.0 yaw=45.0 hp=88.0 team=2 squad=3 role=RU_Rifleman_01 state=alive`),
    P(2, `LogSquadStats: Projectile: shooter=${EOS_A} weapon=BP_M110 from=0.0,0.0,200.0 to=1000.0,0.0,210.0 speed=850 hit=1 victim=${EOS_B}`),
    P(3, `LogSquadStats: FobCreated: fob=BP_FOBRadius_C_9 team=1 pos=10.0,20.0,30.0 creator=${EOS_A}`),
    P(4, `LogSquadStats: Tickets: team=1 tickets=240`)
  ];
  const { events } = parseLog(lines);
  const pos = events.find((e) => e.type === 'PLAYER_POS') as any;
  assert.equal(pos.eosID, EOS_A);
  assert.equal(pos.pos.y, -200.5);
  assert.equal(pos.team, 2);
  const proj = events.find((e) => e.type === 'PROJECTILE') as any;
  assert.equal(proj.hit, true);
  assert.equal(proj.victimEOSID, EOS_B);
  assert.ok(events.some((e) => e.type === 'FOB_CREATED'));
  assert.ok(events.some((e) => e.type === 'TICKETS'));
});

test('parses telemetry wrapped by the Blueprint logger (content-only mod route)', () => {
  // A content-only mod can only reach the log via Unreal's Blueprint logger, so
  // its telemetry arrives as "LogBlueprint: Warning: LogSquadStats: ...".
  // normalizeStatsLine splices the canonical prefix back so it parses identically.
  const lines = [
    P(1, `LogBlueprint: Warning: LogSquadStats: PlayerPos: eos=${EOS_A} ctrl=BP_PlayerController_C_5 pos=12.0,34.0,56.0 yaw=90.0 hp=100.0 team=1 squad=2 role=USA_SL_01 state=alive`),
    P(2, `LogBlueprint: Warning: LogSquadStats: PlayerRole: eos=${EOS_B} role=RU_Medic_01 lead=0 team=2 squad=1`)
  ];
  const { events } = parseLog(lines);
  const pos = events.find((e) => e.type === 'PLAYER_POS') as any;
  assert.ok(pos, 'wrapped PlayerPos should parse');
  assert.equal(pos.eosID, EOS_A);
  assert.equal(pos.team, 1);
  assert.equal(pos.squad, 2);
  const role = events.find((e) => e.type === 'PLAYER_ROLE') as any;
  assert.equal(role.eosID, EOS_B);
  assert.equal(role.team, 2);
});

test('ignores engine boot/EOS noise', () => {
  const lines = [
    'LogPakFile: Display: Mounting pak file ...',
    'LogRedpointEOS: something',
    P(1, 'LogSquadGameEvents: Display: Team 2, RUS ( Russia ) has won the match with 50 Tickets on layer Narva RAAS v1 (level Narva)!')
  ];
  const { events } = parseLog(lines);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ROUND_ENDED');
});
