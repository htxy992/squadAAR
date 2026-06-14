# Architecture

SquadAAR mirrors the three-component design from the SK Discord *Squad Stats*
documentation (Log-Parser → Point System → Elo System) and adds a projectile
plausibility analyzer for the Auto-Mod workflow.

```
            ┌───────────┐   events    ┌────────────┐  Round   ┌──────────────┐
 log file ─▶│  Parser    │────────────▶│  Timeline  │─────────▶│ SquadPoints  │
            │ (patterns) │             │  builder   │          │   engine     │
            └───────────┘             └─────┬──────┘          └──────┬───────┘
                                            │ terrain/projectiles    │ RoundReport
                                            ▼                        ▼
                                     ┌────────────┐           ┌──────────────┐
                                     │ Ballistics │           │  SquadElo    │
                                     │ plausibility│          │   engine     │
                                     └────────────┘           └──────┬───────┘
                                                                     │
                              ┌──────────────────────────────────────┘
                              ▼
                        ┌──────────┐     ┌──────────┐     ┌──────────────┐
                        │  Store   │◀────│  Ingest  │     │   HTTP API   │──▶ web app
                        │  (JSON)  │     │ pipeline │     │ + static srv │   (Canvas)
                        └──────────┘     └──────────┘     └──────────────┘
```

## Modules

### `parser/`
- `patterns.ts` — one regex + handler per event. Vanilla lines follow SquadJS
  exactly; extended `LogSquadStats:` lines carry telemetry.
- `store.ts` — `EventStore` correlation state (mirrors SquadJS `eventStore`):
  resolves attacker identity across `ActualDamage` → `Wound`/`Die`, links
  controllers/names/EOS IDs.
- `logParser.ts` — scans lines, emits a flat, time-sorted `TimelineEvent[]`;
  `splitRounds()` segments on `NEW_GAME` / `ROUND_ENDED`.
- `events.ts` — the normalized event union (maps onto the spec's "Squad-Events").

### `timeline/`
`buildRound()` reconstructs a round into a `Round`:
- identity maps (eos↔name↔steam), per-entity **tracks** (players, vehicles,
  flags, FOBs, tickets, roles);
- **snapshots** at a fixed step for replay (latest state per entity);
- **map events** (kills/wounds/revives/captures/destructions) with positions
  resolved from the tracks;
- delegates to `analysis/` to compute the per-round projectile analysis.

### `analysis/ballistics.ts`
Builds a coarse **terrain-height field** from observed entity Z positions, then
scores each projectile for plausibility: sightline occlusion (sampling terrain
along the path), weapon range, and firing angle. Produces per-player suspicion
aggregates for Auto-Mod.

### `points/`
- `squadPoints.ts` — the SquadPoints engine (damage-share kills, flags, FOB &
  vehicle destruction, revives/heals/logistics, objective/headshot multipliers),
  attributing every point to a class/vehicle **pool**.
- `fobValuation.ts` — FOB value v(t) decay + destruction multiplier d(t)
  (eq. 1–3).
- `config.ts` — tunable constants & ticket values.

### `elo/`
- `squadElo.ts` — pool free-for-all Elo with MoVM (eq. 7–10), standardized
  global Elo (eq. 11–12), team balance win-probability (eq. 14–15), time decay
  (eq. 13).
- `pools.ts` — class pools + published μ/σ table; `vehicleTypes.ts` — vehicle →
  pool classifier.

### `store/`, `ingest/`, `api/`, `maps/`, `tools/`
JSON persistence; the end-to-end ingest pipeline; a zero-dependency HTTP server
(JSON API + static web app); world↔minimap calibration; and the sample-log
generator / CLIs.

### `web/`
Vanilla ES-module + Canvas SPA (no build step): rounds list, AAR replay
(`map.js` renderer + `aar.js` controller), leaderboard, player profile.

## Data flow types
`TimelineEvent[]` → `Round` (`meta`, `players`, `snapshots`, `mapEvents`,
`analysis`) → `RoundReport` (per-player `PointBreakdown` + `poolPoints`) →
`RoundEloReport` + `TeamBalance`, all bundled per round in the store.
