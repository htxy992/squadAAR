# CQB Telemetry Capture Specification (Server Plugin)

Status: **specification** — for the server-side plugin developer.

This document defines the **exact log line formats** the SquadAAR CQB pipeline
expects from an extended Squad server plugin. The existing `LogSquadStats`
output (PlayerPos, PlayerDied, Projectile, …) gives the skeleton; these
additional events add the flesh for 1v1 / close-quarters coaching analysis.

---

## 0. Guiding principles

- **Same coordinate frame** as existing `PlayerPos`: Unreal world centimetres,
  `+Y` = north, `+Z` = up. No calibration needed.
- **Prefix every new line** with `LogSquadStats:` so the existing parser picks
  it up without changes to the log-reader infrastructure.
- **30 Hz PlayerPos** (down from the current ~1 Hz): Squad server ticks at
  ~50 Hz; 30 Hz is feasible and gives adequate sub-frame resolution for CQB
  timing (TTK, peeking windows). The existing `PlayerPos` format is reused
  unchanged — just emitted 30× per second instead of 1×.
- All new events are **optional** from the parser's perspective — the pipeline
  degrades gracefully when they are absent. Existing rounds processed without
  the plugin still work (engagement detection falls back to Projectile events;
  hit-zone / spray features are simply absent).

---

## 1. Events

### 1.1 PlayerPos (existing, higher rate)

**No format change.** Just emit at 30 Hz per alive player. This is the exact
format the parser already reads (`src/parser/patterns.ts` → `PLAYER_POS`):

```
LogSquadStats: PlayerPos: eos=<eosID> ctrl=<controller> pos=<x>,<y>,<z> yaw=<deg> hp=<0..100> team=<1|2> squad=<n> role=<role> state=<alive|wound|dead>
```

| field | type | notes |
| --- | --- | --- |
| `eos` | EOS ID | player |
| `ctrl` | string | controller id (e.g. `BP_PlayerController_C_2147400001`) |
| `pos` | `x,y,z` | world position (cm); `+Y` = north, `+Z` = up |
| `yaw` | float (deg) | 0–360, 0 = north, CW |
| `hp` | float | 0..100 |
| `team` | `1\|2` | team |
| `squad` | int | squad number (0 = unassigned) |
| `role` | string | role/kit classname (e.g. `USA_Rifleman_01`) |
| `state` | enum | `alive` \| `wound` \| `dead` |

Example:
```
[2026.06.23-18.42.11:003][  3]LogSquadStats: PlayerPos: eos=000100001234abcd ctrl=BP_PlayerController_C_2147400001 pos=123456.0,234567.0,1234.0 yaw=182.4 hp=100.0 team=1 squad=1 role=USA_Rifleman_01 state=alive
```

**Rate:** 30 Hz per alive player. Dead / incapacitated players: 1 Hz or omit.

---

### 1.2 HitDetail (new)

Emitted on **every registered hit**, including non-lethal damage. Gives the
precise hitzone and exact shot vector for spray-pattern reconstruction.

```
LogSquadStats: HitDetail: attacker=<eosID> victim=<eosID> weapon=<AssetPath> damage=<float> zone=<zone> from=<x>,<y>,<z> to=<x>,<y>,<z>
```

| field | type | notes |
| --- | --- | --- |
| `attacker` | EOS ID | shooter |
| `victim` | EOS ID | hit player |
| `weapon` | string | Unreal asset path or short name (e.g. `Weapon_RifleM4_C`) |
| `damage` | float | damage dealt (0..100+) |
| `zone` | enum | `head` \| `torso` \| `arms` \| `legs` |
| `from` | `x,y,z` | shooter world position (cm) — same frame as PlayerPos |
| `to` | `x,y,z` | impact world position (cm) |

Example:
```
[2026.06.23-18.42.11:034][  3]LogSquadStats: HitDetail: attacker=000100001234abcd victim=000100009876dcba weapon=Weapon_RifleM4_C damage=35.0 zone=torso from=123456,234567,1234 to=123890,234600,1240
```

**Rate:** every hit event (typically up to ~10/s per active shooter).

---

### 1.3 PlayerLook (new)

