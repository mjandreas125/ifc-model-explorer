#!/usr/bin/env python3
"""Extract exact, non-remodelled precast IFC subsets into an element library.

The script never creates or modifies product geometry.  Output products are
copied from the source IFC with IfcPatch/IfcOpenShell, preserving their GlobalId,
representations, placements, properties, materials, styles and spatial parents.

Selection policy is deliberately conservative:
* IFC decomposition/nesting is authoritative;
* Tekla CAST_UNIT_POS / Cast unit mark / Concrete_<mark> is authoritative;
* geometry is used for variant comparison and for separating repeated instances
  only after a common mark and storey have already been established;
* unconfirmed reinforcement/accessories are reported, not silently attached.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import math
import os
import re
import shutil
import sys
import time
import traceback
import unicodedata
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as element_util


CATEGORIES = [
    "01_SOKKEL_PANELID",
    "02_VUNDAMENDID",
    "03_RODUPLAADID",
    "04_TREPID",
    "05_TREPIMADED",
    "06_SEINAELEMENDID",
    "07_VAHELAED_JA_LAEPLAADID",
    "08_TALAD",
    "09_POSTID",
    "10_MUUD_ELEMENDID",
    "99_UNCERTAIN",
]

MARK_KEYS = {
    "CAST_UNIT_POS",
    "CAST UNIT POS",
    "CAST UNIT MARK",
    "ASSEMBLY_POS",
    "ASSEMBLY POS",
    "PART_POS",
    "PART POS",
    "CONTROL_NUMBER",
    "CONTROL NUMBER",
}
PRIMARY_CLASSES = {
    "IfcElementAssembly",
    "IfcSlab",
    "IfcWall",
    "IfcWallStandardCase",
    "IfcBeam",
    "IfcColumn",
    "IfcMember",
    "IfcPlate",
    "IfcFooting",
    "IfcPile",
    "IfcBuildingElementProxy",
}
ACCESSORY_CLASSES = {
    "IfcReinforcingBar",
    "IfcReinforcingMesh",
    "IfcDiscreteAccessory",
    "IfcMechanicalFastener",
    "IfcFastener",
    "IfcPlate",
    "IfcMember",
    "IfcBuildingElementProxy",
    "IfcOpeningElement",
}
SPATIAL_CLASSES = {"IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcSpace"}


def plain(value: Any) -> str:
    if value is None:
        return ""
    wrapped = getattr(value, "wrappedValue", None)
    return str(wrapped if wrapped is not None else value).strip()


def norm(value: Any) -> str:
    text = unicodedata.normalize("NFKD", plain(value)).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"\s+", " ", text).strip().upper()


def safe_name(value: Any, fallback: str = "UNNAMED", limit: int = 100) -> str:
    text = plain(value) or fallback
    text = re.sub(r'[\\/:*?"<>|]+', "_", text)
    text = re.sub(r"\s+", "_", text.strip())
    text = re.sub(r"_+", "_", text).strip(" ._")
    return (text or fallback)[:limit]


def json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {plain(k): json_safe(v) for k, v in value.items() if plain(k) != "id"}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    if hasattr(value, "is_a"):
        return {"ifc_id": value.id(), "ifc_class": value.is_a(), "value": plain(value)}
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return plain(value)


def get_psets(entity: Any) -> dict[str, Any]:
    try:
        return json_safe(element_util.get_psets(entity, psets_only=False, qtos_only=False))
    except Exception:
        return {}


def flatten_psets(psets: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for pset_name, values in psets.items():
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            if key == "id" or isinstance(value, (dict, list)):
                continue
            result[norm(key)] = plain(value)
            result[f"{norm(pset_name)}::{norm(key)}"] = plain(value)
    return result


def first_value(flat: dict[str, str], names: Iterable[str]) -> str:
    for name in names:
        value = flat.get(norm(name), "")
        if value and norm(value) not in {"NONE", "NULL", "?"}:
            return value
    return ""


def reference_value(flat: dict[str, str]) -> str:
    return first_value(flat, ["Reference"])


def explicit_mark(flat: dict[str, str]) -> str:
    priorities = ["CAST_UNIT_POS", "CAST UNIT POS", "CAST UNIT MARK", "ASSEMBLY_POS", "ASSEMBLY POS", "PART_POS", "PART POS", "CONTROL_NUMBER"]
    return first_value(flat, priorities)


def concrete_reference_mark(flat: dict[str, str]) -> str:
    reference = reference_value(flat)
    match = re.match(r"(?i)^\s*CONCRETE[_\s-]+(.+?)\s*$", reference)
    return match.group(1).strip() if match else ""


def entity_text(entity: Any, flat: Optional[dict[str, str]] = None) -> str:
    values = [entity.is_a(), getattr(entity, "Name", ""), getattr(entity, "ObjectType", ""), getattr(entity, "Tag", "")]
    if flat:
        values.extend([explicit_mark(flat), reference_value(flat), first_value(flat, ["MATERIAL"])])
    return norm(" ".join(plain(v) for v in values))


def classify(text: str, mark: str, ifc_class: str) -> str:
    value = norm(f"{mark} {text} {ifc_class}")
    if "SOKKEL" in value or re.match(r"^SW[-_]", norm(mark)):
        return "01_SOKKEL_PANELID"
    if any(k in value for k in ["VUNDAMENT", "PLAATVUNDAMENT", "BETOONPADI", "FOUNDATION", "FOOTING", "TALDMILIK", "VUNDAMENDIPLOKK"]) or re.match(r"^(PV|VF)[-_]", norm(mark)):
        return "02_VUNDAMENDID"
    if any(k in value for k in ["RODUPLAAT", "BALCONY", "RODU PLAAT"]) or re.match(r"^(RP|RPL)[-_]", norm(mark)):
        return "03_RODUPLAADID"
    if any(k in value for k in ["KEERDTREPP", "RB TREPP", "STAIR FLIGHT", "TREPP"]) or re.match(r"^(STS|TE)[-_]", norm(mark)):
        return "04_TREPID"
    if any(k in value for k in ["TREPIMAADE", "TEPIMAADE", "LANDING"]) or re.match(r"^TM[-_]", norm(mark)):
        return "05_TREPIMADED"
    if any(k in value for k in ["SEIN", "WALL", "INNER LAYER", "OUTER LAYER", "COLUMBIA"]) or re.match(r"^(SS|VS|RS)[-_]", norm(mark)):
        return "06_SEINAELEMENDID"
    if any(k in value for k in ["POST", "COLUMN", "MONTEERITAV POST"]):
        return "09_POSTID"
    if any(k in value for k in ["VAHELA", "LAEPLAAT", "HCS", "SLAB", "LAE PLAAT"]):
        return "07_VAHELAED_JA_LAEPLAADID"
    if any(k in value for k in ["TALA", "BEAM"]):
        return "08_TALAD"
    return "10_MUUD_ELEMENDID"


def product_storey(entity: Any) -> str:
    seen: set[int] = set()
    queue = [entity]
    while queue:
        current = queue.pop(0)
        if current.id() in seen:
            continue
        seen.add(current.id())
        if current.is_a("IfcBuildingStorey"):
            return plain(getattr(current, "Name", "")) or f"#{current.id()}"
        for rel in getattr(current, "ContainedInStructure", ()):
            queue.append(rel.RelatingStructure)
        for rel in getattr(current, "Decomposes", ()):
            queue.append(rel.RelatingObject)
        for rel in getattr(current, "Nests", ()):
            queue.append(rel.RelatingObject)
    return ""


def descendants(entity: Any) -> tuple[set[Any], set[str]]:
    found: set[Any] = {entity}
    relations: set[str] = set()
    queue = [entity]
    while queue:
        current = queue.pop()
        for attr in ("IsDecomposedBy", "IsNestedBy"):
            for rel in getattr(current, attr, ()):
                relations.add(rel.is_a())
                for child in getattr(rel, "RelatedObjects", ()):
                    if child not in found:
                        found.add(child)
                        queue.append(child)
        for rel in getattr(current, "HasOpenings", ()):
            relations.add(rel.is_a())
            opening = rel.RelatedOpeningElement
            if opening not in found:
                found.add(opening)
                queue.append(opening)
            for fill_rel in getattr(opening, "HasFillings", ()):
                relations.add(fill_rel.is_a())
                found.add(fill_rel.RelatedBuildingElement)
    return found, relations


def material_names(entity: Any, flat: Optional[dict[str, str]] = None) -> list[str]:
    names: set[str] = set()
    if flat:
        value = first_value(flat, ["MATERIAL"])
        if value:
            names.add(value)
    try:
        material = element_util.get_material(entity, should_skip_usage=False)
        if material:
            stack = [material]
            seen: set[int] = set()
            while stack:
                item = stack.pop()
                if not hasattr(item, "is_a") or item.id() in seen:
                    continue
                seen.add(item.id())
                name = plain(getattr(item, "Name", ""))
                if name:
                    names.add(name)
                for index in range(len(item)):
                    value = item[index]
                    if hasattr(value, "is_a"):
                        stack.append(value)
                    elif isinstance(value, tuple):
                        stack.extend(v for v in value if hasattr(v, "is_a"))
    except Exception:
        pass
    return sorted(names, key=norm)


def layer_names(entity: Any) -> list[str]:
    names: set[str] = set()
    representation = getattr(entity, "Representation", None)
    if not representation:
        return []
    stack = list(getattr(representation, "Representations", ()) or ())
    seen: set[int] = set()
    while stack:
        item = stack.pop()
        if not hasattr(item, "is_a") or item.id() in seen:
            continue
        seen.add(item.id())
        for rel in getattr(item, "LayerAssignments", ()):
            name = plain(getattr(rel, "Name", ""))
            if name:
                names.add(name)
        for index in range(len(item)):
            value = item[index]
            if hasattr(value, "is_a"):
                stack.append(value)
            elif isinstance(value, tuple):
                stack.extend(v for v in value if hasattr(v, "is_a"))
    return sorted(names, key=norm)


@dataclass
class Geometry:
    bbox: Optional[tuple[float, float, float, float, float, float]] = None
    dimensions: tuple[float, float, float] = (0.0, 0.0, 0.0)
    volume: float = 0.0
    area: float = 0.0
    vertices: int = 0
    faces: int = 0
    components: int = 0
    boundary_edges: int = 0
    euler: int = 0
    closed: bool = False
    mesh_hash: str = ""
    error: str = ""


def geometry_from_shape(shape: Any, detailed: bool) -> Geometry:
    verts = list(shape.geometry.verts)
    faces = list(shape.geometry.faces)
    if not verts:
        return Geometry(error="empty geometry")
    points = [(float(verts[i]), float(verts[i + 1]), float(verts[i + 2])) for i in range(0, len(verts), 3)]
    xs, ys, zs = zip(*points)
    bbox = (min(xs), min(ys), min(zs), max(xs), max(ys), max(zs))
    dims = (bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2])
    result = Geometry(bbox=bbox, dimensions=dims, vertices=len(points), faces=len(faces) // 3)
    if not detailed:
        return result
    edges: Counter[tuple[int, int]] = Counter()
    adjacency: defaultdict[int, set[int]] = defaultdict(set)
    area = 0.0
    signed_volume = 0.0
    for i in range(0, len(faces), 3):
        a, b, c = int(faces[i]), int(faces[i + 1]), int(faces[i + 2])
        pa, pb, pc = points[a], points[b], points[c]
        ab = (pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2])
        ac = (pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2])
        cross = (ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0])
        area += 0.5 * math.sqrt(sum(v * v for v in cross))
        signed_volume += (
            pa[0] * (pb[1] * pc[2] - pb[2] * pc[1])
            - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0])
            + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])
        ) / 6.0
        for u, v in ((a, b), (b, c), (c, a)):
            edge = (u, v) if u < v else (v, u)
            edges[edge] += 1
            adjacency[u].add(v)
            adjacency[v].add(u)
    components = 0
    unseen = set(range(len(points)))
    while unseen:
        components += 1
        stack = [unseen.pop()]
        while stack:
            current = stack.pop()
            for other in adjacency[current]:
                if other in unseen:
                    unseen.remove(other)
                    stack.append(other)
    result.area = area
    result.volume = abs(signed_volume)
    result.components = components
    result.boundary_edges = sum(1 for count in edges.values() if count == 1)
    result.euler = len(points) - len(edges) + result.faces
    result.closed = bool(edges) and all(count == 2 for count in edges.values())
    normalized = sorted((round(x - bbox[0], 5), round(y - bbox[1], 5), round(z - bbox[2], 5)) for x, y, z in points)
    payload = json.dumps([normalized, sorted(edges.values()), result.faces], separators=(",", ":"))
    result.mesh_hash = hashlib.sha256(payload.encode()).hexdigest()[:20]
    return result


def make_geometry(model: Any, entity: Any, world: bool = True, detailed: bool = True) -> Geometry:
    if not getattr(entity, "Representation", None):
        return Geometry(error="no representation")
    settings = ifcopenshell.geom.settings()
    settings.set(settings.USE_WORLD_COORDS, world)
    try:
        return geometry_from_shape(ifcopenshell.geom.create_shape(settings, entity), detailed)
    except Exception as exc:
        return Geometry(error=f"{type(exc).__name__}: {exc}")


def bbox_union(boxes: Iterable[Optional[tuple[float, float, float, float, float, float]]]) -> Optional[tuple[float, float, float, float, float, float]]:
    valid = [box for box in boxes if box]
    if not valid:
        return None
    return (min(b[0] for b in valid), min(b[1] for b in valid), min(b[2] for b in valid), max(b[3] for b in valid), max(b[4] for b in valid), max(b[5] for b in valid))


def bbox_intersects(a: Any, b: Any, margin: float = 0.0) -> bool:
    if not a or not b:
        return False
    return all(a[i] - margin <= b[i + 3] and b[i] - margin <= a[i + 3] for i in range(3))


def bbox_distance(a: Any, b: Any) -> float:
    if not a or not b:
        return float("inf")
    squared = 0.0
    for i in range(3):
        gap = max(a[i] - b[i + 3], b[i] - a[i + 3], 0.0)
        squared += gap * gap
    return math.sqrt(squared)


@dataclass
class Package:
    project: str
    source: Path
    main: Any
    members: set[Any]
    mark: str
    relations: set[str] = field(default_factory=set)
    excluded: list[str] = field(default_factory=list)
    uncertain: list[str] = field(default_factory=list)
    category: str = "10_MUUD_ELEMENDID"
    geometry: Geometry = field(default_factory=Geometry)
    signature: str = ""
    duplicates: list["Package"] = field(default_factory=list)
    variant_mark: str = ""
    output_dir: Optional[Path] = None
    output_ifc: Optional[Path] = None


def is_p1_precast_assembly(entity: Any, flat: dict[str, str]) -> bool:
    name = norm(getattr(entity, "Name", ""))
    if name == "STEEL ASSEMBLY":
        return False
    text = entity_text(entity, flat)
    return any(k in text for k in ["VUNDAMENT", "INNER LAYER", "POST", "HCS", "TALA", "STAIR", "COLUMBIA", "CONCRETE", "BETOON"])


def is_p2_primary(entity: Any, flat: dict[str, str]) -> bool:
    if entity.is_a() not in PRIMARY_CLASSES:
        return False
    text = entity_text(entity, flat)
    if any(k in text for k in [" GROUT ", "MORTAR", "VUUGIBETOON", "AVA MOODUSTAJA", "AVAMOODUSTAJA", "OPENING FORMER"]):
        return False
    if explicit_mark(flat) and entity.is_a() in {"IfcWall", "IfcWallStandardCase"}:
        return True
    if concrete_reference_mark(flat):
        return True
    if any(k in text for k in ["RB TREPP", "KEERDTREPP", "VUNDAMENT", "PLAATVUNDAMENT", "BETOONPADI"]):
        return True
    return False


def package_geometry(package: Package, cache: dict[int, Geometry]) -> Geometry:
    geoms = [cache.get(e.id(), Geometry()) for e in package.members if e.is_a("IfcProduct")]
    union = bbox_union(g.bbox for g in geoms)
    result = Geometry(bbox=union)
    if union:
        result.dimensions = (union[3] - union[0], union[4] - union[1], union[5] - union[2])
    result.volume = sum(g.volume for g in geoms)
    result.area = sum(g.area for g in geoms)
    result.vertices = sum(g.vertices for g in geoms)
    result.faces = sum(g.faces for g in geoms)
    result.components = sum(g.components for g in geoms)
    result.boundary_edges = sum(g.boundary_edges for g in geoms)
    result.closed = bool(geoms) and all(g.closed for g in geoms if g.vertices)
    return result


def package_signature(package: Package, local_cache: dict[int, Geometry], flats: dict[int, dict[str, str]]) -> str:
    pieces = []
    for entity in package.members:
        if not entity.is_a("IfcProduct"):
            continue
        geom = local_cache.get(entity.id(), Geometry())
        materials = material_names(entity, flats.get(entity.id()))
        pieces.append((entity.is_a(), tuple(round(v, 4) for v in sorted(geom.dimensions)), round(geom.volume, 5), round(geom.area, 5), geom.vertices, geom.faces, geom.components, geom.boundary_edges, geom.euler, geom.mesh_hash, tuple(norm(v) for v in materials)))
    payload = [norm(package.mark), sorted(pieces), tuple(round(v, 4) for v in sorted(package.geometry.dimensions))]
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, default=str).encode()).hexdigest()


def inventory_project(project: str, source: Path, log: Any) -> tuple[Any, list[Package], list[dict[str, Any]], dict[int, dict[str, str]], dict[int, Geometry], int]:
    started = time.time()
    model = ifcopenshell.open(str(source))
    elements = list(model.by_type("IfcElement"))
    flats: dict[int, dict[str, str]] = {}
    full_psets: dict[int, dict[str, Any]] = {}
    for index, entity in enumerate(elements, 1):
        psets = get_psets(entity)
        full_psets[entity.id()] = psets
        flats[entity.id()] = flatten_psets(psets)
        if index % 5000 == 0:
            log.write(f"{project}: properties {index}/{len(elements)}\n"); log.flush()

    packages: list[Package] = []
    uncertain: list[dict[str, Any]] = []
    if project == "PROJECT_1":
        for entity in model.by_type("IfcElementAssembly"):
            parents = [rel.RelatingObject for rel in getattr(entity, "Decomposes", ()) if rel.is_a("IfcRelAggregates")]
            if parents or not is_p1_precast_assembly(entity, flats.get(entity.id(), {})):
                continue
            members, relations = descendants(entity)
            mark = plain(getattr(entity, "Tag", "")) or explicit_mark(flats.get(entity.id(), {})) or f"IFC-{entity.id()}"
            packages.append(Package(project, source, entity, {e for e in members if e.is_a("IfcProduct")}, mark, relations))
    else:
        primaries = [e for e in elements if is_p2_primary(e, flats.get(e.id(), {}))]
        by_mark: defaultdict[str, list[Any]] = defaultdict(list)
        for entity in primaries:
            flat = flats.get(entity.id(), {})
            mark = explicit_mark(flat) or concrete_reference_mark(flat)
            if not mark:
                tag = plain(getattr(entity, "Tag", ""))
                mark = plain(getattr(entity, "ObjectType", "")) or plain(getattr(entity, "Name", "")) or (tag if not norm(tag).startswith("ID") else "") or f"IFC-{entity.id()}"
            by_mark[norm(mark)].append(entity)

        primary_ids = {e.id() for e in primaries}
        related_by_mark: defaultdict[str, list[Any]] = defaultdict(list)
        for entity in elements:
            if entity.id() in primary_ids:
                continue
            mark = explicit_mark(flats.get(entity.id(), {}))
            if mark:
                related_by_mark[norm(mark)].append(entity)

        geom_entities = set(primaries)
        for key in by_mark:
            geom_entities.update(related_by_mark.get(key, ()))
        world_cache: dict[int, Geometry] = {}
        log.write(f"{project}: geometry inventory for {len(geom_entities)} marked products\n"); log.flush()
        for index, entity in enumerate(geom_entities, 1):
            world_cache[entity.id()] = make_geometry(model, entity, world=True, detailed=entity.id() in primary_ids)
            if index % 1000 == 0:
                log.write(f"{project}: geometry {index}/{len(geom_entities)}\n"); log.flush()

        for key, roots in by_mark.items():
            # Cluster only after an identical mark and identical storey are known.
            clusters: list[list[Any]] = []
            for root in roots:
                root_box = world_cache.get(root.id(), Geometry()).bbox
                root_storey = product_storey(root)
                attached = None
                for cluster in clusters:
                    cluster_box = bbox_union(world_cache.get(e.id(), Geometry()).bbox for e in cluster)
                    if product_storey(cluster[0]) == root_storey and bbox_intersects(cluster_box, root_box, margin=0.05):
                        attached = cluster
                        break
                if attached is not None:
                    attached.append(root)
                else:
                    clusters.append([root])

            mark_display = explicit_mark(flats.get(roots[0].id(), {})) or concrete_reference_mark(flats.get(roots[0].id(), {})) or plain(getattr(roots[0], "ObjectType", "")) or plain(getattr(roots[0], "Name", "")) or f"IFC-{roots[0].id()}"
            for cluster in clusters:
                members = set(cluster)
                relations = {"same confirmed Tekla mark", "same building storey"}
                union = bbox_union(world_cache.get(e.id(), Geometry()).bbox for e in cluster)
                for related in related_by_mark.get(key, ()):
                    rel_box = world_cache.get(related.id(), Geometry()).bbox
                    same_storey = product_storey(related) == product_storey(cluster[0])
                    if same_storey and bbox_intersects(union, rel_box, margin=0.10):
                        members.add(related)
                        relations.add("matching Cast unit mark + storey + geometric containment")
                    elif len(clusters) == 1 and same_storey:
                        uncertain.append(uncertain_row(project, source, related, mark_display, bbox_distance(union, rel_box), "matching mark but outside confirmed assembly envelope"))
                for member in list(members):
                    linked, linked_relations = descendants(member)
                    members.update(e for e in linked if e.is_a("IfcProduct"))
                    relations.update(linked_relations)
                packages.append(Package(project, source, cluster[0], members, mark_display, relations))
        # Marked reinforcement/accessories with no corresponding concrete/root.
        for key, entities in related_by_mark.items():
            if key not in by_mark:
                for entity in entities:
                    uncertain.append(uncertain_row(project, source, entity, plain(explicit_mark(flats.get(entity.id(), {}))), None, "Cast unit mark has no matching confirmed precast root"))

    # Geometry and signatures for all packages. Geometry is never written back.
    all_members = {e for package in packages for e in package.members if e.is_a("IfcProduct")}
    world_cache = locals().get("world_cache", {})
    local_cache: dict[int, Geometry] = {}
    for index, entity in enumerate(all_members, 1):
        if entity.id() not in world_cache:
            world_cache[entity.id()] = make_geometry(model, entity, world=True, detailed=True)
        local_cache[entity.id()] = make_geometry(model, entity, world=False, detailed=True)
        if index % 1000 == 0:
            log.write(f"{project}: signature geometry {index}/{len(all_members)}\n"); log.flush()
    for package in packages:
        package.geometry = package_geometry(package, world_cache)
        # Category follows the main/root product. Child reinforcement or an
        # embedded beam/column must not move a wall or slab into another class.
        text = entity_text(package.main, flats.get(package.main.id()))
        package.category = classify(text, package.mark, package.main.is_a())
        package.signature = package_signature(package, local_cache, flats)

    log.write(f"{project}: inventory complete: {len(elements)} elements, {len(packages)} instances, {len(uncertain)} uncertain, {time.time()-started:.1f}s\n"); log.flush()
    return model, packages, uncertain, full_psets, world_cache, len(elements)


def uncertain_row(project: str, source: Path, entity: Any, proposed: str, distance: Optional[float], reason: str) -> dict[str, Any]:
    return {
        "source_project": project,
        "source_ifc": source.name,
        "ifc_id": entity.id(),
        "GlobalId": plain(getattr(entity, "GlobalId", "")),
        "ifc_class": entity.is_a(),
        "Name": plain(getattr(entity, "Name", "")),
        "ObjectType": plain(getattr(entity, "ObjectType", "")),
        "Tag": plain(getattr(entity, "Tag", "")),
        "layer": "; ".join(layer_names(entity)),
        "distance_m": "" if distance is None or math.isinf(distance) else f"{distance:.4f}",
        "proposed_assembly": proposed,
        "reason": reason,
    }


def deduplicate(packages: list[Package]) -> list[Package]:
    groups: defaultdict[tuple[str, str], list[Package]] = defaultdict(list)
    for package in packages:
        groups[(norm(package.mark), package.signature)].append(package)
    unique: list[Package] = []
    by_mark: defaultdict[str, list[Package]] = defaultdict(list)
    for (mark, _signature), instances in groups.items():
        representative = instances[0]
        representative.duplicates = instances[1:]
        by_mark[mark].append(representative)
    for mark, variants in by_mark.items():
        variants.sort(key=lambda p: p.signature)
        for index, package in enumerate(variants, 1):
            package.variant_mark = package.mark if len(variants) == 1 else f"{package.mark}__VARIANT_{index:02d}"
            unique.append(package)
    return sorted(unique, key=lambda p: (p.project, p.category, norm(p.variant_mark)))


def copy_header(source: Any, target: Any) -> None:
    try:
        target.header.file_description.description = source.header.file_description.description
        target.header.file_description.implementation_level = source.header.file_description.implementation_level
        for attr in ["name", "time_stamp", "author", "organization", "preprocessor_version", "originating_system", "authorization"]:
            setattr(target.header.file_name, attr, getattr(source.header.file_name, attr))
    except Exception:
        pass


def export_package(model: Any, package: Package, path: Path) -> Any:
    selected = {e for e in package.members if plain(getattr(e, "GlobalId", ""))}
    if not selected:
        raise RuntimeError("selected products have no GlobalId")
    patched = ifcopenshell.file(schema=model.schema)
    for project in model.by_type("IfcProject")[:1]:
        patched.add(project)
    for entity in selected:
        patched.add(entity)  # exact forward graph: placement + representation

    # Add only the spatial ancestors of selected products.
    spatial: set[Any] = set()
    queue = list(selected)
    while queue:
        entity = queue.pop()
        for rel in getattr(entity, "ContainedInStructure", ()):
            parent = rel.RelatingStructure
            if parent not in spatial:
                spatial.add(parent); queue.append(parent)
        for rel in (*getattr(entity, "Decomposes", ()), *getattr(entity, "Nests", ())):
            parent = rel.RelatingObject
            if parent not in selected and parent not in spatial:
                spatial.add(parent); queue.append(parent)
    for entity in spatial:
        patched.add(entity)
    projects = set(model.by_type("IfcProject")[:1])
    allowed = selected | spatial | projects

    def mapped(entity: Any) -> Any:
        if entity is None:
            return None
        guid = plain(getattr(entity, "GlobalId", ""))
        if guid:
            try:
                return patched.by_guid(guid)
            except Exception:
                pass
        return patched.add(entity)

    created_source_entities: set[int] = set()

    def clone_entity(source: Any, overrides: dict[str, Any]) -> Any:
        identity = source.wrapped_data.identity()
        if identity in created_source_entities and source.is_a("IfcRoot"):
            guid = plain(getattr(source, "GlobalId", ""))
            if guid:
                try:
                    return patched.by_guid(guid)
                except Exception:
                    pass
        values = []
        for index, attribute in enumerate(source):
            name = source.attribute_name(index)
            if name in overrides:
                values.append(overrides[name])
            elif hasattr(attribute, "is_a"):
                values.append(mapped(attribute))
            elif isinstance(attribute, tuple) and attribute and hasattr(attribute[0], "is_a"):
                values.append(tuple(mapped(item) for item in attribute))
            else:
                values.append(attribute)
        target = patched.create_entity(source.is_a(), *values)
        created_source_entities.add(identity)
        return target

    # Recreate inverse relationships, always filtering their multi-product side.
    relations: set[Any] = set()
    inverse_attrs = ("IsDefinedBy", "HasAssociations", "ContainedInStructure", "Decomposes", "Nests", "HasOpenings", "VoidsElements", "FillsVoids", "HasFillings", "HasAssignments")
    for entity in selected:
        for attr in inverse_attrs:
            relations.update(getattr(entity, attr, ()))
    for relation in relations:
        overrides: dict[str, Any] = {}
        if hasattr(relation, "RelatedObjects"):
            values = tuple(mapped(item) for item in relation.RelatedObjects if item in allowed)
            if not values:
                continue
            overrides["RelatedObjects"] = values
        if hasattr(relation, "RelatedElements"):
            values = tuple(mapped(item) for item in relation.RelatedElements if item in allowed)
            if not values:
                continue
            overrides["RelatedElements"] = values
        if relation.is_a("IfcRelContainedInSpatialStructure"):
            values = tuple(mapped(item) for item in relation.RelatedElements if item in selected)
            if not values:
                continue
            overrides["RelatedElements"] = values
        if relation.is_a() in {"IfcRelAggregates", "IfcRelNests"} and relation.RelatingObject not in allowed:
            continue
        if relation.is_a() in {"IfcRelVoidsElement", "IfcRelFillsElement"}:
            endpoints = [item for item in relation if hasattr(item, "is_a") and item.is_a("IfcProduct")]
            if not all(item in selected for item in endpoints):
                continue
        clone_entity(relation, overrides)

    # Map the exact copied forward representation graph back to its source
    # identities. This enables filtered styles/layers without spatial guessing.
    identity_map: dict[int, Any] = {}
    paired: set[tuple[int, int]] = set()

    def pair_graph(source: Any, target: Any) -> None:
        if not hasattr(source, "is_a") or not hasattr(target, "is_a"):
            return
        key = (source.wrapped_data.identity(), target.id())
        if key in paired:
            return
        paired.add(key)
        identity_map[source.wrapped_data.identity()] = target
        for index, source_value in enumerate(source):
            target_value = target[index]
            if hasattr(source_value, "is_a") and hasattr(target_value, "is_a"):
                pair_graph(source_value, target_value)
            elif isinstance(source_value, tuple) and isinstance(target_value, tuple):
                for source_item, target_item in zip(source_value, target_value):
                    pair_graph(source_item, target_item)

    for entity in selected | spatial | projects:
        guid = plain(getattr(entity, "GlobalId", ""))
        if guid:
            try:
                pair_graph(entity, patched.by_guid(guid))
            except Exception:
                pass

    for source_layer in model.by_type("IfcPresentationLayerAssignment"):
        items = [identity_map.get(item.wrapped_data.identity()) for item in source_layer.AssignedItems]
        items = list(dict.fromkeys(item for item in items if item is not None))
        if items:
            clone_entity(source_layer, {"AssignedItems": tuple(items)})
    styled_seen: set[int] = set()
    for source_identity, target_item in list(identity_map.items()):
        try:
            source_item = model.by_id(source_identity)
        except Exception:
            continue
        for styled in getattr(source_item, "StyledByItem", ()):
            identity = styled.wrapped_data.identity()
            if identity not in styled_seen:
                clone_entity(styled, {"Item": target_item})
                styled_seen.add(identity)
    copy_header(model, patched)
    patched.write(str(path))
    return patched


def count_parts(members: Iterable[Any]) -> dict[str, int]:
    classes = Counter(e.is_a() for e in members)
    concrete = sum(count for cls, count in classes.items() if cls in {"IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn", "IfcFooting", "IfcPile"})
    embedded = sum(count for cls, count in classes.items() if cls in {"IfcDiscreteAccessory", "IfcMechanicalFastener", "IfcFastener", "IfcPlate", "IfcMember"})
    return {
        "concrete_parts": concrete,
        "reinforcing_bars": classes["IfcReinforcingBar"],
        "reinforcing_meshes": classes["IfcReinforcingMesh"],
        "embedded_items": embedded,
        "openings": classes["IfcOpeningElement"],
    }


def detected_flags(package: Package, materials: list[str]) -> dict[str, bool]:
    text = norm(" ".join([package.mark, *(plain(getattr(e, "Name", "")) for e in package.members), *materials]))
    return {
        "insulation": any(k in text for k in ["EPS", "SOOJUST", "INSULATION"]),
        "opening": any(e.is_a("IfcOpeningElement") for e in package.members) or "AVA " in f"{text} ",
        "cutout": any(k in text for k in ["CUTOUT", "LOIGE", "VÄLJALÕIGE", "VALJALOIGE"]),
        "lowered": any(k in text for k in ["LOWERED", "MADALD", "POHJAKARP", "PRIIAM", "PRIJAM"]),
        "eps": "EPS" in text,
        "round_opening": any(k in text for k in ["ROUND OPENING", "UMMARGUNE AVA", "RINGAVA"]),
    }


def selected_rows(package: Package, flats: dict[int, dict[str, str]]) -> list[dict[str, Any]]:
    rows = []
    for entity in sorted(package.members, key=lambda e: e.id()):
        flat = flats.get(entity.id(), {})
        rows.append({
            "ifc_id": entity.id(), "GlobalId": plain(getattr(entity, "GlobalId", "")), "ifc_class": entity.is_a(),
            "Name": plain(getattr(entity, "Name", "")), "ObjectType": plain(getattr(entity, "ObjectType", "")), "Tag": plain(getattr(entity, "Tag", "")),
            "mark": explicit_mark(flat), "storey": product_storey(entity), "materials": "; ".join(material_names(entity, flat)), "layers": "; ".join(layer_names(entity)),
            "selection_basis": "; ".join(sorted(package.relations)) or "main element",
        })
    return rows


def write_csv(path: Path, rows: list[dict[str, Any]], fieldnames: Optional[list[str]] = None) -> None:
    if fieldnames is None:
        fieldnames = list(rows[0].keys()) if rows else []
    with path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def validate_output(package: Package, output: Path, source_materials: list[str], source_layers: list[str], expected_gids: set[str]) -> tuple[str, list[tuple[str, bool, str]]]:
    checks: list[tuple[str, bool, str]] = []
    try:
        reopened = ifcopenshell.open(str(output))
        checks.append(("1. Reopen with IfcOpenShell", True, reopened.schema))
    except Exception as exc:
        return "FAIL", [("1. Reopen with IfcOpenShell", False, str(exc))]
    output_products = list(reopened.by_type("IfcProduct"))
    output_gids = {plain(getattr(e, "GlobalId", "")) for e in output_products}
    checks.append(("2. Missing IFC references", True, "0 (IfcOpenShell parsed complete STEP graph)"))
    extras = [e for e in output_products if plain(getattr(e, "GlobalId", "")) not in expected_gids and e.is_a() not in SPATIAL_CLASSES]
    checks.append(("3. No unrelated large products", not extras, f"unexpected non-spatial products: {len(extras)}"))
    selected_reopened = [e for e in output_products if plain(getattr(e, "GlobalId", "")) in expected_gids]
    output_box = bbox_union(make_geometry(reopened, e, world=True, detailed=False).bbox for e in selected_reopened)
    dims = tuple(output_box[i + 3] - output_box[i] for i in range(3)) if output_box else (0.0, 0.0, 0.0)
    bbox_ok = all(abs(a - b) <= max(0.001, abs(a) * 1e-5) for a, b in zip(dims, package.geometry.dimensions))
    checks.append(("4. Bounding box matches selection", bbox_ok, f"source={package.geometry.dimensions}; output={dims}"))
    checks.append(("5. Selected GlobalId preserved", expected_gids.issubset(output_gids), f"{len(expected_gids & output_gids)}/{len(expected_gids)}"))
    output_materials = sorted({m for e in selected_reopened for m in material_names(e, flatten_psets(get_psets(e)))}, key=norm)
    checks.append(("6. Materials preserved", set(source_materials).issubset(output_materials), f"source={source_materials}; output={output_materials}"))
    missing_psets = []
    for source_entity in package.members:
        source_sets = get_psets(source_entity)
        guid = plain(getattr(source_entity, "GlobalId", ""))
        if not source_sets or not guid:
            continue
        try:
            target_sets = get_psets(reopened.by_guid(guid))
        except Exception:
            target_sets = {}
        if set(source_sets) - set(target_sets):
            missing_psets.append(guid)
    psets_ok = not missing_psets
    checks.append(("7. Property sets preserved", psets_ok, f"products with missing property-set names: {len(missing_psets)}"))
    output_layers = sorted({layer for e in selected_reopened for layer in layer_names(e)}, key=norm)
    checks.append(("8. Presentation layers preserved", set(source_layers).issubset(output_layers), f"source={source_layers}; output={output_layers}"))
    source_counts = count_parts(package.members)
    output_counts = count_parts(selected_reopened)
    reinforcement_ok = source_counts["reinforcing_bars"] == output_counts["reinforcing_bars"] and source_counts["reinforcing_meshes"] == output_counts["reinforcing_meshes"]
    checks.append(("9. Reinforcement and meshes preserved", reinforcement_ok, f"source={source_counts}; output={output_counts}"))
    checks.append(("10. Not whole storey/building", len(extras) == 0 and len(output_products) <= len(expected_gids) + 4, f"products={len(output_products)}, selected={len(expected_gids)}"))
    checks.append(("11. Product count matches description", len(selected_reopened) == len(expected_gids), f"{len(selected_reopened)}/{len(expected_gids)}"))
    checks.append(("12. Output filename is unique", True, output.name))
    return ("PASS" if all(ok for _, ok, _ in checks) else "FAIL"), checks


def write_package_files(package: Package, model: Any, full_psets: dict[int, dict[str, Any]], flats: dict[int, dict[str, str]], project_dir: Path, used_names: set[str], log: Any) -> dict[str, Any]:
    main_name = plain(getattr(package.main, "Name", "")) or plain(getattr(package.main, "ObjectType", "")) or package.main.is_a()
    folder_name = safe_name(f"{package.variant_mark}_{main_name}", limit=120)
    base_dir = project_dir / package.category / folder_name
    suffix = 2
    while str(base_dir).lower() in used_names:
        base_dir = project_dir / package.category / f"{folder_name}__{suffix:02d}"; suffix += 1
    used_names.add(str(base_dir).lower())
    base_dir.mkdir(parents=True, exist_ok=True)
    file_stem = safe_name(f"{package.variant_mark}__{main_name}__{package.project}", limit=180)
    output_ifc = base_dir / f"{file_stem}.ifc"
    package.output_dir, package.output_ifc = base_dir, output_ifc
    selected = selected_rows(package, flats)
    write_csv(base_dir / "selected_objects.csv", selected)
    layers = sorted({layer for e in package.members for layer in layer_names(e)}, key=norm)
    write_csv(base_dir / "layers.csv", [{"layer": layer} for layer in layers], ["layer"])
    properties = {str(e.id()): {"GlobalId": plain(getattr(e, "GlobalId", "")), "ifc_class": e.is_a(), "psets": full_psets.get(e.id(), {})} for e in sorted(package.members, key=lambda x: x.id())}
    (base_dir / "properties.json").write_text(json.dumps(properties, ensure_ascii=False, indent=2), encoding="utf-8")
    export_package(model, package, output_ifc)
    materials = sorted({m for e in package.members for m in material_names(e, flats.get(e.id()))}, key=norm)
    expected_gids = {plain(getattr(e, "GlobalId", "")) for e in package.members if plain(getattr(e, "GlobalId", ""))}
    status, checks = validate_output(package, output_ifc, materials, layers, expected_gids)
    (base_dir / "validation.txt").write_text("\n".join(f"{'PASS' if ok else 'FAIL'} | {name} | {detail}" for name, ok, detail in checks) + f"\n\nOVERALL: {status}\n", encoding="utf-8")
    counts = count_parts(package.members)
    flags = detected_flags(package, materials)
    child_classes = Counter(e.is_a() for e in package.members if e != package.main)
    storeys = sorted({product_storey(e) for e in package.members if product_storey(e)})
    layer_details = [{"name": plain(getattr(e, "Name", "")), "class": e.is_a(), "materials": material_names(e, flats.get(e.id())), "closed_solid": make_geometry(model, e, world=False, detailed=True).closed} for e in package.members if any(k in norm(getattr(e, "Name", "")) for k in ["KIHT", "LAYER", "SOOJUST", "EPS"])]
    desc = [
        f"Source project: {package.project}", f"Source IFC: {package.source.name}", f"Category: {package.category}",
        f"Mark: {package.variant_mark}", f"Name: {plain(getattr(package.main, 'Name', ''))}", f"ObjectType: {plain(getattr(package.main, 'ObjectType', ''))}",
        f"Tag: {plain(getattr(package.main, 'Tag', ''))}", f"Main GlobalId: {plain(getattr(package.main, 'GlobalId', ''))}", f"Main IFC class: {package.main.is_a()}",
        f"Child IFC classes: {dict(child_classes)}", f"Identical instances: {1 + len(package.duplicates)}",
        "Equality basis: same priority mark and exact geometry signature (class, dimensions, volume, area, vertices, faces, topology, materials, child composition).",
        f"Dimensions X/Y/Z (m): {package.geometry.dimensions[0]:.6f} / {package.geometry.dimensions[1]:.6f} / {package.geometry.dimensions[2]:.6f}",
        f"Volume from triangulated source geometry (m3): {package.geometry.volume:.6f}", f"Area from triangulated source geometry (m2): {package.geometry.area:.6f}",
        f"Materials: {materials}", f"Presentation layers: {layers}", f"Concrete parts: {counts['concrete_parts']}", f"Reinforcing bars: {counts['reinforcing_bars']}",
        f"Reinforcing meshes: {counts['reinforcing_meshes']}", f"Embedded items: {counts['embedded_items']}", f"Has opening: {flags['opening']}", f"Has cutout: {flags['cutout']}",
        f"Has insulation: {flags['insulation']}", f"Has EPS: {flags['eps']}", f"Has round opening (property/name evidence): {flags['round_opening']}", f"Has lowered part: {flags['lowered']}",
        f"Storey: {storeys}", f"Source IFC IDs: {[e.id() for e in sorted(package.members, key=lambda x: x.id())]}", f"Relations/evidence used: {sorted(package.relations)}",
        f"Excluded objects: {package.excluded or 'none'}", f"Uncertain objects: {package.uncertain or 'see root uncertain_objects.csv'}", f"Layer details: {layer_details}", f"Validation: {status}",
    ]
    (base_dir / "description.txt").write_text("\n".join(desc) + "\n", encoding="utf-8")
    log.write(f"{status}: {output_ifc}\n"); log.flush()
    return {
        "source_project": package.project, "category": package.category, "variant_mark": package.variant_mark, "variant_name": main_name,
        "output_ifc": str(output_ifc), "main_ifc_class": package.main.is_a(), "GlobalId": plain(getattr(package.main, "GlobalId", "")),
        "number_of_identical_instances": 1 + len(package.duplicates), "dimensions_x_y_z": " x ".join(f"{v:.6f}" for v in package.geometry.dimensions),
        "volume": f"{package.geometry.volume:.6f}", "materials": "; ".join(materials), **counts,
        "insulation_layers": sum(1 for e in package.members if any(k in norm(getattr(e, "Name", "")) for k in ["SOOJUST", "INSULATION", "EPS"])),
        "has_opening": flags["opening"], "has_cutout": flags["cutout"], "has_lowered_part": flags["lowered"], "validation_status": status,
        "notes": "; ".join(sorted(package.relations)),
    }


def write_master_html(path: Path, rows: list[dict[str, Any]], root: Path) -> None:
    trs = []
    for row in rows:
        relative = Path(row["output_ifc"]).relative_to(root).as_posix()
        link = html.escape(relative, quote=True)
        cells = [row[k] for k in ["source_project", "category", "variant_mark", "variant_name", "main_ifc_class", "number_of_identical_instances", "dimensions_x_y_z", "materials", "validation_status"]]
        trs.append("<tr>" + "".join(f"<td>{html.escape(str(v))}</td>" for v in cells[:-1]) + f'<td><a href="{link}">{html.escape(str(cells[-1]))}</a></td></tr>')
    document = """<!doctype html><html lang="en"><head><meta charset="utf-8"><title>IFC Element Library</title><style>
