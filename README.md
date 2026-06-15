# SquadAAR — server-side After-Action-Report + SquadElo

A **server-side After-Action-Report (AAR) system for [Squad](https://joinsquad.com)**
with an **integrated SquadElo rating system**. It parses Squad dedicated-server
logs into an event timeline, reconstructs the round, computes **SquadPoints** and
**SquadElo**, scores every shot for **plausibility (line-of-sight / terrain
occlusion)**, and renders an interactive **2D map replay** in the browser — in the
spirit of SquadReplay and the SK Discord *SquadStats / SquadElo* design.

> The logs originally provided were **client-side** and don't contain the
> combat/ticket/position events a server emits, so the repo ships a **synthetic
> server log generator** that produces data in the *exact* dedicated-server format
> (verified against [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS)). Swap
> in real server logs at any time — see [Using real logs](#using-real-server-logs).

```
log file ──▶ parser ──▶ event timeline ──▶ SquadPoints ──▶ SquadElo ──▶ AAR / API / web
                                   └────────▶ projectile plausibility (Auto-Mod)
```

---

## Quick start

```bash
npm install
npm run demo          # generate a sample server log, ingest it, print a summary
npm run serve         # then open http://localhost:8787
```

`npm run demo` runs the full pipeline and prints the round result, top
SquadPoints, top Elo movers, team-balance prediction, and the flagged
(implausible) shots. `npm run serve` starts the API + web app.

Other scripts:

| script | purpose |
| --- | --- |
| `npm run gen:sample` | write `data/logs/SquadGame-sample.log` only |
| `npm run fetch:maps -- [keys...]` | fetch real minimap images into `web/assets/maps/` (OWI assets, not committed) |
| `npm run gen:heightmap` | synthesize the sample round's matching DEM (`npm run demo` does this automatically) |
| `npm run ingest -- <log...>` | ingest one or more real/sample logs (`--reset` to wipe first) |
| `npm run serve` | start API + web UI on `:8787` (`PORT` env to change) |
| `npm test` | run the unit + integration test suite |
| `npm run typecheck` | strict TypeScript check |

---

## What you get

### Interactive AAR map replay (SquadReplay-style UI)
The replay view mirrors SquadReplay: a top bar (REPLAY · MAP/TIME/STATE · live
ticket scoreboard · players · search · MENU/VEHICLES/SCOREBOARD), a central map,
a left **selected-entity** detail panel, a right tabbed sidebar
(**Kill feed** / Scoreboard / Vehicles / Analysis / Menu), and a bottom transport
bar (play · skip · time · scrubber with event ticks · speed buttons · Exit).

- **Real Squad minimaps** (like SquadCalc) — every map is calibrated to its true
  SDK world bounds, so positions overlay correctly. Drop the in-game minimap in
  via `npm run fetch:maps` (assets are OWI's, so they're fetched locally, never
  committed). Without them it falls back to **reconstructed terrain** drawn as
  **hillshade**, with toggleable **contour lines** and an **elevation heatmap** —
  more useful for line-of-sight than a flat image.
- **Mortar / indirect fire** — lobbed shells animate along an arc and burst with
  a **blast-radius** ring at impact; impacts also appear in the event feed.
- **Vehicle movement analysis** — per-vehicle **routes**, a movement **heatmap**,
  and **dwell markers** showing where each vehicle stood (overwatch/camp), with a
  Vehicles panel grouped by **class & type** (distance, avg/max speed, standing
  time, holds, destroyed). Click a vehicle or panel row to trace its route.
- Scrub or play the round back (1–16×), with smooth interpolation between snapshots.
- **OWI-style map icons** — numbered capture points with progress bars, hexagon
  FOBs, HABs, rally points, deployables/emplacements, spotted-enemy diamond
  markers, and squad-number badges at squad centroids.
- **Players** coloured by team, with view-direction, wounded state, names (toggle).
- **Vehicles** with hull HP ring, turret facing, per-component status and Elo pool.
- **Flags** with capture radius + progress; **FOBs**; live **tickets** & clock.
- **Animated bullets** that travel along their trajectory with muzzle flashes,
  tracer streaks and **impact markers** showing exactly *where someone got hit*
  (hit) vs *where the round landed* (miss). Toggle animation, impacts and
  full **sightlines** independently; suspicious shots draw red.
- **1v1 engagement / "why you died"** — click any player (or a kill in the feed)
  to replay the engagement: the killer→victim sightline + distance, the killing
  weapon, headshot flag, **killer vs your elevation + high-ground**, **line-of-sight
  (clear / blocked by terrain)** with a **terrain cross-section profile** (the red
  bullet path drawn over the ground between you and your killer), killing-shot
  plausibility, and the full *damage-taken-this-life* breakdown (every attacker
  who damaged you, ranked).
- Click any player/vehicle to inspect live + round stats; jump from the event feed.

### SquadPoints (chapter 3 of the spec)
Ticket-based points — wounds split across attackers by **damage share**, flag
captures (20 neutral / 60 enemy), FOB destruction (with the **valuation-decay
destruction multiplier**), vehicle + **component** destruction — plus support
points (revives + heals, logistics, SL FOB value), with **objective (1.25×)** and
**headshot (1.25×)** multipliers. Every point is attributed to the player's
**class/vehicle pool** for Elo.

### SquadElo (chapter 4 of the spec)
Per class/vehicle **pool** free-for-all comparisons with a **Margin-of-Victory
multiplier**, a **standardized global Elo** across pools, **team-balance win
probability** (Abbildung 11), and **time decay** for inactive players.

### Projectile detection & plausibility (Auto-Mod)
Every shot is reconstructed (from explicit `Projectile:` telemetry, or from a
hit/kill pair) and scored against a **terrain-height field** built from observed
positions:
- **line-of-sight / occlusion** — does the shot pass through a hill? (wallbang)
- **range** — beyond the weapon's plausible maximum?
- **firing angle** — implausible vertical angle for the weapon class?

Flagged shots surface in the AAR and as a per-player suspicion summary for the
cheater-detection / Auto-Mod workflow.

---

## Using real server logs

The parser reads the **vanilla** dedicated-server lines (kills, wounds, revives,
damage, possess, tickets, round result) that every Squad server already emits.
For the **map replay** you additionally need position/cap/FOB/projectile
telemetry, which vanilla logs do **not** contain — emit the extended
`LogSquadStats:` lines from a server plugin/mod. Both formats are documented in
[`docs/LOG_FORMAT.md`](docs/LOG_FORMAT.md).

```bash
npm run ingest -- --reset /path/to/SquadGame.log
npm run serve
```

You can ingest several logs chronologically (Elo carries across rounds):

```bash
npm run ingest -- log1.log log2.log log3.log
```

Without telemetry you still get full SquadPoints, SquadElo, leaderboards, the
scoreboard and derived kill/plausibility analysis — just no continuous movement
on the map.

---

## Project layout

```
src/
  parser/      log line patterns (SquadJS-faithful) + event model + parser
  timeline/    round reconstruction: entities, snapshots, positioned map events
  analysis/    ballistics: terrain field + projectile plausibility (LOS/range/angle)
  points/      SquadPoints engine + FOB valuation decay + config
  elo/         SquadElo (pools, MoVM, global standardization, balance, decay)
  store/       JSON persistence (rounds + Elo state + index)
  ingest/      end-to-end pipeline
  api/         zero-dependency HTTP server (JSON API + static)
  maps/        world<->minimap calibration
  tools/       sample-log generator, ingest CLI, demo
web/           vanilla-JS + Canvas single-page app (no build step)
tests/         unit + integration tests
docs/          LOG_FORMAT.md, ARCHITECTURE.md
```

## API

| endpoint | description |
| --- | --- |
| `GET /api/rounds` | round index (summaries) |
| `GET /api/rounds/:id` | full bundle: meta, players, snapshots, mapEvents, analysis, point + Elo reports, balance |
| `GET /api/leaderboard?pool=global\|SL\|Medic\|MBT\|…` | ranked players (Elo decay applied) |
| `GET /api/players/:eosID` | profile: global + pool Elo, aggregates, round history |
| `GET /api/pools` | available Elo pools |

## Notes & deviations from the spec

This is a faithful, runnable implementation of the documented design, with a few
pragmatic choices noted here:

- **Elo update normalization.** The literal equations (7)/(10) sum over *all*
  opponents, which makes a single round move an outlier by hundreds of points.
  We divide each player's update by the number of comparisons for stable,
  readable per-round deltas. Set this back to the literal form in
  `src/elo/squadElo.ts` if you prefer.
- **Heals / hitzones / spotting.** Heal points use the documented ~0.95/ revive
  approximation; precise hitzone-from-damage-curve and spotting accuracy points
  (the spec marks spotting as unreleased) are out of scope.
- **Terrain field.** If a real DEM is present (`web/assets/maps/<key>/heightmap.png`,
  a 16-bit grayscale heightmap, decoded server-side), it drives hillshade,
  contours, line-of-sight occlusion and the engagement profile **exactly**. The
  bundled demo synthesizes a matching DEM; for real maps drop in the SDK
  heightmap. Without one, terrain is estimated from observed positions and
  occlusion confidence scales with coverage.
- **Vehicle crews.** Crew→pool attribution is by nearest co-located vehicle; the
  full 5-minute responsibility window model is simplified.

## Credits

Design modelled on the SK Discord **“Squad Stats”** documentation
(Timbow, Fletschoa, KappaKay). Log-line formats verified against
[SquadJS](https://github.com/Team-Silver-Sphere/SquadJS). Squad is © Offworld
Industries. This project ships no game assets.