Per-frame crosshair direction as **pitch/yaw**. Drives two things:
1. **Aim-vs-target** ("where you aimed") — at each shot the crosshair is compared
   to the bearing/elevation of the enemy, giving a per-shot **aim error** (and a
   systematic bias like *high-right*) plus the `aim_off_target` coaching flag and
   the engagement-detail sight-picture plot. This is the only telemetry that
   captures *where the player aimed* as opposed to where the bullet went, so for a
   **hit** without `PlayerLook` the aim error is left unscored (a derived ~0 would
   be an artifact); a **miss** falls back to the projectile direction.
2. **Spray reconstruction** independent of `PROJECTILE` events — the delta between
   consecutive `PlayerLook` samples traces the recoil pattern even for missed
   shots where no `Projectile` to-position is available.

```
LogSquadStats: PlayerLook: eos=<eosID> pitch=<deg> yaw=<deg>
```

| field | type | notes |
| --- | --- | --- |
| `eos` | EOS ID | player |
| `pitch` | float (deg) | −90 (down) … +90 (up) |
| `yaw` | float (deg) | 0–360, 0 = north, CW |

Example:
```
[2026.06.23-18.42.11:003][  3]LogSquadStats: PlayerLook: eos=000100001234abcd pitch=-2.3 yaw=182.4
```

**Rate:** 30 Hz per alive player (same cadence as PlayerPos; can be merged into
one tick or emitted separately — the parser handles both).

**Optional:** SquadAAR reconstructs spray from `PROJECTILE` from-to vectors and
`HitDetail` when `PlayerLook` is absent. Provide it for the highest-resolution
recoil telemetry.

---

### 1.4 PlayerState (new)

Stance and sprint state. Required for the `peek_killed` (moving on death) and
`pre_aim_advantage` (defender stationary) coaching flags.

```
LogSquadStats: PlayerState: eos=<eosID> stance=<stance> sprint=<0|1>
```

| field | type | notes |
| --- | --- | --- |
| `eos` | EOS ID | player |
| `stance` | enum | `stand` \| `crouch` \| `prone` \| `jump` |
| `sprint` | `0\|1` | 1 = player is sprinting |

Example:
```
[2026.06.23-18.42.11:003][  3]LogSquadStats: PlayerState: eos=000100001234abcd stance=crouch sprint=0
```

**Rate:** emit on **change** only (stance/sprint transitions), not per-tick.
This keeps log volume low; the parser holds the last known state between events.

---

## 2. Volume estimates (30 Hz at scrim scale)

| event | rate | bytes/event | bytes/min (50 players) |
| --- | --- | --- | --- |
| PlayerPos 30 Hz | 1500/s | ~90 B | ~8 MB |
| PlayerLook 30 Hz | 1500/s | ~60 B | ~5.4 MB |
| HitDetail | ~5/s burst | ~120 B | ~36 kB |
| PlayerState | ~2/s | ~70 B | ~420 kB |
| **total** | | | **~14 MB/min** |

A full 40-minute scrim: **~560 MB log**. Comfortably within a 50 GB RAM budget
for real-time buffering; a few hundred MB on disk after ingest.

---

## 3. Parser regex patterns (for reference)

The existing parser (`src/parser/patterns.ts`) already handles these regexes:

```
HIT_DETAIL:  /LogSquadStats: HitDetail: attacker=(\S+) victim=(\S+) weapon=(\S+) damage=([\d.]+) zone=(\w+) from=([-\d.,]+) to=([-\d.,]+)/
PLAYER_LOOK: /LogSquadStats: PlayerLook: eos=(\S+) pitch=([-\d.]+) yaw=([-\d.]+)/
PLAYER_STATE:/LogSquadStats: PlayerState: eos=(\S+) stance=(\w+) sprint=([01])/
```

The coordinate fields `pos`, `from`, `to` all use the format `x,y,z` (no spaces,
no parentheses) matching the existing `PlayerPos` format.

---

## 4. Integration summary

The plugin only needs to emit these lines into the Squad server log. SquadAAR's
ingest pipeline (`src/ingest/ingest.ts`) picks them up automatically; no changes
are needed to the AAR server or web frontend.

For maximum coaching value, all four event types should be implemented.
For minimal implementation: **PlayerPos at 30 Hz + HitDetail** covers 80% of the
engagement analysis features (spray, TTK, kill geometry). `PlayerLook` and
`PlayerState` add precision but are optional.
