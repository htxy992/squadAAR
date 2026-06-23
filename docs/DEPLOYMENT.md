# Deployment — how SquadAAR gets its logs

SquadAAR turns a Squad **dedicated-server** log into rounds. This doc covers how
the log reaches the pipeline in each deployment, and what telemetry tier you get.

```
SquadGame.log ──▶ ingest (parse → round → SquadPoints → SquadElo → store) ──▶ API / web
```

There is exactly **one** ingest core (`src/ingest/ingest.ts → ingestText`). The
CLI, the live watcher, and the HTTP push endpoint all funnel through it, so every
path produces identical rounds. Ingest is **serialized**, so SquadElo updates stay
in chronological order no matter how rounds arrive.

---

## 1. Same box (recommended — game server + AAR on one machine)

This is the primary design: the game server and SquadAAR run on the same root
server, so SquadAAR can read `SquadGame.log` directly off disk.

**One process serves the AAR and tails the log live.** Point `SQUAD_LOG` at the
server's log and run the server:

```bash
SQUAD_LOG=/path/to/SquadGame/Saved/Logs/SquadGame.log npm run serve
# open http://localhost:8787  — finished rounds appear automatically
```

Optional env:

| var | default | meaning |
| --- | --- | --- |
| `SQUAD_LOG` | — | path to the live log; enables the tailer |
| `SQUAD_LOG_FROM_START` | `0` | `1` = ingest rounds already in the file on startup |
| `SQUAD_LOG_POLL` | `1000` | file poll interval (ms) |
| `PORT` | `8787` | HTTP port |

Prefer to keep ingest and serving as **separate processes**? Run the watcher on
its own — it persists rounds to the same `data/` store the server reads:

```bash
npm run watch -- /path/to/SquadGame.log          # live tail
npm run watch -- --from-start /path/to/Squad.log # replay existing rounds first
npm run serve                                    # in another shell
```

The watcher detects round boundaries (NEW_GAME → round result), ingests each
round the moment it finishes, and survives **log rotation/truncation** (it
restarts from byte 0 when the file shrinks).

---

## 2. One-shot files

Ingest finished logs (e.g. archived rounds, or a batch to seed Elo):

```bash
npm run ingest -- --reset log1.log log2.log log3.log   # chronological; Elo carries across
npm run serve
```

---

## 3. Different boxes (game server ≠ AAR host)

If the AAR ever moves off the game server, push rounds over HTTP instead of
sharing a disk.

**A. Drag-drop** a `SquadGame.log` onto the rounds page in the web UI.

**B. HTTP push** — `POST /api/ingest` with the raw log text:

```bash
curl -X POST --data-binary @SquadGame.log \
     -H 'content-type: text/plain' -H 'x-source: SquadGame.log' \
     http://aar-host:8787/api/ingest
# -> {"ingested": 1, "rounds": [{ "id": "...", "players": 50, ... }]}
```

The endpoint ingests every **complete** round in the payload and ignores a
trailing partial round, so it's safe to send whole files or whole-round chunks.
JSON (`{"text": "...", "source": "..."}`) is also accepted. Cap via
`MAX_INGEST_BYTES` (default 1.5 GB).

**C. Shipper agent** — run [`integrations/shipper/squad-aar-shipper.mjs`](../integrations/shipper/squad-aar-shipper.mjs)
on the game server. Zero dependencies (Node 18+); tails the log and POSTs each
completed round to the remote AAR:

```bash
SQUAD_LOG=/path/to/SquadGame.log AAR_URL=https://aar-host:8787 \
  node squad-aar-shipper.mjs
```

**D. SquadJS emitter plugin** — already running [SquadJS](https://github.com/Team-Silver-Sphere/SquadJS)?
Drop [`integrations/squadjs/squad-aar.js`](../integrations/squadjs/squad-aar.js)
into its `plugins/` dir and add the config block in that file's header. Besides
shipping completed rounds, it reads the live **roster over RCON** and injects
`LogSquadStats: PlayerRole … team=<n> squad=<n>` telemetry into each round — so a
**vanilla server** (which never logs team/squad/role) still gets a correct
scoreboard and per-class Elo pools. See the vanilla note below.

---

## Telemetry tiers — what you get from which log

| tier | source | what works |
| --- | --- | --- |
| **Vanilla (bare log)** | stock dedicated-server log (every server) | kills/wounds/revives, round result → **SquadPoints, kill/plausibility analysis, kill feed**. The bare log has no team/squad/role, so the scoreboard collapses to one team and Elo to the *Generic* pool. |
| **Vanilla + SquadJS emitter** | bare log **+ RCON roster** (`PlayerRole … team=/squad=`) | adds correct **teams, squads, class pools** → a real **scoreboard, SquadElo, per-pool leaderboards, team-balance**. Still no movement (RCON has no positions). This is the best a vanilla/unlicensed server can do. |
| **Positional** | + extended `LogSquadStats:` (positions, cap zones, FOBs, projectiles) from a licensed server plugin/mod | the full **map replay** — player/vehicle movement, flags/FOBs, animated bullets, sightlines, "why you died". |
| **CQB detail** | + 30 Hz PlayerPos, HitDetail, PlayerLook, PlayerState | per-shot **spray/recoil**, 1v1 **engagement coaching**, hit-zones. See [`CQB_CAPTURE_SPEC.md`](CQB_CAPTURE_SPEC.md). |

> **Vanilla / unlicensed server?** Squad never writes player positions to the log
> and RCON has no position command, so map movement and CQB are impossible without
> a licensed server-side plugin. But the **SquadJS emitter (3D)** gets you the full
> *Vanilla + emitter* tier above. Run **either** the SquadJS emitter **or** the
> bare `SQUAD_LOG` tail — not both, or each round ingests twice. The emitter is the
> right choice on a vanilla server because the bare tail can't supply team/squad/role.

The pipeline **degrades gracefully**: the standard map AAR is lightweight and runs
on vanilla + positional telemetry; the CQB engagement detail only activates when
direct-fire projectile telemetry is present (mortars/explosives don't trigger it),
and you drill into a specific 1v1 from the Engagements tab on demand.

Line formats for every event are in [`LOG_FORMAT.md`](LOG_FORMAT.md) (vanilla +
positional) and [`CQB_CAPTURE_SPEC.md`](CQB_CAPTURE_SPEC.md) (CQB). The extended
`LogSquadStats:` lines require a server-side emitter; the geometry side (buildings
for sightlines) is in [`CQB_SDK_GEOMETRY.md`](CQB_SDK_GEOMETRY.md).
