"""
Squad SDK -> SquadAAR building-geometry exporter.

Runs INSIDE the Squad SDK (Unreal Editor) Python console. It walks the loaded
map level(s), keeps only structural building meshes (walls/floors/roofs), drops
terrain/foliage/props, writes a provenance manifest, and selects the kept actors
so you can File -> Export Selected -> OBJ in one click.

The exported geometry lives in the SAME coordinate frame as Squad's PlayerPos
telemetry: Unreal world *centimetres*. That is the whole point - a wall triangle
at world (x,y,z) cm is physically where a player at (x,y,z) cm stands, so it
overlays the minimap with the exact same projection SquadAAR already uses for
players (src/maps/mapRegistry.ts -> worldToNorm). See docs/CQB_SDK_GEOMETRY.md.

Usage (from the editor's Output Log / Python console):
    py "C:/path/to/squadAAR/tools/sdk/export_squad_geometry.py"

Then: File -> Export Selected... -> save as OBJ into OUT_DIR (or set
EXPORT_ASSETS=True below to dump per-mesh files programmatically instead).

NOTE: Unreal's Python API names drift slightly between SDK builds. The script
uses defensive fallbacks and prints a clear summary; if one API call is missing
in your build, the printed error names the spot to adjust.
"""

import unreal
import json
import os
import datetime

# =============================== CONFIG ====================================
# SquadAAR mapKey / assetKey (see src/maps/mapRegistry.ts). Output filenames
# and the meta.json mapKey use this.
MAP_KEY = "kohat"
SOURCE_LAYER = "Kohat_RAAS_v1"          # informational provenance only

# Where to write the manifest (+ optional per-asset meshes). Use forward slashes.
OUT_DIR = "C:/squadAAR/tools/sdk/exports/kohat"

# Optional world-space AABB (cm) to restrict the export to a single objective /
# town - keeps files small and focused on where scrims are actually fought.
# None = whole map. Example: a 1x1 km box around an objective:
#   REGION = {"minX": -50000, "minY": -50000, "maxX": 50000, "maxY": 50000}
REGION = None

# Drop anything whose world bounding-box is smaller than this in BOTH horizontal
# axes (cm). ~150 cm removes most clutter (sandbags, crates, signs) while keeping
# wall segments and building shells.
MIN_EXTENT_CM = 150.0

# Name substrings (case-insensitive) that mark a mesh/actor as non-structural.
EXCLUDE_NAME = (
    "foliage", "tree", "bush", "grass", "plant", "leaf", "ivy",
    "rock_small", "stone_small", "debris", "rubble_small", "decal",
    "wire", "cable", "sign", "poster", "barrel", "crate_small",
    "puddle", "water", "splash", "vfx", "fx_", "light_", "lamp",
)

# Actor classes to skip outright (terrain comes from the DEM heightmap, not here;
# lights/captures/atmosphere are not collidable structure).
EXCLUDE_CLASS = (
    "InstancedFoliageActor", "Landscape", "LandscapeStreamingProxy",
    "LandscapeProxy", "Light", "DirectionalLight", "PointLight", "SpotLight",
    "SkyLight", "ReflectionCapture", "DecalActor", "SkyAtmosphere",
    "ExponentialHeightFog", "AtmosphericFog", "PostProcessVolume",
    "AudioVolume", "PlayerStart", "CameraActor",
)

# Try to load every World Composition tile before walking (large maps stream
# their sublevels; un-loaded tiles contribute no actors). If this misbehaves in
# your SDK build, set False and load the tiles manually in the Levels panel.
LOAD_ALL_SUBLEVELS = True

# If True, also export each UNIQUE static mesh asset to OUT_DIR/assets/*.obj via
# AssetExportTask (Route B: manifest + local meshes). Default False -> use the
# simpler Route A (manual File -> Export Selected -> one world-space OBJ).
EXPORT_ASSETS = False
# ===========================================================================


