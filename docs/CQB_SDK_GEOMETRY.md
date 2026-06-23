# CQB Building Geometry — SDK Export Pipeline (Spec)

Status: **specification** (Phase: pipeline + data format). The export tool ships
now (`tools/sdk/export_squad_geometry.py`); the converter and the consuming
LOS/FOV engine are the next phase and are *defined* here so they can be built
against a frozen contract.

This document specifies how we get **pixel-exact building geometry** out of the
Squad SDK and into SquadAAR so the 1v1 / CQB ("Häuserkampf") analysis can do real
3D line-of-sight, FOV cones, peeker's-advantage timing, and counterfactual
"when would I have seen them" simulation.

---

## 0. Why this exists & where it fits

The existing AAR reconstructs terrain from a **DEM heightmap**
(`src/maps/heightmap.ts`) and scores shots for terrain occlusion
(`src/analysis/ballistics.ts`). That is correct for *open* engagements (hills,
high ground). It is blind to **buildings** — the entire substance of CQB. This
pipeline adds the missing layer: the **structural mesh** of buildings as a 3D
triangle soup, used for true indoor/vertical line-of-sight.

Building geometry is **additive**: terrain stays the DEM; buildings become a
second occluder. Full LOS = *terrain-clear* **AND** *building-clear*.

### The coordinate-frame win (read this first)

Squad's `PlayerPos` telemetry is in **Unreal world centimetres**
(`docs/LOG_FORMAT.md`). SDK actor world-locations are in the **same** unit and
**same** frame. Therefore:

> A wall triangle at world `(x, y, z)` cm is physically where a player at
> `(x, y, z)` cm stands.

No new calibration is needed. The exact projection SquadAAR already uses for
players — `worldToNorm()` in `src/maps/mapRegistry.ts` — projects building
triangles onto the minimap correctly:

```
nx = (x - minX) / (maxX - minX)
ny = 1 - (y - minY) / (maxY - minY)     // +Y = north = image top
```

The only thing that can break this is an axis/scale/origin discrepancy in the
**export**, which §7 verifies empirically and pins down once per map.

---

## 1. Coordinate contract (authoritative)

| Property | Value |
| --- | --- |
| Units | **centimetres** (Unreal default) |
| Frame | Unreal **world**, absolute (World Composition offsets baked in) |
| Axes | `+X`, `+Y`, `+Z`; `+Y` = north (matches `mapRegistry` & DEM), `+Z` = up |
| Terrain | from the **DEM** (`heightmap.png`), **not** from this geometry |
| Buildings | this geometry (triangle soup) |
| Per-map, not per-layer | building shells are identical across RAAS/AAS/Invasion layers — export once per map version |

Every consumer treats geometry coordinates as **directly comparable** to
`SnapshotPlayer.world` and `ProjectileTrack.fromWorld/toWorld`.

---

## 2. What to export / what to skip

**Export (structural occluders):** exterior + interior walls, floors, ceilings,
roofs, stairs, large static cover (concrete barriers, shipping containers,
bridges) — anything that blocks a bullet or a sightline indoors.

**Skip:**
- **Landscape / terrain** → already the DEM.
- **Foliage** (trees/bushes/grass) → not reliable hard cover; huge triangle count.
- **Small props** (sandbags, crates, signs, debris) → noise; filtered by size.
- Lights, decals, captures, volumes, atmosphere → not geometry.

The export script (§5) applies these as class/name/size filters you can tune.

**Multi-floor is mandatory.** We chose a **3D mesh** (not 2.5D floor slices)
precisely so vertical sightlines — stairwells, windows, shooting up/down, roofs —
are exact. Keep ceilings and floors in the export; do not flatten.

---

## 3. Pipeline overview

```
  Squad SDK (Unreal Editor)
    │  1. open map level, load World Composition tiles
    │  2. tools/sdk/export_squad_geometry.py  → filters + SELECTS structural actors
    │                                          → writes instances.json (provenance)
    │  3. File → Export Selected → <mapKey>.obj   (world-space, Unreal cm)
    ▼
  Offline converter  (Node/TS, zero-dep — NEXT PHASE, format frozen here)
    │  4. parse OBJ (+ optional instances.json), apply verified coord transform
    │  5. write web/assets/maps/<assetKey>/geometry.bin  + geometry.meta.json
    ▼
  SquadAAR ingest/engine  (NEXT PHASE)
    │  6. load geometry.bin → build BVH → GeometryProvider
    │  7. LOS / FOV / counterfactual sim   (plugs into ballistics + buildDeaths)
```