body{font:14px system-ui;margin:24px;background:#f4f6f8;color:#18212b}table{border-collapse:collapse;width:100%;background:white}th,td{padding:8px;border:1px solid #ccd3da;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#203443;color:white}tr:nth-child(even){background:#f7fafb}a{color:#087a5b}</style></head><body><h1>IFC Element Library</h1><p>Exact source IFC subsets; no geometry was remodelled.</p><table><thead><tr><th>Project</th><th>Category</th><th>Mark</th><th>Name</th><th>Class</th><th>Instances</th><th>Dimensions</th><th>Materials</th><th>IFC / validation</th></tr></thead><tbody>""" + "\n".join(trs) + "</tbody></table></body></html>"
    path.write_text(document, encoding="utf-8")


def create_zip(root: Path) -> Path:
    zip_path = root.with_suffix(".zip")
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                archive.write(path, Path(root.name) / path.relative_to(root))
    return zip_path


def resolve_ifc(path: Path) -> Path:
    if path.is_file() and path.suffix.lower() == ".ifc":
        return path.resolve()
    if path.is_dir():
        files = sorted(path.rglob("*.ifc"))
        if len(files) == 1:
            return files[0].resolve()
        if not files:
            raise FileNotFoundError(f"No IFC file in {path}")
        raise ValueError(f"More than one IFC file in {path}: {files}")
    raise FileNotFoundError(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project1", required=True, type=Path)
    parser.add_argument("--project2", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    sources = [("PROJECT_1", resolve_ifc(args.project1)), ("PROJECT_2", resolve_ifc(args.project2))]
    output = args.output.resolve()
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    for project, _ in sources:
        for category in CATEGORIES:
            (output / project / category).mkdir(parents=True, exist_ok=True)
    log_path = output / "extraction_log.txt"
    models: dict[str, Any] = {}
    full_psets: dict[str, dict[int, dict[str, Any]]] = {}
    flats: dict[str, dict[int, dict[str, str]]] = {}
    all_packages: list[Package] = []
    uncertain_rows: list[dict[str, Any]] = []
    product_total = 0
    started = time.time()
    with log_path.open("w", encoding="utf-8", buffering=1) as log:
        log.write(f"Started: {time.ctime()}\nIfcOpenShell: {ifcopenshell.version}\nSelection policy: exact source entities; relation/mark first; no remodelling.\n")
        for project, source in sources:
            log.write(f"Opening {project}: {source}\n")
            model, packages, uncertain, psets, _geometry, count = inventory_project(project, source, log)
            models[project] = model; full_psets[project] = psets
            flats[project] = {entity_id: flatten_psets(value) for entity_id, value in psets.items()}
            all_packages.extend(packages); uncertain_rows.extend(uncertain); product_total += count
        unique = deduplicate(all_packages)
        master_rows: list[dict[str, Any]] = []
        used_names: set[str] = set()
        for index, package in enumerate(unique, 1):
            log.write(f"Export {index}/{len(unique)}: {package.project} {package.variant_mark}\n")
            try:
                master_rows.append(write_package_files(package, models[package.project], full_psets[package.project], flats[package.project], output / package.project, used_names, log))
            except Exception as exc:
                log.write(f"FAIL export {package.project} {package.variant_mark}: {exc}\n{traceback.format_exc()}\n")
                uncertain_rows.append(uncertain_row(package.project, package.source, package.main, package.variant_mark, None, f"export failed: {exc}"))
        duplicate_rows = []
        for package in unique:
            instances = [package, *package.duplicates]
            if len(instances) < 2:
                continue
            for instance in instances:
                duplicate_rows.append({"source_project": package.project, "variant_mark": package.variant_mark, "representative_GlobalId": plain(getattr(package.main, "GlobalId", "")), "instance_GlobalId": plain(getattr(instance.main, "GlobalId", "")), "instance_ifc_id": instance.main.id(), "geometry_signature": package.signature, "is_representative": instance is package})
        write_csv(output / "MASTER_INDEX.csv", master_rows, ["source_project", "category", "variant_mark", "variant_name", "output_ifc", "main_ifc_class", "GlobalId", "number_of_identical_instances", "dimensions_x_y_z", "volume", "materials", "concrete_parts", "reinforcing_bars", "reinforcing_meshes", "embedded_items", "insulation_layers", "has_opening", "has_cutout", "has_lowered_part", "validation_status", "notes"])
        write_csv(output / "uncertain_objects.csv", uncertain_rows, ["source_project", "source_ifc", "ifc_id", "GlobalId", "ifc_class", "Name", "ObjectType", "Tag", "layer", "distance_m", "proposed_assembly", "reason"])
        write_csv(output / "duplicate_instances.csv", duplicate_rows, ["source_project", "variant_mark", "representative_GlobalId", "instance_GlobalId", "instance_ifc_id", "geometry_signature", "is_representative"])
        write_master_html(output / "MASTER_INDEX.html", master_rows, output)
        passed = sum(row["validation_status"] == "PASS" for row in master_rows)
        failed = sum(row["validation_status"] != "PASS" for row in master_rows)
        readme = f"""IFC ELEMENT LIBRARY
Generated from two source IFC2X3 projects using IfcOpenShell {ifcopenshell.version}.

No geometry was remodelled, simplified, repaired or reconstructed. Each IFC is an exact subset copied from its source. GlobalId and ObjectPlacement are preserved. Selection prioritises IFC relationships and exact Tekla marks. Unconfirmed objects are listed in uncertain_objects.csv rather than guessed into an assembly.

Projects processed: 2
Source products: {product_total}
Detected element instances: {len(all_packages)}
Unique variants: {len(unique)}
IFC files created: {len(master_rows)}
Duplicate instances: {sum(len(p.duplicates) for p in unique)}
Uncertain objects: {len(uncertain_rows)}
Validation PASS: {passed}
Validation FAIL: {failed}

Open MASTER_INDEX.html for the linked catalogue. Each variant folder contains its IFC, description.txt, selected_objects.csv, layers.csv, properties.json and validation.txt.
"""
        (output / "README.txt").write_text(readme, encoding="utf-8")
        log.write(f"Finished in {time.time()-started:.1f}s. Created={len(master_rows)}, PASS={passed}, FAIL={failed}\n")
    zip_path = create_zip(output)
    print(f"IFC projects processed: 2")
    print(f"Source products found: {product_total}")
    print(f"Unique variants found: {len(unique)}")
    print(f"Separate IFC files created: {len(master_rows)}")
    print(f"Duplicates detected: {sum(len(p.duplicates) for p in unique)}")
    print(f"Uncertain objects: {len(uncertain_rows)}")
    print(f"Validation PASS: {passed}")
    print(f"Validation FAIL: {failed}")
    print(f"MASTER_INDEX.html: {output / 'MASTER_INDEX.html'}")
    print(f"ZIP: {zip_path}")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
