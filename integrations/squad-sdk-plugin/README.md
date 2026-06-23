# SquadAAR Telemetry — server-side SDK plugin

A Squad **server-side** Unreal module that emits the extended `LogSquadStats:`
telemetry SquadAAR needs for the **full map replay** and **CQB engagement** tiers
— player/vehicle positions, cap zones, FOBs, projectiles, roles and tickets —
straight into `SquadGame.log`, in the exact format the parser already consumes
([`docs/LOG_FORMAT.md`](../../docs/LOG_FORMAT.md)).

This is the missing top of the telemetry stack. The other integrations get you
part-way; this is the only thing that produces **positions**:

| you run | telemetry | replay |
| --- | --- | --- |
| stock server only | kills/wounds/revives/result | SquadPoints + kill analysis (team 0, Generic pool) |
| stock server + [SquadJS emitter](../squadjs/squad-aar.js) | + team/squad/role over RCON | real scoreboard, SquadElo, per-class leaderboards |
| **+ this plugin** | + positions, vehicles, cap zones, FOBs, projectiles | **the full map replay, sightlines, "why you died"** |
| **+ this plugin, CQB mode** | + 30 Hz pos, PlayerLook, PlayerState | per-shot 1v1 engagement coaching |

---

## Read this first — can your server actually run it?

This is the honest part, because it decides whether the plugin is usable for you.

Squad **does not write positions to the log and has no RCON position command** —
by design. Getting them out means running code *inside the dedicated-server
process*. There are exactly two ways to do that, and **a stock, unlicensed server
running OWI's binary is not one of them** — that binary won't load custom native
code (anti-tamper + no public server source + no native plugin ABI). So:

- **Native module (this plugin), route A — a server you build.** If you build the
  dedicated server from a Squad SDK **C++ project** (the modding toolchain, the
  modded/custom server browser — *not* the stock licensed binary), this module
  drops in and gives you everything, exactly formatted. This is the intended
  target and the cleanest result.