Steps 1–3 are runnable **today** with the shipped script. Steps 4–7 are the
"engine" phase; their contracts (data format §6, provider interface §8) are
fixed here so they can be built and unit-tested independently.

---

## 4. Runbook (SDK side — you run this)

**Prereqs**
- Squad SDK installed (Epic Games Launcher → Squad SDK).
- Editor **Python plugin** enabled (Edit → Plugins → "Python Editor Script Plugin").
- The target **map level** opens in the SDK (the official map source ships with
  the modding SDK for building custom layers).

**Steps**
1. Open the map's **persistent level** (e.g. `Kohat`).
2. **World Composition:** in the *Levels* panel, load all tiles covering the
   play area (the script also attempts this; manual is the reliable fallback).
3. Edit `tools/sdk/export_squad_geometry.py` config at the top:
   `MAP_KEY`, `OUT_DIR`, optional `REGION` (a world-cm AABB to target one
   town/objective), filter thresholds.
4. Run it from the editor: *Output Log* → Cmd dropdown → **Python** →
   `py "…/tools/sdk/export_squad_geometry.py"`.
   It prints kept/skipped counts, writes `instances.json`, and **selects** the
   structural actors.
5. **File → Export Selected…** → save `<mapKey>.obj` into `OUT_DIR`.
   *(Alternative Route B: set `EXPORT_ASSETS=True` to dump per-mesh OBJs +
   transforms instead; use if "Export Selected → OBJ" is unavailable or the
   single OBJ is unwieldy.)*

Output of this phase: `OUT_DIR/<mapKey>.obj` (+ `instances.json`).

---

## 5. The export script

`tools/sdk/export_squad_geometry.py` — see inline docs. Tunables:

| knob | meaning |
| --- | --- |
| `MAP_KEY` / `SOURCE_LAYER` | output naming + provenance |
| `OUT_DIR` | where the OBJ + manifest land |
| `REGION` | optional world-cm AABB; restrict to one objective (smaller, focused) |
| `MIN_EXTENT_CM` | drop props smaller than this in both horizontal axes (default 150) |
| `EXCLUDE_NAME` / `EXCLUDE_CLASS` | substring/class filters for non-structural stuff |
| `LOAD_ALL_SUBLEVELS` | best-effort World Composition tile load |
| `EXPORT_ASSETS` | Route B (per-mesh export) instead of Export-Selected |

> Unreal's Python API names drift between SDK builds. The script uses defensive
> fallbacks and names the failing call in its log if a tweak is needed.

---

## 6. Output data format (frozen contract)

Two files, written into `web/assets/maps/<assetKey>/` (git-ignored, same place
as `basemap.*` and `heightmap.png`):

### `geometry.bin` — `SQBG/1` (Squad Building Geometry)

Little-endian binary triangle soup in **world cm**:

| offset | type | field |
| --- | --- | --- |
| 0 | char[4] | magic `"SQBG"` |
| 4 | uint32 | version = `1` |
| 8 | uint32 | `triangleCount` (N) |
| 12 | float32[6] | bounds `minX,minY,minZ,maxX,maxY,maxZ` (cm) |
| 36 | float32[9 × N] | triangles: `ax,ay,az, bx,by,bz, cx,cy,cz` (world cm) |

That's it for v1 — every triangle is an opaque solid occluder. (v2 reserves an
optional trailing `uint16[N]` `surfaceFlags` for wallbang/penetration classes;
see §10.)

Memory: even 2 M triangles = 2M × 9 × 4 B ≈ **72 MB** + BVH ≈ trivial against the
50 GB/round budget. No downsampling.

### `geometry.meta.json` — provenance + the verified coordinate fix

```json
{
  "format": "SQBG/1",
  "mapKey": "kohat",
  "assetKey": "kohat",
  "sourceLayer": "Kohat_RAAS_v1",
  "sdkVersion": "<editor build>",
  "exportedAt": "2026-06-23T12:00:00Z",
  "units": "cm",
  "frame": "unreal-world (same as PlayerPos telemetry)",
  "coordinateTransform": "identity",
  "triangleCount": 1234567,
  "bounds": { "minX": 0, "minY": 0, "minZ": 0, "maxX": 0, "maxY": 0, "maxZ": 0 },
  "filters": { "minExtentCm": 150, "region": null },
  "verified": { "method": "minimap-overlay + LOS spot-check",
                "killsChecked": 0, "status": "PENDING" }
}
```

`coordinateTransform` is the **one** value §7 pins down — the fixed remap from
exported OBJ coords to the telemetry frame (e.g. `identity`, `y_negate`,
`xy_swap`, `scale_0.01`). The converter applies it; consumers never deal with it.

---