def log(msg):
    unreal.log("[SquadAAR-export] " + str(msg))


def warn(msg):
    unreal.log_warning("[SquadAAR-export] " + str(msg))


def _actor_subsystem():
    # 4.27 path, with the older library as fallback.
    try:
        return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)
    except Exception:
        return None


def get_all_actors():
    sub = _actor_subsystem()
    if sub:
        try:
            return list(sub.get_all_level_actors())
        except Exception as e:
            warn("EditorActorSubsystem.get_all_level_actors failed: %s" % e)
    try:
        return list(unreal.EditorLevelLibrary.get_all_level_actors())
    except Exception as e:
        warn("EditorLevelLibrary.get_all_level_actors failed: %s" % e)
        return []


def set_selection(actors):
    sub = _actor_subsystem()
    if sub:
        try:
            sub.set_selected_level_actors(actors)
            return True
        except Exception:
            pass
    try:
        unreal.EditorLevelLibrary.set_selected_level_actors(actors)
        return True
    except Exception as e:
        warn("could not set selection automatically: %s" % e)
        return False


def load_sublevels():
    """Best-effort: make all World Composition tiles resident so their actors
    are walkable. APIs vary; failures are non-fatal (load tiles manually)."""
    if not LOAD_ALL_SUBLEVELS:
        return
    try:
        world = unreal.EditorLevelLibrary.get_editor_world()
        streaming = unreal.GameplayStatics.get_streaming_levels(world)
        loaded = 0
        for sl in streaming:
            try:
                unreal.EditorLevelUtils.set_level_visibility(sl, True, False)
                loaded += 1
            except Exception:
                pass
        log("requested visibility for %d streaming level(s)" % loaded)
    except Exception as e:
        warn("auto-load of sublevels unavailable (%s). Load the tiles covering "
             "the play area manually in the Levels panel, then re-run." % e)


def class_name(actor):
    try:
        return actor.get_class().get_name()
    except Exception:
        return ""


def excluded_by_class(actor):
    cn = class_name(actor).lower()
    return any(x.lower() in cn for x in EXCLUDE_CLASS)


def excluded_by_name(name):
    n = (name or "").lower()
    return any(x in n for x in EXCLUDE_NAME)


def actor_extent_cm(actor):
    try:
        origin, extent = actor.get_actor_bounds(False)
        return origin, extent
    except Exception:
        try:
            # older signature returns a struct/tuple differently
            b = actor.get_actor_bounds(False)
            return b[0], b[1]
        except Exception:
            return None, None


def in_region(origin):
    if REGION is None or origin is None:
        return True
    return (REGION["minX"] <= origin.x <= REGION["maxX"] and
            REGION["minY"] <= origin.y <= REGION["maxY"])


def static_mesh_of(comp):
    try:
        return comp.get_editor_property("static_mesh")
    except Exception:
        try:
            return comp.static_mesh
        except Exception:
            return None


def component_records(actor):
    """Yield (mesh_path, world_transform_dict) for each structural mesh
    instance on the actor (handles InstancedStaticMeshComponent)."""
    try:
        comps = actor.get_components_by_class(unreal.StaticMeshComponent)
    except Exception:
        comps = []
    for comp in comps:
        mesh = static_mesh_of(comp)
        if mesh is None:
            continue
        mesh_path = mesh.get_path_name()
        mesh_name = mesh.get_name()
        if excluded_by_name(mesh_name) or excluded_by_name(mesh_path):
            continue
        # Instanced meshes: one record per instance (world-space transforms).
        if isinstance(comp, unreal.InstancedStaticMeshComponent):
            try:
                count = comp.get_instance_count()
            except Exception:
                count = 0
            for i in range(count):
                try:
                    t = comp.get_instance_transform(i, world_space=True)
                    yield mesh_path, _xform(t)
                except Exception:
                    continue
        else:
            try:
                t = comp.get_world_transform()
                yield mesh_path, _xform(t)
            except Exception:
                continue


