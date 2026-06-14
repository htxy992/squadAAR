# Log format reference

SquadAAR consumes two layers of log lines. Every line is prefixed with the
standard Unreal timestamp + frame counter:

```
[YYYY.MM.DD-HH.MM.SS:mmm][frame]<body>
```

## 1. Vanilla dedicated-server lines

These are emitted by **every** Squad dedicated server and are parsed verbatim
(syntax verified against [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS)).
They are sufficient for SquadPoints, SquadElo, leaderboards and the scoreboard.

| event | example body |
| --- | --- |
| New game | `LogWorld: Bringing World /Game/Maps/Harju/Gameplay_Layers/Harju_RAAS_v1.Harju_RAAS_v1` |
| Connect | `LogSquad: PostLogin: NewPlayer: BP_PlayerController_C …PersistentLevel.BP_PlayerController_C_123 (IP: 10.0.0.1 \| Online IDs: EOS: <eos> steam: <steam>)` |
| Join | `LogNet: Join succeeded: <PlayerName>` |
| Possess | `LogSquadTrace: [DedicatedServer]ASQPlayerController::OnPossess(): PC=<Name> (Online IDs: EOS: <eos> steam: <steam>) Pawn=BP_Soldier_USA_Rifleman_C_456` |
| Damage | `LogSquad: Player:<Victim> ActualDamage=56.0 from <Attacker> (Online IDs: EOS: <eos> steam: <steam> \| Player Controller ID: BP_PlayerController_C_111)caused by BP_AK74M_C` |
| Wound | `LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:<Victim> KillingDamage=-56.0 from BP_PlayerController_C_111 (Online IDs: EOS: <eos> steam: <steam> \| Controller ID: BP_PlayerController_C_111) caused by BP_Soldier_RU_Rifleman1_C` |
| Die | `LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:<Victim> KillingDamage=-100.0 from BP_PlayerController_C_111 (Online IDs: EOS: <eos> steam: <steam> \| Contoller ID: BP_PlayerController_C_111) caused by BP_Soldier_RU_Rifleman1_C` |
| Revive | `LogSquad: <Medic> (Online IDs: EOS: <eos> steam: <steam>) has revived <Victim> (Online IDs: EOS: <eos> steam: <steam>).` |
| Deployable damage | `LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_FOBRadius_C_9: 350.0 damage attempt by causer BP_M67Grenade_C_1 instigator <Name> with damage type BP_Explosive_DamageType_C health remaining 0.0` |
| Round result | `LogSquadGameEvents: Display: Team 1, USA ( US Army ) has won the match with 200 Tickets on layer Harju RAAS v1 (level Harju)!` |
| Match end | `LogGameState: Match State Changed from InProgress to WaitingPostMatch` |

> Note the genuine engine quirk reproduced here: the **Die()** line misspells it
> as `Contoller ID:` while **Wound()** uses `Controller ID:`.

The "Player:" name in a Wound/Die line is the **victim**; the inline Online IDs /
controller / `caused by` identify the **attacker**.

## 2. Extended telemetry (`LogSquadStats:`)

These carry the continuous state needed for the **map replay** and **projectile
plausibility**. Vanilla logs do **not** contain them — emit them from a server
plugin / the SquadStats SDK. They map onto the spec's `PlayerDataEvent`,
`VehicleDataEvent`, `CapZoneDataEvent`, `FobCreateEvent`, etc. Positions are in
**centimetres** in the map's world frame.

```
LogSquadStats: Tickets: team=1 tickets=240
LogSquadStats: PlayerPos: eos=<eos> ctrl=<controller> pos=<x>,<y>,<z> yaw=<deg> hp=<0-100> team=<1|2> squad=<n> role=<RoleClass> state=<alive|wound|dead>
LogSquadStats: VehiclePos: veh=<id> type=<ClassName> pos=<x>,<y>,<z> yaw=<deg> tyaw=<turretDeg> hp=<cur>/<max> team=<1|2>
LogSquadStats: VehicleComp: veh=<id> comp=<Engine|Turret|LeftTrack|…> hp=<0-100>
LogSquadStats: VehicleDamage: veh=<id> type=<ClassName> attacker=<eos> dmg=<n> dtype=<HEAT|KE|…> direct=<0|1>
LogSquadStats: CapZone: flag=<Name> pos=<x>,<y>,<z> team=<n> progress=<0..1> status=<Contested|Secured|…>
LogSquadStats: FlagCaptured: flag=<Name> team=<n> pos=<x>,<y>,<z>
LogSquadStats: FobCreated: fob=<id> team=<n> pos=<x>,<y>,<z> creator=<eos>
LogSquadStats: FobDestroyed: fob=<id> team=<n> pos=<x>,<y>,<z>
LogSquadStats: SpawnCreated: kind=<RallyPoint|HAB> team=<n> squad=<n> pos=<x>,<y>,<z>
LogSquadStats: PlayerSpawn: eos=<eos> spawn=<Name> pos=<x>,<y>,<z>
LogSquadStats: PlayerRole: eos=<eos> role=<RoleClass> lead=<0|1>
LogSquadStats: SquadCreated: team=<n> squad=<n> name=<Name> creator=<eos>
LogSquadStats: AmmoDelivery: fob=<id> eos=<eos> amount=<n>
LogSquadStats: MapMarker: eos=<eos> type=<Type> pos=<x>,<y>,<z>
LogSquadStats: Projectile: shooter=<eos> weapon=<ClassName> from=<x>,<y>,<z> to=<x>,<y>,<z> speed=<m/s> hit=<0|1> victim=<eos|->
```

`Projectile:` covers direct *and* indirect fire — a `weapon` whose class maps to
the explosive/mortar/artillery family (e.g. `BP_Mortar_Projectile`) is rendered
as a lobbed arc with a blast-radius burst and is exempt from line-of-sight
occlusion checks (it arcs over terrain). Use `from` = the mortar/launcher
position and `to` = the impact point.

### Real maps (like SquadCalc)

Each map is calibrated to its real SDK minimap world bounds in
`src/maps/mapRegistry.ts`. `npm run fetch:maps` downloads the in-game minimap
into `web/assets/maps/<assetKey>/basemap.(webp|png|jpg)` (OWI assets, git-ignored).
When present the UI renders the real map; otherwise it renders reconstructed
terrain. Point the fetcher at any mirror with `SQUAD_MAP_ASSET_BASE`.

**Exact terrain (DEM).** Drop a 16-bit grayscale heightmap at
`web/assets/maps/<assetKey>/heightmap.png` (`FETCH_HEIGHTMAPS=1 npm run fetch:maps`,
or your SDK export). It is decoded server-side at ingest and used as the terrain
field for hillshade, contours, line-of-sight occlusion and the "why you died"
elevation profile — making them pixel-exact. Set the map's `heightMin`/`heightMax`
(metres) in `mapRegistry.ts` so samples scale to real elevations.

### Map calibration

`src/maps/mapRegistry.ts` maps a layer name (e.g. `Harju_RAAS_v1`) to a map size
and the world bounds covered by the (square) minimap, then projects world cm to
normalized image coordinates. Add or calibrate entries there for pixel-perfect
overlay on a captured minimap image (drop a PNG in `web/assets/maps` and
reference it from the map entry).
