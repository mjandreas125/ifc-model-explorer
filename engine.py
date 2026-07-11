"""IFC Model Explorer engine.

Opens a large (Tekla) IFC, groups every precast element together with its
internals (rebar, meshes, embeds) using the same validated logic as
extract_ifc_element_library.py, tessellates all geometry with the multicore
IfcOpenShell iterator, and can export any selected element as an exact IFC
subset (GlobalId/psets/materials/placements preserved).

Results are cached on disk keyed by (path, mtime, size), so reopening the
same file is instant.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sys
import threading
import time
import traceback
from collections import Counter, defaultdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Optional

import numpy as np
import ifcopenshell
import ifcopenshell.geom

TOOL_ROOT = Path(__file__).resolve().parent
REPO_ROOT = TOOL_ROOT.parent
for _p in (str(REPO_ROOT), str(TOOL_ROOT)):  # prefer the bundled copy
    if _p not in sys.path:
        sys.path.insert(0, _p)

import extract_ifc_element_library as lib  # noqa: E402  (proven exact-subset exporter)

CACHE_DIR = TOOL_ROOT / "cache"
CPU = max(1, os.cpu_count() or 1)

CONCRETE_CLASSES = {
    "IfcSlab", "IfcWall", "IfcWallStandardCase", "IfcBeam", "IfcColumn",
    "IfcFooting", "IfcPile", "IfcStair", "IfcStairFlight",
}
EMBED_CLASSES = {"IfcDiscreteAccessory", "IfcMechanicalFastener", "IfcFastener", "IfcPlate", "IfcMember"}
NON_PRECAST_KEYWORDS = ("GROUT", "MORTAR", "VUUGIBETOON", "AVA MOODUSTAJA", "AVAMOODUSTAJA", "OPENING FORMER")

# Fallback colours when the IFC carries no surface style (r, g, b, a) 0-255.
CLASS_COLORS: dict[str, tuple[int, int, int, int]] = {
    "IfcReinforcingBar": (179, 71, 71, 255),
    "IfcReinforcingMesh": (46, 139, 87, 255),
    "IfcTendon": (179, 71, 71, 255),
    "IfcDiscreteAccessory": (224, 138, 60, 255),
    "IfcMechanicalFastener": (224, 138, 60, 255),
    "IfcFastener": (224, 138, 60, 255),
    "IfcPlate": (109, 129, 154, 255),
    "IfcMember": (109, 129, 154, 255),
}
DEFAULT_COLOR = (176, 181, 188, 255)  # concrete grey


CACHE_VERSION = 2  # bump when mesh.bin/meta format changes


def file_key(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha1(
        f"{path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|v{CACHE_VERSION}".encode()
    ).hexdigest()[:16]


def style_rgba(style: Any) -> Optional[tuple[int, int, int, int]]:
    diffuse = getattr(style, "diffuse", None)
    if diffuse is None:
        return None
    try:
        if isinstance(diffuse, (tuple, list)):
            r, g, b = diffuse[:3]
        else:
            try:
                r, g, b = diffuse.r(), diffuse.g(), diffuse.b()
            except TypeError:
                r, g, b = diffuse.r, diffuse.g, diffuse.b
        alpha = 1.0
        transparency = getattr(style, "transparency", None)
        if isinstance(transparency, float) and 0.0 <= transparency <= 1.0:
            alpha = 1.0 - transparency
        if any(v is None or (isinstance(v, float) and v != v) for v in (r, g, b)):
            return None
        return (
            max(0, min(255, int(round(float(r) * 255)))),
            max(0, min(255, int(round(float(g) * 255)))),
            max(0, min(255, int(round(float(b) * 255)))),
            max(40, min(255, int(round(alpha * 255)))),
        )
    except Exception:
        return None


def bulk_flat_psets(model: Any, progress=None) -> dict[int, dict[str, str]]:
    """Fast one-pass replacement for per-element get_psets (which is O(n^2) slow)."""
    flats: dict[int, dict[str, str]] = defaultdict(dict)
    rels = model.by_type("IfcRelDefinesByProperties")
    for index, rel in enumerate(rels):
        try:
            pdef = rel.RelatingPropertyDefinition
            if pdef is None or not pdef.is_a("IfcPropertySet"):
                continue
            pset_name = lib.norm(getattr(pdef, "Name", ""))
            pairs = []
            for prop in getattr(pdef, "HasProperties", None) or ():
                if not prop.is_a("IfcPropertySingleValue"):
                    continue
                value = lib.plain(getattr(prop, "NominalValue", None))
                if not value:
                    continue
                key = lib.norm(getattr(prop, "Name", ""))
                pairs.append((key, value))
            if not pairs:
                continue
            for obj in getattr(rel, "RelatedObjects", None) or ():
                flat = flats[obj.id()]
                for key, value in pairs:
                    flat[key] = value
                    if pset_name:
                        flat[f"{pset_name}::{key}"] = value
        except Exception:
            continue
        if progress and index % 20000 == 0:
            progress(index, len(rels))
    return flats


def is_primary(entity: Any, flat: dict[str, str]) -> bool:
    """Generic precast-root test (broadened from lib.is_p2_primary)."""
    cls = entity.is_a()
    if cls not in lib.PRIMARY_CLASSES:
        return False
    text = lib.entity_text(entity, flat)
    if any(k in f" {text} " for k in NON_PRECAST_KEYWORDS):
        return False
    mark = lib.explicit_mark(flat)
    if mark and cls in CONCRETE_CLASSES:
        return True
    if mark and cls in {"IfcWall", "IfcWallStandardCase"}:
        return True
    if lib.concrete_reference_mark(flat):
        return True
    if any(k in text for k in ["RB TREPP", "KEERDTREPP", "VUNDAMENT", "PLAATVUNDAMENT", "BETOONPADI"]):
        return True
    return False


class Model:
    """Holds everything about one opened IFC file."""

    def __init__(self, path: Path):
        self.path = path
        self.key = file_key(path)
        self.ifc: Any = None            # opened lazily for extraction if cache hit
        self.meta: dict[str, Any] = {}
        self.meta_gz: bytes = b""
        self.mesh_path: Optional[Path] = None
        self.lock = threading.Lock()

    # ---------- cache ----------
    @property
    def cache_dir(self) -> Path:
        return CACHE_DIR / self.key

    def cache_hit(self) -> bool:
        return (self.cache_dir / "meta.json.gz").is_file() and (self.cache_dir / "mesh.bin").is_file()

    def load_cache(self) -> None:
        self.meta_gz = (self.cache_dir / "meta.json.gz").read_bytes()
        self.meta = json.loads(gzip.decompress(self.meta_gz))
        self.mesh_path = self.cache_dir / "mesh.bin"

    # ---------- full load ----------
    def build(self, status) -> None:
        status("open", 2, f"Avan {self.path.name} …")
        model = ifcopenshell.open(str(self.path))
        self.ifc = model
        products_total = len(model.by_type("IfcProduct"))
        status("open", 6, f"Skeem {model.schema}, {products_total} toodet")

        status("psets", 8, "Loen omadusi (psets) …")
        flats = bulk_flat_psets(
            model, progress=lambda i, n: status("psets", 8 + 6 * i / max(1, n), f"Omadused {i}/{n}")
        )

        # ---- tessellate everything with all CPU cores ----
        status("geometry", 15, f"Genereerin geomeetriat ({CPU} tuuma) …")
        settings = ifcopenshell.geom.settings()
        settings.set("use-world-coords", True)
        settings.set("mesher-angular-deflection", 1.0)
        settings.set("mesher-linear-deflection", 0.02)
        iterator = ifcopenshell.geom.iterator(
            settings, model, num_threads=CPU, exclude=["IfcOpeningElement", "IfcSpace"]
        )
        elements: dict[int, dict[str, Any]] = {}
        guid_seen: dict[str, tuple] = {}
        duplicates = 0
        started = time.time()
        if iterator.initialize():
            done = 0
            while True:
                shape = iterator.get()
                try:
                    verts = np.asarray(shape.geometry.verts, dtype=np.float32).reshape(-1, 3)
                    faces = np.asarray(shape.geometry.faces, dtype=np.uint32)
                    if len(verts) and len(faces):
                        entity = model.by_id(shape.id)
                        bbox = (*(float(v) for v in verts.min(axis=0)), *(float(v) for v in verts.max(axis=0)))
                        # Tekla exports many rebars twice with the same GlobalId and
                        # identical geometry — draw each unique bar only once.
                        guid = lib.plain(getattr(entity, "GlobalId", ""))
                        previous = guid_seen.get(guid) if guid else None
                        if previous and all(abs(a - b) < 1e-5 for a, b in zip(previous, bbox)):
                            duplicates += 1
                        else:
                            if guid:
                                guid_seen[guid] = bbox
                            color = self._element_color(shape)
                            entity_class = entity.is_a()
                            if color is None:
                                color = CLASS_COLORS.get(entity_class, DEFAULT_COLOR)
                            elements[shape.id] = {
                                "verts": verts,
                                "faces": faces,
                                "bbox": bbox,
                                "color": color,
                                "class": entity_class,
                            }
                except Exception:
                    pass
                done += 1
                if done % 500 == 0:
                    pct = 15 + 55 * iterator.progress() / 100.0
                    status("geometry", pct, f"Geomeetria: {done} toodet, {time.time()-started:.0f}s")
                if not iterator.next():
                    break
        self._duplicates = duplicates
        status("geometry", 70, f"Geomeetria valmis: {len(elements)} toodet (+{duplicates} duplikaati), {time.time()-started:.0f}s")

        status("group", 72, "Grupeerin elemendid (margid + geomeetria) …")
        packages, context_ids = self._build_packages(model, flats, elements, status)

        status("buffers", 88, "Koostan 3D puhvreid …")
        self._write_outputs(model, flats, elements, packages, context_ids, status)
        status("ready", 100, "Valmis")

    # ---------- colours ----------
    @staticmethod
    def _element_color(shape: Any) -> Optional[tuple[int, int, int, int]]:
        try:
            materials = list(shape.geometry.materials)
            if not materials:
                return None
            ids = np.asarray(shape.geometry.material_ids, dtype=np.int64)
            if len(ids):
                valid = ids[ids >= 0]
                dominant = int(np.bincount(valid).argmax()) if len(valid) else 0
            else:
                dominant = 0
            dominant = min(dominant, len(materials) - 1)
            return style_rgba(materials[dominant])
        except Exception:
            return None

    # ---------- grouping ----------
    def _build_packages(self, model, flats, elements, status):
        assigned: set[int] = set()
        packages: list[dict[str, Any]] = []

        def bbox_of(entity_id: int):
            data = elements.get(entity_id)
            return data["bbox"] if data else None

        def add_package(main, members, relations):
            products = [e for e in members if e.is_a("IfcProduct") and not e.is_a("IfcOpeningElement")]
            products = [e for e in products if e.id() not in assigned or e is main]
            if not products:
                return None
            for entity in products:
                assigned.add(entity.id())
            flat = flats.get(main.id(), {})
            mark = (
                lib.plain(getattr(main, "Tag", ""))
                if main.is_a("IfcElementAssembly")
                else ""
            ) or lib.explicit_mark(flat) or lib.concrete_reference_mark(flat) or lib.plain(
                getattr(main, "ObjectType", "")
            ) or lib.plain(getattr(main, "Name", "")) or f"IFC-{main.id()}"
            package = {
                "main": main,
                "members": products,
                "mark": mark,
                "relations": set(relations),
            }
            packages.append(package)
            return package

        # 1) explicit assemblies (Tekla cast units exported as IfcElementAssembly)
        for assembly in model.by_type("IfcElementAssembly"):
            parents = [rel.RelatingObject for rel in getattr(assembly, "Decomposes", ()) if rel.is_a("IfcRelAggregates")]
            if any(p.is_a("IfcElementAssembly") for p in parents):
                continue
            members, relations = lib.descendants(assembly)
            add_package(assembly, members, relations or {"IfcRelAggregates"})

        # 2) mark-based clustering for everything not inside an assembly
        remaining = [e for e in model.by_type("IfcElement") if e.id() not in assigned]
        primaries = [e for e in remaining if is_primary(e, flats.get(e.id(), {}))]
        by_mark: defaultdict[str, list[Any]] = defaultdict(list)
        for entity in primaries:
            flat = flats.get(entity.id(), {})
            mark = lib.explicit_mark(flat) or lib.concrete_reference_mark(flat)
            if not mark:
                tag = lib.plain(getattr(entity, "Tag", ""))
                mark = (
                    lib.plain(getattr(entity, "ObjectType", ""))
                    or lib.plain(getattr(entity, "Name", ""))
                    or (tag if not lib.norm(tag).startswith("ID") else "")
                    or f"IFC-{entity.id()}"
                )
            by_mark[lib.norm(mark)].append(entity)

        primary_ids = {e.id() for e in primaries}
        related_by_mark: defaultdict[str, list[Any]] = defaultdict(list)
        for entity in remaining:
            if entity.id() in primary_ids:
                continue
            mark = lib.explicit_mark(flats.get(entity.id(), {}))
            if mark:
                related_by_mark[lib.norm(mark)].append(entity)

        storey_cache: dict[int, str] = {}

        def storey(entity) -> str:
            if entity.id() not in storey_cache:
                storey_cache[entity.id()] = lib.product_storey(entity)
            return storey_cache[entity.id()]

        for key, roots in sorted(by_mark.items()):
            clusters: list[list[Any]] = []
            for root in roots:
                root_box = bbox_of(root.id())
                attached = None
                for cluster in clusters:
                    cluster_box = lib.bbox_union(bbox_of(e.id()) for e in cluster)
                    if storey(cluster[0]) == storey(root) and lib.bbox_intersects(cluster_box, root_box, margin=0.05):
                        attached = cluster
                        break
                if attached is not None:
                    attached.append(root)
                else:
                    clusters.append([root])
            for cluster in clusters:
                members = set(cluster)
                relations = {"sama Tekla mark", "sama korrus"}
                union = lib.bbox_union(bbox_of(e.id()) for e in cluster)
                for related in related_by_mark.get(key, ()):
                    if related.id() in assigned:
                        continue
                    if storey(related) == storey(cluster[0]) and lib.bbox_intersects(union, bbox_of(related.id()), margin=0.10):
                        members.add(related)
                        relations.add("mark + korrus + geomeetria")
                for member in list(members):
                    linked, linked_relations = lib.descendants(member)
                    members.update(e for e in linked if e.is_a("IfcProduct"))
                    relations.update(linked_relations)
                add_package(cluster[0], members, relations)

        # 3) geometric attachment: unmarked accessories >=50 % inside one package envelope
        package_boxes = []
        for package in packages:
            union = lib.bbox_union(bbox_of(e.id()) for e in package["members"])
            package_boxes.append(union)
        boxes = np.array([b if b else (0, 0, 0, 0, 0, 0) for b in package_boxes], dtype=np.float64)
        has_box = np.array([b is not None for b in package_boxes])

        leftovers = [e for e in model.by_type("IfcElement") if e.id() not in assigned]
        attach_candidates = [
            e for e in leftovers
            if e.is_a() in lib.ACCESSORY_CLASSES
            and not any(k in lib.entity_text(e, flats.get(e.id(), {})) for k in NON_PRECAST_KEYWORDS)
        ]
        attached_geo = 0
        if len(boxes) and len(attach_candidates):
            inflate = 0.012  # 12 mm — thin bars have zero-volume bboxes otherwise
            for entity in attach_candidates:
                box = bbox_of(entity.id())
                if not box:
                    continue
                lo = np.array(box[:3]) - inflate
                hi = np.array(box[3:]) + inflate
                vol = float(np.prod(hi - lo))
                if vol <= 0:
                    continue
                inter_lo = np.maximum(boxes[:, :3], lo)
                inter_hi = np.minimum(boxes[:, 3:], hi)
                inter = np.clip(inter_hi - inter_lo, 0, None).prod(axis=1)
                inter[~has_box] = 0.0
                best = int(inter.argmax())
                if inter[best] / vol >= 0.5:
                    packages[best]["members"].append(entity)
                    packages[best]["relations"].add("geomeetriline sisaldus")
                    assigned.add(entity.id())
                    attached_geo += 1
        status("group", 84, f"Gruppe: {len(packages)}, geomeetriliselt liidetud: {attached_geo}")

        context_ids = [i for i in elements if i not in assigned]
        return packages, context_ids

    # ---------- output buffers + meta ----------
    def _write_outputs(self, model, flats, elements, packages, context_ids, status):
        self.cache_dir.mkdir(parents=True, exist_ok=True)

        class_table: list[str] = []
        class_index: dict[str, int] = {}

        def class_idx(name: str) -> int:
            if name not in class_index:
                class_index[name] = len(class_table)
                class_table.append(name)
            return class_index[name]

        element_package: dict[int, int] = {}
        for package_id, package in enumerate(packages):
            for entity in package["members"]:
                element_package[entity.id()] = package_id

        order = [eid for eid in elements if eid in element_package] + list(context_ids)
        records = np.zeros(len(order), dtype=np.dtype([
            ("id", "<u4"), ("pkg", "<i4"),
            ("vertOffset", "<u4"), ("vertCount", "<u4"),
            ("idxOffset", "<u4"), ("idxCount", "<u4"),
            ("rgba", "u1", 4), ("classIdx", "<u4"), ("pad", "<u4"),
        ]))
        positions: list[np.ndarray] = []
        indices: list[np.ndarray] = []
        vert_total = 0
        idx_total = 0
        for row, eid in enumerate(order):
            data = elements[eid]
            n_verts = len(data["verts"])
            n_idx = len(data["faces"])
            records[row] = (
                eid, element_package.get(eid, -1),
                vert_total, n_verts, idx_total, n_idx,
                data["color"], class_idx(data["class"]), 0,
            )
            positions.append(data["verts"])
            indices.append(data["faces"])
            vert_total += n_verts
            idx_total += n_idx

        header = np.array([0x4C424946, 1, len(order), 0], dtype="<u4")
        mesh_path = self.cache_dir / "mesh.bin"
        with mesh_path.open("wb") as handle:
            handle.write(header.tobytes())
            handle.write(records.tobytes())
            if positions:
                handle.write(np.concatenate(positions).astype("<f4").tobytes())
            if indices:
                handle.write(np.concatenate(indices).astype("<u4").tobytes())
        self.mesh_path = mesh_path
        status("buffers", 92, f"mesh.bin {mesh_path.stat().st_size/1e6:.0f} MB, {idx_total//3} kolmnurka")

        packages_meta = []
        for package_id, package in enumerate(packages):
            members_meta = []
            counts = Counter()
            for entity in sorted(package["members"], key=lambda e: e.id()):
                cls = entity.is_a()
                members_meta.append([entity.id(), class_idx(cls), lib.plain(getattr(entity, "Name", ""))])
                if cls in CONCRETE_CLASSES or cls == "IfcBuildingElementProxy":
                    counts["concrete"] += 1
                elif cls in {"IfcReinforcingBar", "IfcTendon"}:
                    counts["bars"] += 1
                elif cls == "IfcReinforcingMesh":
                    counts["meshes"] += 1
                elif cls in EMBED_CLASSES:
                    counts["embeds"] += 1
                else:
                    counts["other"] += 1
            main = package["main"]
            flat = flats.get(main.id(), {})
            bbox = lib.bbox_union(elements[e.id()]["bbox"] for e in package["members"] if e.id() in elements)
            packages_meta.append({
                "i": package_id,
                "mark": package["mark"],
                "name": lib.plain(getattr(main, "Name", "")) or lib.plain(getattr(main, "ObjectType", "")) or main.is_a(),
                "class": main.is_a(),
                "category": lib.classify(lib.entity_text(main, flat), package["mark"], main.is_a()),
                "storey": lib.product_storey(main),
                "bbox": [round(float(v), 4) for v in bbox] if bbox else None,
                "counts": dict(counts),
                "members": members_meta,
                "relations": sorted(package["relations"] - {"sama Tekla mark", "sama korrus"})[:4],
            })

        context_meta = []
        for eid in context_ids:
            try:
                entity = model.by_id(eid)
                context_meta.append([eid, class_idx(entity.is_a()), lib.plain(getattr(entity, "Name", ""))])
            except Exception:
                context_meta.append([eid, class_idx(elements[eid]["class"]), ""])

        stat = self.path.stat()
        self.meta = {
            "file": {
                "path": str(self.path),
                "name": self.path.name,
                "sizeMB": round(stat.st_size / 1e6, 1),
                "schema": model.schema,
                "products": len(model.by_type("IfcProduct")),
                "drawn": len(order),
                "triangles": idx_total // 3,
                "contextCount": len(context_ids),
                "duplicatesSkipped": getattr(self, "_duplicates", 0),
                "cores": CPU,
            },
            "classTable": class_table,
            "packages": packages_meta,
            "context": context_meta,
        }
        self.meta_gz = gzip.compress(json.dumps(self.meta, ensure_ascii=False).encode("utf-8"), 6)
        (self.cache_dir / "meta.json.gz").write_bytes(self.meta_gz)

    # ---------- extraction ----------
    @staticmethod
    def _apply_moves(source: Any, patched: Any, moves: dict[str, list[float]], out_path: Path) -> None:
        """Translate elements in the exported file by world-space deltas (metres)."""
        import ifcopenshell.api
        import ifcopenshell.util.placement as placement_util
        import ifcopenshell.util.unit as unit_util

        scale = unit_util.calculate_unit_scale(patched)  # metres per project unit
        # Snapshot world matrices BEFORE editing anything: some placements may be
        # relative to another moved element, and edits must not compound.
        targets = []
        for step_id, delta in moves.items():
            try:
                guid = lib.plain(getattr(source.by_id(int(step_id)), "GlobalId", ""))
                element = patched.by_guid(guid)
            except Exception:
                continue
            if not getattr(element, "ObjectPlacement", None):
                continue
            matrix = placement_util.get_local_placement(element.ObjectPlacement).copy()
            matrix[:3, 3] *= scale  # to metres (SI)
            matrix[0, 3] += float(delta[0])
            matrix[1, 3] += float(delta[1])
            matrix[2, 3] += float(delta[2])
            targets.append((element, matrix))
        for element, matrix in targets:
            ifcopenshell.api.run("geometry.edit_object_placement", patched, product=element, matrix=matrix, is_si=True)
        patched.write(str(out_path))

    def ensure_ifc(self, status=None) -> Any:
        with self.lock:
            if self.ifc is None:
                if status:
                    status("open", 10, f"Avan lähtefaili {self.path.name} …")
                self.ifc = ifcopenshell.open(str(self.path))
            return self.ifc

    def extract(self, element_ids: list[int], name: Optional[str], out_dir: Optional[Path], status,
                moves: Optional[dict[str, list[float]]] = None) -> dict[str, Any]:
        """Export an arbitrary set of source elements (by STEP id) as one exact IFC subset.

        moves: optional {stepId: [dx, dy, dz]} world offsets in METRES (editor tab) —
        applied to each element's ObjectPlacement in the exported file.
        """
        if not element_ids:
            raise ValueError("empty selection")
        model = self.ensure_ifc(status)
        status("collect", 30, f"Kogun {len(element_ids)} osa …")
        members = []
        for element_id in element_ids:
            try:
                members.append(model.by_id(int(element_id)))
            except Exception:
                pass
        if not members:
            raise RuntimeError("no members resolved from source IFC")

        target_dir = out_dir or (self.path.parent / f"{self.path.stem}_elemendid")
        target_dir.mkdir(parents=True, exist_ok=True)
        stem = lib.safe_name(name or f"valik_{len(members)}_osa", limit=120)
        out_path = target_dir / f"{stem}.ifc"
        suffix = 2
        while out_path.exists():
            out_path = target_dir / f"{stem}__{suffix:02d}.ifc"
            suffix += 1

        status("export", 45, f"Ekspordin {out_path.name} …")
        package = SimpleNamespace(members=set(members))
        patched = lib.export_package(model, package, out_path)

        if moves:
            status("moves", 70, f"Rakendan {len(moves)} osa nihked …")
            self._apply_moves(model, patched, moves, out_path)

        status("validate", 85, "Kontrollin tulemust …")
        expected = {lib.plain(getattr(e, "GlobalId", "")) for e in members if lib.plain(getattr(e, "GlobalId", ""))}
        reopened = ifcopenshell.open(str(out_path))
        out_products = [e for e in reopened.by_type("IfcProduct") if e.is_a() not in lib.SPATIAL_CLASSES]
        out_guids = {lib.plain(getattr(e, "GlobalId", "")) for e in out_products}
        source_counts = lib.count_parts(members)
        out_counts = lib.count_parts(out_products)
        ok = expected.issubset(out_guids) and (
            source_counts["reinforcing_bars"] == out_counts["reinforcing_bars"]
            and source_counts["reinforcing_meshes"] == out_counts["reinforcing_meshes"]
        )
        return {
            "path": str(out_path),
            "folder": str(target_dir),
            "sizeMB": round(out_path.stat().st_size / 1e6, 2),
            "products": len(out_products),
            "expected": len(expected),
            "guids_ok": expected.issubset(out_guids),
            "counts": out_counts,
            "ok": bool(ok),
        }


# ---------------------------------------------------------------- jobs

class Job(threading.Thread):
    def __init__(self, name: str, target, *args):
        super().__init__(daemon=True)
        self.job_name = name
        self._target_fn = target
        self._args = args
        self.state = {"stage": "queued", "pct": 0.0, "message": "", "error": None, "done": False, "result": None}
        self._lock = threading.Lock()

    def status(self, stage: str, pct: float, message: str) -> None:
        with self._lock:
            self.state.update({"stage": stage, "pct": round(float(pct), 1), "message": message})

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return dict(self.state)

    def run(self) -> None:
        try:
            result = self._target_fn(*self._args, self.status)
            with self._lock:
                self.state.update({"stage": "ready", "pct": 100.0, "done": True, "result": result})
        except Exception as exc:
            with self._lock:
                self.state.update({
                    "stage": "error", "done": True,
                    "error": f"{type(exc).__name__}: {exc}",
                    "trace": traceback.format_exc(),
                })


def load_model(path: Path, status) -> Model:
    model = Model(path)
    if model.cache_hit():
        status("cache", 50, "Leidsin vahemälu — laen kohe")
        model.load_cache()
        status("ready", 100, "Valmis (vahemälust)")
    else:
        model.build(status)
    return model


# ---------------------------------------------------------------- CLI test

if __name__ == "__main__":
    source = Path(sys.argv[1])
    t0 = time.time()

    def echo(stage, pct, message):
        print(f"[{time.time()-t0:7.1f}s] {pct:5.1f}% {stage:9s} {message}", flush=True)

    result = load_model(source, echo)
    meta = result.meta
    print(f"\nfile: {meta['file']}")
    print(f"packages: {len(meta['packages'])}")
    for row in meta["packages"][:15]:
        print(f"  {row['mark']:<28} {row['class']:<24} {row['category']:<24} {row['counts']}")