## 7. Verification & coordinate calibration (the linchpin)

Export coordinate conventions are the only real risk. We resolve it **once per
map** empirically, then bake it into `coordinateTransform`.

**A. Minimap overlay (XY).** Project every triangle's `(x,y)` with
`worldToNorm()` and draw it over the in-game minimap; overlay a recent round's
player positions. Building footprints must sit exactly on the minimap buildings.

| symptom | cause | fix (`coordinateTransform`) |
| --- | --- | --- |
| footprints 100× too small/large | metres vs cm | `scale_0.01` / `scale_100` |
| mirrored along an axis | handedness flip | `x_negate` or `y_negate` |
| rotated 90° / axes swapped | X↔Y convention | `xy_swap` (+ maybe a negate) |
| shifted by a constant vector | World Composition sublevel offset not baked | re-export with absolute world coords (script already requests this) |

**B. Z sanity.** Roofs must be above floors; floor Z must match `terrainHeightAt`
(DEM) at that footprint within a metre or two. If inverted → `z_negate`.

**C. LOS spot-check.** Take a handful of real kills: street/open kills →
`segmentClear` must be **true**; two positions in adjacent rooms split by a known
wall → **false**. Eyeball ≥ ~10 cases.

**Acceptance:** footprints visually aligned **and** LOS matches truth on the spot
checks → set `meta.verified.status = "PASS"`. Until then it stays `PENDING` and
the engine should treat building-LOS as advisory.

---

## 8. Consumer contract (engine phase — defined now)

Geometry is consumed behind a **source-agnostic** interface, so the SDK export is
a data-quality swap-in, not a rewrite (a traced/heatmap provider can back the
same interface during bring-up):

```ts
interface RayHit { t: number; point: Vec3; triIndex: number; }

interface GeometryProvider {
  readonly source: 'sdk' | 'traced' | 'heatmap';
  readonly bounds: { minX:number; minY:number; minZ:number; maxX:number; maxY:number; maxZ:number };

  /** true if the straight segment from→to is unobstructed by BUILDINGS. */
  segmentClear(from: Vec3, to: Vec3): boolean;

  /** nearest building hit along origin+dir within maxDistCm, else null. */
  raycast(origin: Vec3, dir: Vec3, maxDistCm: number): RayHit | null;
}
```

`SDKMeshGeometry` implements it as a **BVH** over `geometry.bin`, built at ingest.

**Integration points** (engine phase):
- `src/analysis/ballistics.ts` — `analyzeProjectile()` adds building occlusion
  alongside the existing terrain sampling: `hasLineOfSight = terrainClear && geom.segmentClear(...)`.
- `src/timeline/build.ts` — `buildDeaths()` LOS / "why you died" gains indoor LOS.
- New CQB/engagement analysis — FOV cones (`raycast` fan), peeker timing,
  counterfactual visibility from alternative positions.

Suggested wiring mirrors the DEM: a `tryLoadGeometry(map)` next to
`tryLoadHeightmapField()`, and a planned `npm run ingest:geometry` converter
script (`src/tools/ingestGeometry.ts`).

---

## 9. Versioning & maintenance

- **Per map version.** Re-export only when OWI reworks a map's buildings;
  `exportedAt` + `sdkVersion` record the provenance.
- A round whose layer resolves (via `resolveMap`) to a `mapKey` **without**
  `geometry.bin` falls back to terrain-only LOS — the engine warns, doesn't fail.
- `geometry.bin` is **git-ignored** (`web/assets/maps/*/`) like all OWI-derived
  assets; ships out-of-band, never committed.

---

## 10. Performance / memory budget

| map size | ~triangles | geometry.bin | BVH build | raycast |
| --- | --- | --- | --- | --- |
| one town (`REGION`) | 50–300 k | 2–11 MB | ms | µs |
| whole map | 0.5–2 M | 18–72 MB | <1 s | µs |

With 50 GB/round you can hold the full mesh, BVH, and per-engagement
precomputed FOV/visibility sets resident with no downsampling.

---

## 11. Open questions / future (not blocking)

- **Surface materials for wallbang.** v2 `surfaceFlags` per triangle (thin wood
  vs concrete) would let the analyzer model penetration vs hard cover. Needs the
  exporter to read each mesh's material/phys-material — feasible but deferred.
- **Collision vs render mesh.** v1 exports render shells (what you see). Squad's
  server LOS uses collision geometry; for most building shells these match
  closely. If precision demands it, switch the exporter to per-poly collision.
- **Penetrable windows/doors as openings.** Currently implicit in the mesh
  (a window hole is a hole in the triangles). Good enough; revisit if needed.
```