def _xform(t):
    loc = t.translation
    rot = t.rotation            # Quat
    scl = t.scale3d
    return {
        "loc_cm": [loc.x, loc.y, loc.z],
        "quat": [rot.x, rot.y, rot.z, rot.w],
        "scale": [scl.x, scl.y, scl.z],
    }


def export_unique_assets(mesh_paths):
    """Route B: dump each unique mesh asset to OUT_DIR/assets/<name>.obj."""
    out = os.path.join(OUT_DIR, "assets")
    os.makedirs(out, exist_ok=True)
    done = 0
    for mp in sorted(mesh_paths):
        mesh = unreal.load_asset(mp)
        if mesh is None:
            continue
        fn = os.path.join(out, mesh.get_name() + ".obj")
        task = unreal.AssetExportTask()
        task.set_editor_property("object", mesh)
        task.set_editor_property("filename", fn)
        task.set_editor_property("automated", True)
        task.set_editor_property("prompt", False)
        try:
            unreal.Exporter.run_asset_export_task(task)
            done += 1
        except Exception as e:
            warn("asset export failed for %s (%s)" % (mp, e))
    log("exported %d unique mesh asset(s) to %s" % (done, out))


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    load_sublevels()

    actors = get_all_actors()
    log("scanning %d level actor(s)" % len(actors))

    kept_actors = []
    instances = []
    unique_meshes = set()
    skipped_class = skipped_name = skipped_small = skipped_region = 0

    for a in actors:
        if excluded_by_class(a):
            skipped_class += 1
            continue
        origin, extent = actor_extent_cm(a)
        if not in_region(origin):
            skipped_region += 1
            continue
        if extent is not None and extent.x < MIN_EXTENT_CM and extent.y < MIN_EXTENT_CM:
            skipped_small += 1
            continue
        recs = list(component_records(a))
        if not recs:
            continue
        if excluded_by_name(a.get_actor_label()):
            skipped_name += 1
            continue
        kept_actors.append(a)
        for mesh_path, xf in recs:
            unique_meshes.add(mesh_path)
            instances.append({"mesh": mesh_path, **xf})

    log("kept %d actor(s), %d mesh instance(s), %d unique mesh(es)" %
        (len(kept_actors), len(instances), len(unique_meshes)))
    log("skipped: class=%d name=%d small=%d region=%d" %
        (skipped_class, skipped_name, skipped_small, skipped_region))

    manifest = {
        "format": "squadaar-sdk-manifest/1",
        "mapKey": MAP_KEY,
        "sourceLayer": SOURCE_LAYER,
        "exportedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "units": "cm",
        "frame": "unreal-world (same as PlayerPos telemetry)",
        "region": REGION,
        "filters": {
            "minExtentCm": MIN_EXTENT_CM,
            "excludeName": list(EXCLUDE_NAME),
            "excludeClass": list(EXCLUDE_CLASS),
        },
        "counts": {
            "actors": len(kept_actors),
            "instances": len(instances),
            "uniqueMeshes": len(unique_meshes),
        },
        "instances": instances,
    }
    man_path = os.path.join(OUT_DIR, "instances.json")
    with open(man_path, "w") as f:
        json.dump(manifest, f)
    log("wrote manifest -> %s" % man_path)

    if EXPORT_ASSETS:
        export_unique_assets(unique_meshes)
    else:
        if set_selection(kept_actors):
            log("SELECTED %d actor(s). Now: File -> Export Selected... -> "
                "save '%s.obj' into %s" % (len(kept_actors), MAP_KEY, OUT_DIR))
        else:
            warn("auto-selection failed; select the structural actors manually, "
                 "then File -> Export Selected -> OBJ.")

    log("DONE. Next: run the converter (see docs/CQB_SDK_GEOMETRY.md) to turn the "
        "OBJ + instances.json into web/assets/maps/%s/geometry.bin" % MAP_KEY)


if __name__ == "__main__":
    main()