- **Content-only (Blueprint) mod, route B — a modded server, no C++.** If you can
  only ship a **content mod** (Blueprint, packaged to mod.io / Workshop, loaded
  via the server's `Mods=` config), you can replicate this logic in Blueprint: a
  server-side actor with a repeating timer that iterates pawns and `Print String
  (Print to Log)`s the same payloads. Blueprint can only log through Unreal's
  Blueprint logger, so the lines come out as
  `LogBlueprint: Warning: LogSquadStats: …` — **SquadAAR's parser already unwraps
  that** (`normalizeStatsLine` in `src/parser/logParser.ts`), so they ingest
  identically. Use the `UE_LOG` strings in `SquadAARTelemetrySubsystem.cpp` as the
  exact payloads to reproduce. Caveat: a Blueprint mod makes the server a *modded*
  server (custom browser), and engine-internal getters exposed to Blueprint are
  more limited than C++.

- **Stock vanilla server — no positions, full stop.** No mod = no in-process code
  = no positions. Your best tier there is **stock + the SquadJS emitter**, which
  already gives you a correct scoreboard and SquadElo over RCON. The map replay
  needs one of the two routes above.

> TL;DR: this plugin unlocks the map replay **if you control the server build or
> run a modded server**. It cannot make a stock unlicensed server emit positions —
> nothing can. The SquadJS roster emitter remains the no-mod option.

---

## What it emits

Driven by a `UWorldSubsystem` that auto-instantiates per game world and runs only
on the server (it bails on `NM_Client`). No level edits, no Blueprint placement.

| line | source | timer / hook |
| --- | --- | --- |
| `PlayerPos` | every player's pawn (pos, yaw, hp, team, squad, role, state) | fast timer (default 5 Hz) |
| `PlayerLook`, `PlayerState` | view angles + stance/sprint (CQB only) | fast timer when `SQUADAAR_CQB=1` |
| `PlayerRole` | roster team/squad/role/lead | role timer (5 s) |
| `Projectile` | spawn→impact origin/endpoint + speed | actor-spawn hook + `OnDestroyed` |
| `FobCreated` / `FobDestroyed` | FOB radius actor lifecycle | actor-spawn hook + `OnDestroyed` |
| `Deployable` | emplacements / HASCO / sandbags | actor-spawn hook |
| `VehiclePos` / `VehicleComp` | vehicle pose + health (needs SDK getters) | slow timer (1 s) |
| `CapZone` / `Tickets` | objective + ticket state (needs SDK getters) | slow timer (1 s) |

**Two build modes** (`SQUADAAR_HAVE_SQ_SDK` in `SquadAARTelemetry.Build.cs`):

- **Off (default).** Compiles against **stock Unreal only** — no Squad headers.
  You still get `PlayerPos` (position/heading/identity/controller), `Projectile`
  (→ line-of-sight & terrain analysis), FOB and deployable lifecycle. `team`,
  `squad`, `role`, `health`, `state` fall back to defaults. Great for a first
  build + smoke test, and `PlayerPos` movement already renders.
- **On.** You wire your SDK's gameplay headers and fill the getters in
  `Private/SquadAARSDKBridge.h` (each marked `VERIFY`) — unlocking correct
  team/squad/role/health/state, tickets, cap zones and vehicle health.

---

## Build & install

1. Copy `integrations/squad-sdk-plugin/` into your Squad SDK project's `Plugins/`
   directory (rename the folder to `SquadAARTelemetry`).
2. Regenerate project files and build the **server** target (or build the plugin
   in the SDK editor). With `SQUADAAR_HAVE_SQ_SDK=0` it compiles with no Squad
   dependencies.
3. Cook/package as you would any server plugin/mod and deploy it with your server.
4. Start the server. You'll see one breadcrumb line at world start:
   `LogSquadStats: Init: posHz=5.0 …` (the parser ignores it), then the telemetry
   streams into `SquadGame.log`.
5. Ingest as usual — same-box tail (`SQUAD_LOG=…`), the SquadJS emitter, or
   `POST /api/ingest`. The new lines light up the map replay automatically; no
   SquadAAR config change needed.

---

## Configure

Environment variables (read at world start), with command-line overrides:

| var | default | meaning |
| --- | --- | --- |
| `SQUADAAR_POS_HZ` | `5` | player-position sample rate (Hz) |
| `SQUADAAR_SLOW_SEC` | `1.0` | interval for tickets / cap zones / vehicles |
| `SQUADAAR_ROLE_SEC` | `5.0` | interval for the PlayerRole roster |
| `SQUADAAR_PROJECTILES` | `1` | emit `Projectile` lines (sightlines) |
| `SQUADAAR_CQB` | `0` | `1` = ~30 Hz + PlayerLook/PlayerState for 1v1 coaching |

Command line: `-SquadAARPosHz=30 -SquadAARCQB` (override env at launch).

> **Rate vs. log volume.** 5 Hz is plenty for the map replay and keeps the log
> small. Only turn on `SQUADAAR_CQB` when you actually want per-shot engagement
> detail — it multiplies `PlayerPos`/`PlayerLook`/`PlayerState` volume. SquadAAR
> degrades gracefully: the CQB engagement view only activates when direct-fire
> projectile telemetry is present, so you can drive 30 Hz on demand.

---

## The SDK integration surface

Everything Squad-specific lives in **one file**: `Private/SquadAARSDKBridge.h`.
The class *names* (`ASQPlayerState`, `ASQSoldier`, `ASQVehicle`, …) follow Squad's
conventions — three are confirmed verbatim from real server logs
(`ASQSoldier::Die()`/`::Wound()`, `ASQPlayerController::OnPossess()`,
`ASQDeployable::TakeDamage()`). The member/getter names vary by SDK version, so
each is marked `VERIFY`. To go from the default build to full data:

1. Set `PublicDefinitions.Add("SQUADAAR_HAVE_SQ_SDK=1");` and add your Squad
   gameplay module to `PrivateDependencyModuleNames` in the `.Build.cs`.
2. Fix the `#include` paths at the top of `SquadAARSDKBridge.h` for your SDK.
3. Confirm each `VERIFY` getter (team/squad/role/leader/health/state) against your
   headers. The EOS-id helper needs no changes — it reads the unique-net-id string
   directly.
4. Fill the `VERIFY` blocks in `EmitTickets`/`EmitCapZones`/`EmitVehicles` in
   `SquadAARTelemetrySubsystem.cpp` (ticket, cap-zone and vehicle accessors).

That's the whole checklist — a dozen getters, all in two files.

---

## Format guarantees (why the lines parse)

The emitters honor the parser's grammar so output matches the regexes in
`src/parser/patterns.ts` exactly:

- word fields (`role`, `type`, `flag`, `veh`, `ctrl`, …) are sanitized to
  `[\w.-]` — no spaces ever reach a word field;
- numbers are plain decimal via `%.1f`/`%.3f` (no scientific notation, no
  `inf`/`nan` — non-finite values are clamped to `0`);
- `team` is clamped to a single digit; `squad` is non-negative;
- positions are centimetres in the map's world frame, as the replay expects;
- `LogSquadStats` is logged at **Log** verbosity, so the engine prints
  `LogSquadStats: <msg>` with no verbosity infix.

`Projectile` lines carry geometry only (`hit=0 victim=-`); SquadAAR pairs the
actual hit/victim from the vanilla wound/die lines, so attribution stays correct
while the from→to drives the line-of-sight / terrain-occlusion analysis.
