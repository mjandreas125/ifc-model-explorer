import * as THREE from "three";
import { OrbitControls } from "/static/three/OrbitControls.js";

/* ------------------------------------------------------------------ state */
const $ = (id) => document.getElementById(id);
const state = {
  meta: null,
  packages: [],
  positions: null,        // Float32Array — all vertices (IFC coords, m)
  indices: null,          // Uint32Array — all triangle indices (element-local)
  rec: null,              // parsed element records (typed arrays)
  names: new Map(),       // stepId -> element name
  pkgTotals: new Map(),   // pkg -> member rec count
  meshEntries: [],        // {mesh, part, pkg, recsAll, triStarts, triRecs}
  recToEntry: null,       // Int32Array rec -> meshEntries index
  isolatedMeshes: [],     // [{mesh, part}] built from the selection in isolate mode
  boxes: new Map(),
  // selection = (base ∪ radius catch) \ excluded \ hidden
  base: new Set(),
  excluded: new Set(),
  selected: new Set(),
  hidden: new Set(),
  resizes: new Map(),     // rec -> {axis, factor, pivot} — stretch/shrink (scale)
  cuts: new Map(),        // rec -> {axis, coord, keepBelow} — trim by a plane (no distortion)
  endOp: "cut",           // what Shift+drag of an end does: "cut" (trim) or "resize" (stretch)
  detached: new Set(),    // recs pulled out of the merged mesh into a per-part overlay
  radius: 0,
  isolated: false,
  xray: false,
  hoverRec: -1,
  polling: null,
  undo: [],
  redo: [],
};
let clipboard = null;   // { sourceKey, sourceName, parts:[{stepId,name,mark,cls,positions:BufferGeometry}] }
const resizeMeshes = new Map();   // rec -> THREE.Mesh (per-part overlay for resizing)
let projResize = null;            // active in-place resize drag

const INTERNAL_CLASSES = new Set([
  "IfcReinforcingBar", "IfcReinforcingMesh", "IfcTendon",
  "IfcDiscreteAccessory", "IfcMechanicalFastener", "IfcFastener",
]);
// what "select the shell → everything inside comes along" captures
const CAPTURE_CLASSES = new Set([
  ...INTERNAL_CLASSES, "IfcPlate", "IfcMember",
]);

/* ------------------------------------------------------------------ three */
const canvas = $("canvas");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef1f4);
const camera = new THREE.PerspectiveCamera(50, 1, 0.02, 4000);
camera.position.set(30, 25, 30);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.zoomToCursor = true;       // zoom toward the cursor — fast close-up inspection
controls.zoomSpeed = 1.35;
controls.minDistance = 0.05;
controls.maxDistance = 3000;

scene.add(new THREE.HemisphereLight(0xffffff, 0xb9c0c8, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.75);
sun.position.set(1, 2, 1.2);
scene.add(sun);
const fillLight = new THREE.DirectionalLight(0xdfe7f0, 0.35);
fillLight.position.set(-1.5, 1, -1);
scene.add(fillLight);

const root = new THREE.Group();          // project view; IFC Z-up -> three Y-up
root.rotation.x = -Math.PI / 2;
scene.add(root);
const resizeGroup = new THREE.Group();   // per-part overlays for in-place resizing
root.add(resizeGroup);
const editorRoot = new THREE.Group();    // editor tab
editorRoot.rotation.x = -Math.PI / 2;
editorRoot.visible = false;
scene.add(editorRoot);
let grid = null;

const matBase = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 6, specular: 0x1a1a1a });
const matGhost = new THREE.MeshPhongMaterial({
  vertexColors: true, flatShading: true, transparent: true,
  opacity: 0.14, depthWrite: false,
});
matGhost.opacity = parseInt($("xray").value, 10) / 100;
const matSelFill = new THREE.MeshBasicMaterial({
  color: 0x2e6fd0, transparent: true, opacity: 0.28, depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
const matSelLine = new THREE.LineBasicMaterial({ color: 0xffc400, depthTest: false, transparent: true, opacity: 0.95 });
const matHoverLine = new THREE.LineBasicMaterial({ color: 0xff9500, depthTest: false, transparent: true, opacity: 0.9 });
const matEditorSel = new THREE.MeshPhongMaterial({
  vertexColors: true, flatShading: true, shininess: 10,
  emissive: 0x2e6fd0, emissiveIntensity: 0.35,
});
const matResizeSel = new THREE.MeshPhongMaterial({   // a detached, selected, resizable part
  vertexColors: true, flatShading: true, shininess: 12,
  emissive: 0xffaa00, emissiveIntensity: 0.4,
});

let selFillMesh = null, selLineMesh = null, hoverLineMesh = null;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w || canvas.height !== h) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}
new ResizeObserver(resize).observe(canvas);

let fly = null;
function flyTo(targetPos, targetLook, duration = 0.7) {
  fly = { p0: camera.position.clone(), p1: targetPos.clone(), l0: controls.target.clone(), l1: targetLook.clone(), t: 0, duration };
}
const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  resize();
  const dt = Math.min(clock.getDelta(), 0.05);
  if (fly) {
    fly.t += dt / fly.duration;
    const k = fly.t >= 1 ? 1 : 1 - Math.pow(1 - fly.t, 3);
    camera.position.lerpVectors(fly.p0, fly.p1, k);
    controls.target.lerpVectors(fly.l0, fly.l1, k);
    if (fly.t >= 1) fly = null;
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

/* --------------------------------------------------------------- helpers */
function recBox(recIdx) {
  const b = state.rec.bounds;
  return new THREE.Box3(
    new THREE.Vector3(b[recIdx * 6], b[recIdx * 6 + 1], b[recIdx * 6 + 2]),
    new THREE.Vector3(b[recIdx * 6 + 3], b[recIdx * 6 + 4], b[recIdx * 6 + 5]),
  );
}
function selectionBox() {
  const box = new THREE.Box3();
  for (const r of state.selected) box.union(recBox(r));
  return box;
}
function toWorld(box) {
  root.updateMatrixWorld(true);
  return box.clone().applyMatrix4(root.matrixWorld);
}
function fitBox(box, pad = 1.9) {
  if (!box || box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length() || 1;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (!dir.lengthSq()) dir.set(1, 0.7, 1).normalize();
  flyTo(center.clone().add(dir.multiplyScalar(size * pad * 0.6 + 0.5)), center);
}
function fitAll() {
  const box = new THREE.Box3();
  const group = tab === "editor" ? editorRoot : root;
  box.expandByObject(group);
  if (!box.isEmpty()) fitBox(box, 1.4);
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function recClass(r) { return state.meta.classTable[state.rec.classIdx[r]] || ""; }
function recName(r) { return state.names.get(state.rec.ids[r]) || recClass(r).replace(/^Ifc/, ""); }
function recMark(r) { const p = state.rec.pkg[r]; return p >= 0 ? (state.packages[p]?.mark || "") : ""; }
// "shell" = the concrete/host body (not rebar, mesh, embed, plate, member).
// Clicking a shell grabs the whole element; clicking anything else = that one part.
function isShellCls(cls) { return !CAPTURE_CLASSES.has(cls); }
function isShell(r) { return isShellCls(recClass(r)); }

/* ------------------------------------------------------------- mesh build */
function disposeOverlay(obj) {
  if (obj) { obj.parent?.remove(obj); obj.geometry.dispose(); }
  return null;
}
function clearModel() {
  for (const entry of state.meshEntries) { root.remove(entry.mesh); entry.mesh.geometry.dispose(); }
  state.meshEntries = [];
  for (const m of state.isolatedMeshes) disposeOverlay(m.mesh);
  state.isolatedMeshes = [];
  selFillMesh = disposeOverlay(selFillMesh);
  selLineMesh = disposeOverlay(selLineMesh);
  hoverLineMesh = disposeOverlay(hoverLineMesh);
  for (const mesh of resizeMeshes.values()) { resizeGroup.remove(mesh); mesh.geometry.dispose(); }
  resizeMeshes.clear();
  state.boxes.clear();
  state.base.clear(); state.excluded.clear(); state.selected.clear(); state.hidden.clear();
  state.resizes.clear(); state.detached.clear();
  state.undo = []; state.redo = [];
  state.hoverRec = -1;
  edgeCache.clear();
  // NB: the editor is an independent workspace (its own geometry snapshots) — it
  // survives loading/switching projects and is only cleared explicitly.
  if (grid) { scene.remove(grid); grid = null; }
}

/* -------------------------------------------- in-place resize / cut */
function resizeMatrixIFC(rec) {
  const m = new THREE.Matrix4();
  const rz = state.resizes.get(rec);
  if (rz) {
    const s = [1, 1, 1]; s[rz.axis] = rz.factor;
    const t = [0, 0, 0]; t[rz.axis] = rz.pivot * (1 - rz.factor);
    m.set(s[0], 0, 0, t[0], 0, s[1], 0, t[1], 0, 0, s[2], t[2], 0, 0, 0, 1);
  }
  return m;
}
function isEdited(rec) { return state.resizes.has(rec) || state.cuts.has(rec); }
// Clip a part's triangles by an axis plane, keeping the pivot side (== the export).
function clipRecGeometry(rec, cut) {
  const { vOff, vCnt, iOff, iCnt, colors } = state.rec;
  const sv = vOff[rec], nv = vCnt[rec], si = iOff[rec], ni = iCnt[rec];
  const pos = state.positions, idxAll = state.indices;
  const axis = cut.axis, coord = cut.coord, keepBelow = cut.keepBelow;
  const sd = new Float32Array(nv);
  for (let k = 0; k < nv; k++) { const x = pos[(sv + k) * 3 + axis]; sd[k] = keepBelow ? (x - coord) : (coord - x); }
  const outPos = [], outCol = [], outIdx = [], map = new Map();
  const cr = colors[rec * 3], cg = colors[rec * 3 + 1], cb = colors[rec * 3 + 2];
  const vid = (p) => {
    const key = p[0].toFixed(5) + "," + p[1].toFixed(5) + "," + p[2].toFixed(5);
    let i = map.get(key);
    if (i === undefined) { i = outPos.length / 3; map.set(key, i); outPos.push(p[0], p[1], p[2]); outCol.push(cr, cg, cb); }
    return i;
  };
  for (let t = si; t < si + ni; t += 3) {
    const li = [idxAll[t] - sv, idxAll[t + 1] - sv, idxAll[t + 2] - sv];
    const P = (j) => [pos[(sv + li[j]) * 3], pos[(sv + li[j]) * 3 + 1], pos[(sv + li[j]) * 3 + 2]];
    const S = (j) => sd[li[j]];
    let poly;
    const keep = [0, 1, 2].filter((j) => S(j) <= 1e-7);
    if (keep.length === 3) poly = [P(0), P(1), P(2)];
    else if (keep.length === 0) continue;
    else {
      poly = [];
      for (let j = 0; j < 3; j++) {
        const A = P(j), B = P((j + 1) % 3), sa = S(j), sb = S((j + 1) % 3);
        if (sa <= 1e-7) poly.push(A);
        if ((sa < 0) !== (sb < 0) && Math.abs(sa - sb) > 1e-9) {
          const f = sa / (sa - sb);
          poly.push([A[0] + f * (B[0] - A[0]), A[1] + f * (B[1] - A[1]), A[2] + f * (B[2] - A[2])]);
        }
      }
      if (poly.length < 3) continue;
    }
    const ids = poly.map(vid);
    for (let k = 1; k < ids.length - 1; k++) outIdx.push(ids[0], ids[k], ids[k + 1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(outPos), 3));
  g.setAttribute("color", new THREE.BufferAttribute(new Uint8Array(outCol), 3, true));
  g.setIndex(outIdx);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}
// world plane [ax,ay,az,d] for the cut, keep n·x <= d (matches engine _apply_cuts)
function cutPlaneWorld(cut) {
  const n = [0, 0, 0]; n[cut.axis] = cut.keepBelow ? 1 : -1;
  const d = cut.keepBelow ? cut.coord : -cut.coord;
  return [n[0], n[1], n[2], d];
}
function ensureResizeMesh(rec) {
  if (resizeMeshes.has(rec)) return resizeMeshes.get(rec);
  state.detached.add(rec);
  const idx = state.recToEntry[rec];
  if (idx >= 0) rebuildEntry(state.meshEntries[idx]);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), matBase);
  mesh.matrixAutoUpdate = false;
  mesh.userData.rec = rec;
  resizeGroup.add(mesh);
  resizeMeshes.set(rec, mesh);
  updateResizeMesh(rec);
  return mesh;
}
function updateResizeMesh(rec) {
  const mesh = resizeMeshes.get(rec);
  if (!mesh) return;
  mesh.geometry.dispose();
  const cut = state.cuts.get(rec);
  if (cut) {
    mesh.geometry = clipRecGeometry(rec, cut);   // trimmed geometry, no scale
    mesh.matrix.identity();
  } else {
    mesh.geometry = geometryFromRecs([rec], true, false).geometry;
    mesh.matrix.copy(resizeMatrixIFC(rec));       // original geometry + scale
  }
  mesh.matrixWorldNeedsUpdate = true;
}
function clearResize(rec) {
  const mesh = resizeMeshes.get(rec);
  if (mesh) { resizeGroup.remove(mesh); mesh.geometry.dispose(); resizeMeshes.delete(rec); }
  state.resizes.delete(rec);
  state.cuts.delete(rec);
  state.detached.delete(rec);
  const idx = state.recToEntry[rec];
  if (idx >= 0) rebuildEntry(state.meshEntries[idx]);
}
// keep overlays in sync after undo / tab restore etc.
function syncResizeMeshes() {
  for (const rec of [...resizeMeshes.keys()]) {
    if (!isEdited(rec)) clearResize(rec);
  }
  for (const rec of new Set([...state.resizes.keys(), ...state.cuts.keys()])) { ensureResizeMesh(rec); updateResizeMesh(rec); }
}
// trim a part flush with the concrete edge it pokes out of
function cutAtConcrete(rec) {
  const pkg = state.rec.pkg[rec];
  if (pkg < 0) { toast("See osa ei kuulu ühegi elemendi külge"); return; }
  const box = new THREE.Box3();
  let found = false;
  for (let r = 0; r < state.rec.count; r++) {
    if (state.rec.pkg[r] === pkg && isShell(r) && !state.hidden.has(r)) { box.union(recBox(r)); found = true; }
  }
  if (!found) { toast("Betooni ei leitud"); return; }
  const bar = recBox(rec);
  const size = bar.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
  const overHi = bar.max.getComponent(axis) - box.max.getComponent(axis);
  const overLo = box.min.getComponent(axis) - bar.min.getComponent(axis);
  if (Math.max(overHi, overLo) < 0.003) { toast("Osa ei ulatu betoonist märgatavalt välja"); return; }
  pushHistory();
  ensureResizeMesh(rec);
  if (overHi >= overLo) state.cuts.set(rec, { axis, coord: box.max.getComponent(axis), keepBelow: true });
  else state.cuts.set(rec, { axis, coord: box.min.getComponent(axis), keepBelow: false });
  updateResizeMesh(rec);
  refreshSelection({ fit: false });
  toast("Lõigatud betooni servani");
}

function geometryFromRecs(recList, withColors = true, withTriMap = false) {
  const { vCnt, iCnt, vOff, iOff, colors } = state.rec;
  let vTotal = 0, iTotal = 0;
  for (const r of recList) { vTotal += vCnt[r]; iTotal += iCnt[r]; }
  const pos = new Float32Array(vTotal * 3);
  const col = withColors ? new Uint8Array(vTotal * 3) : null;
  const idx = new Uint32Array(iTotal);
  const triStarts = withTriMap ? new Uint32Array(recList.length) : null;
  const triRecs = withTriMap ? new Uint32Array(recList.length) : null;
  let v = 0, i = 0, n = 0;
  for (const r of recList) {
    pos.set(state.positions.subarray(vOff[r] * 3, (vOff[r] + vCnt[r]) * 3), v * 3);
    if (col) {
      const cr = colors[r * 3], cg = colors[r * 3 + 1], cb = colors[r * 3 + 2];
      for (let k = 0; k < vCnt[r]; k++) { col[(v + k) * 3] = cr; col[(v + k) * 3 + 1] = cg; col[(v + k) * 3 + 2] = cb; }
    }
    const src = state.indices;
    for (let k = 0; k < iCnt[r]; k++) idx[i + k] = src[iOff[r] + k] + v;
    if (withTriMap) { triStarts[n] = i / 3; triRecs[n] = r; n++; }
    v += vCnt[r]; i += iCnt[r];
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  if (col) geometry.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, triStarts, triRecs };
}

function rebuildEntry(entry) {
  const visible = entry.recsAll.filter((r) => !state.hidden.has(r) && !state.detached.has(r));
  entry.mesh.geometry.dispose();
  if (!visible.length) {
    entry.mesh.geometry = new THREE.BufferGeometry();
    entry.triStarts = new Uint32Array(0);
    entry.triRecs = new Uint32Array(0);
    entry.empty = true;
    return;
  }
  const { geometry, triStarts, triRecs } = geometryFromRecs(visible, true, true);
  entry.mesh.geometry = geometry;
  entry.triStarts = triStarts;
  entry.triRecs = triRecs;
  entry.empty = false;
}

function buildScene(buffer) {
  clearModel();
  const head = new Uint32Array(buffer, 0, 4);
  if (head[0] !== 0x4c424946) throw new Error("Vigane mesh.bin");
  const count = head[2];
  const REC = 36;
  const dv = new DataView(buffer, 16, count * REC);

  const rec = {
    count,
    ids: new Uint32Array(count), pkg: new Int32Array(count),
    vOff: new Uint32Array(count), vCnt: new Uint32Array(count),
    iOff: new Uint32Array(count), iCnt: new Uint32Array(count),
    classIdx: new Uint32Array(count), colors: new Uint8Array(count * 3),
    bounds: new Float32Array(count * 6),
    byId: new Map(),
  };
  for (let r = 0; r < count; r++) {
    const off = r * REC;
    rec.ids[r] = dv.getUint32(off, true);
    rec.pkg[r] = dv.getInt32(off + 4, true);
    rec.vOff[r] = dv.getUint32(off + 8, true);
    rec.vCnt[r] = dv.getUint32(off + 12, true);
    rec.iOff[r] = dv.getUint32(off + 16, true);
    rec.iCnt[r] = dv.getUint32(off + 20, true);
    rec.colors[r * 3] = dv.getUint8(off + 24);
    rec.colors[r * 3 + 1] = dv.getUint8(off + 25);
    rec.colors[r * 3 + 2] = dv.getUint8(off + 26);
    rec.classIdx[r] = dv.getUint32(off + 28, true);
    rec.byId.set(rec.ids[r], r);
  }
  state.rec = rec;
  let totalVerts = 0, totalIdx = 0;
  if (count) {
    totalVerts = rec.vOff[count - 1] + rec.vCnt[count - 1];
    totalIdx = rec.iOff[count - 1] + rec.iCnt[count - 1];
  }
  const posStart = 16 + count * REC;
  state.positions = new Float32Array(buffer, posStart, totalVerts * 3);
  state.indices = new Uint32Array(buffer, posStart + totalVerts * 12, totalIdx);

  for (let r = 0; r < count; r++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    const start = rec.vOff[r] * 3, end = (rec.vOff[r] + rec.vCnt[r]) * 3;
    const p = state.positions;
    for (let k = start; k < end; k += 3) {
      const x = p[k], y = p[k + 1], z = p[k + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    rec.bounds.set([x0, y0, z0, x1, y1, z1], r * 6);
  }

  state.names.clear();
  state.pkgTotals.clear();
  for (const info of state.packages) {
    for (const [id, , name] of info.members) state.names.set(id, name);
  }
  for (const [id, , name] of state.meta.context || []) state.names.set(id, name);

  const classTable = state.meta.classTable;
  const groups = new Map();
  const ctxRecs = [];
  for (let r = 0; r < count; r++) {
    const pkg = rec.pkg[r];
    if (pkg === -1) { ctxRecs.push(r); continue; }
    state.pkgTotals.set(pkg, (state.pkgTotals.get(pkg) || 0) + 1);
    let g = groups.get(pkg);
    if (!g) { g = { shell: [], inner: [] }; groups.set(pkg, g); }
    (INTERNAL_CLASSES.has(classTable[rec.classIdx[r]]) ? g.inner : g.shell).push(r);
  }

  state.recToEntry = new Int32Array(count).fill(-1);
  const addEntry = (recList, part, pkg) => {
    if (!recList.length) return null;
    const { geometry, triStarts, triRecs } = geometryFromRecs(recList, true, true);
    const mesh = new THREE.Mesh(geometry, matBase);
    root.add(mesh);
    const entry = { mesh, part, pkg, recsAll: recList, triStarts, triRecs, empty: false };
    const entryIdx = state.meshEntries.length;
    for (const r of recList) state.recToEntry[r] = entryIdx;
    state.meshEntries.push(entry);
    return entry;
  };

  for (const [pkg, g] of groups) {
    const box = new THREE.Box3();
    for (const part of ["shell", "inner"]) {
      const entry = addEntry(g[part], part, pkg);
      if (entry) box.union(entry.mesh.geometry.boundingBox);
    }
    state.boxes.set(pkg, box);
  }
  const CHUNK = 500000;
  let chunk = [], v = 0;
  for (const r of ctxRecs) {
    chunk.push(r); v += rec.vCnt[r];
    if (v > CHUNK) { addEntry(chunk, "context", -1); chunk = []; v = 0; }
  }
  if (chunk.length) addEntry(chunk, "context", -1);

  const whole = new THREE.Box3();
  for (const entry of state.meshEntries) whole.expandByObject(entry.mesh);
  if (!whole.isEmpty()) {
    const size = whole.getSize(new THREE.Vector3());
    const center = whole.getCenter(new THREE.Vector3());
    const extent = Math.ceil(Math.max(size.x, size.z) * 1.4 / 10) * 10;
    grid = new THREE.GridHelper(extent, extent / 2, 0xc3ccd6, 0xdde3ea);
    grid.position.set(center.x, whole.min.y - 0.02, center.z);
    scene.add(grid);
  }
  applyVisual();
  fitAll();
}

/* -------------------------------------------------- capture: shell → all */
function overlapFraction(recIdx, box) {
  const b = state.rec.bounds, o = recIdx * 6;
  const pad = 0.006; // thin bars have zero-thickness bboxes
  const lo0 = b[o] - pad, lo1 = b[o + 1] - pad, lo2 = b[o + 2] - pad;
  const hi0 = b[o + 3] + pad, hi1 = b[o + 4] + pad, hi2 = b[o + 5] + pad;
  const vol = (hi0 - lo0) * (hi1 - lo1) * (hi2 - lo2);
  if (vol <= 0) return 0;
  const ix = Math.max(0, Math.min(hi0, box.max.x) - Math.max(lo0, box.min.x));
  const iy = Math.max(0, Math.min(hi1, box.max.y) - Math.max(lo1, box.min.y));
  const iz = Math.max(0, Math.min(hi2, box.max.z) - Math.max(lo2, box.min.z));
  return (ix * iy * iz) / vol;
}

// The core rule the user expects: selecting a shell selects EVERYTHING inside it,
// regardless of how the import grouped it (rebar, meshes, embeds, joints).
function captureSet(recs) {
  const out = new Set(recs);
  if (!recs.length || !state.rec) return out;
  const shellRecs = recs.filter((r) => !INTERNAL_CLASSES.has(recClass(r)));
  const envelopeSrc = shellRecs.length ? shellRecs : recs;
  const box = new THREE.Box3();
  for (const r of envelopeSrc) box.union(recBox(r));
  box.expandByScalar(0.02);
  const bounds = state.rec.bounds;
  for (let r = 0; r < state.rec.count; r++) {
    if (out.has(r) || state.hidden.has(r)) continue;
    if (!CAPTURE_CLASSES.has(recClass(r))) continue;
    const o = r * 6;
    if (bounds[o] > box.max.x || bounds[o + 3] < box.min.x ||
        bounds[o + 1] > box.max.y || bounds[o + 4] < box.min.y ||
        bounds[o + 2] > box.max.z || bounds[o + 5] < box.min.z) continue;
    if (overlapFraction(r, box) >= 0.5) out.add(r);
  }
  return out;
}
function packageRecs(pkg) {
  const recs = [];
  for (let r = 0; r < state.rec.count; r++) {
    if (state.rec.pkg[r] === pkg && !state.hidden.has(r)) recs.push(r);
  }
  return recs;
}
function elementSet(rec) {
  // "element" = the whole package of the clicked part + everything inside its shell
  const pkg = state.rec.pkg[rec];
  const recs = pkg >= 0 ? packageRecs(pkg) : [rec];
  return captureSet(recs);
}

/* ----------------------------------------------------------- history */
function historySnapshot() {
  return {
    base: new Set(state.base), excluded: new Set(state.excluded),
    hidden: new Set(state.hidden), radius: state.radius,
    resizes: new Map([...state.resizes].map(([r, v]) => [r, { ...v }])),
    cuts: new Map([...state.cuts].map(([r, v]) => [r, { ...v }])),
  };
}
function pushHistory() {
  state.undo.push(historySnapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
}
function applySnapshot(s) {
  const hiddenChanged = !setsEqual(s.hidden, state.hidden);
  state.base = new Set(s.base);
  state.excluded = new Set(s.excluded);
  state.hidden = new Set(s.hidden);
  state.radius = s.radius;
  state.resizes = new Map([...(s.resizes || new Map())].map(([r, v]) => [r, { ...v }]));
  state.cuts = new Map([...(s.cuts || new Map())].map(([r, v]) => [r, { ...v }]));
  $("radius").value = Math.round(state.radius * 100);
  syncRadiusLabel();
  if (hiddenChanged) rebuildHidden();
  syncResizeMeshes();
  refreshSelection({ fit: false });
}
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(historySnapshot());
  applySnapshot(state.undo.pop());
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(historySnapshot());
  applySnapshot(state.redo.pop());
}

/* ----------------------------------------------------------- selection */
function boxDistance(recIdx, lo0, lo1, lo2, hi0, hi1, hi2) {
  const b = state.rec.bounds, o = recIdx * 6;
  const dx = Math.max(b[o] - hi0, lo0 - b[o + 3], 0);
  const dy = Math.max(b[o + 1] - hi1, lo1 - b[o + 4], 0);
  const dz = Math.max(b[o + 2] - hi2, lo2 - b[o + 5], 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeSelection() {
  const selected = new Set(state.base);
  if (state.radius > 0 && state.base.size) {
    const R = state.radius;
    const union = new THREE.Box3();
    for (const r of state.base) union.union(recBox(r));
    union.expandByScalar(R + 0.001);
    const baseBoxes = [...state.base].map((r) => {
      const o = r * 6, b = state.rec.bounds;
      return [b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5]];
    });
    const bounds = state.rec.bounds;
    for (let r = 0; r < state.rec.count; r++) {
      if (selected.has(r)) continue;
      const o = r * 6;
      if (bounds[o] > union.max.x || bounds[o + 3] < union.min.x ||
          bounds[o + 1] > union.max.y || bounds[o + 4] < union.min.y ||
          bounds[o + 2] > union.max.z || bounds[o + 5] < union.min.z) continue;
      for (const bb of baseBoxes) {
        if (boxDistance(r, bb[0], bb[1], bb[2], bb[3], bb[4], bb[5]) <= R) {
          selected.add(r);
          break;
        }
      }
    }
  }
  for (const r of state.excluded) selected.delete(r);
  for (const r of state.hidden) selected.delete(r);
  state.selected = selected;
}

function refreshSelection({ fit = false } = {}) {
  computeSelection();
  selFillMesh = disposeOverlay(selFillMesh);
  selLineMesh = disposeOverlay(selLineMesh);
  for (const m of state.isolatedMeshes) disposeOverlay(m.mesh);
  state.isolatedMeshes = [];
  if (state.selected.size) {
    // detached (resized) parts are drawn by their own overlay mesh — don't outline
    // them here with the original geometry, it would show the wrong (old) shape
    const recList = [...state.selected].filter((r) => !state.detached.has(r));
    let tris = 0;
    for (const r of recList) tris += state.rec.iCnt[r] / 3;
    if (!recList.length) { /* only resized parts selected — overlay shows highlight */ }
    else if (state.isolated) {
      // isolate keeps shell and internals apart so Röntgen works inside it too
      const shellRecs = recList.filter((r) => !INTERNAL_CLASSES.has(recClass(r)));
      const innerRecs = recList.filter((r) => INTERNAL_CLASSES.has(recClass(r)));
      for (const [list, part] of [[shellRecs, "shell"], [innerRecs, "inner"]]) {
        if (!list.length) continue;
        const { geometry } = geometryFromRecs(list, true, false);
        const mesh = new THREE.Mesh(geometry, matBase);
        root.add(mesh);
        state.isolatedMeshes.push({ mesh, part });
      }
    } else {
      const { geometry } = geometryFromRecs(recList, false, false);
      selFillMesh = new THREE.Mesh(geometry, matSelFill);
      selFillMesh.renderOrder = 4;
      selFillMesh.raycast = () => {};
      root.add(selFillMesh);
    }
    if (recList.length && tris < 400000) {
      const { geometry } = geometryFromRecs(recList, false, false);
      const edges = new THREE.EdgesGeometry(geometry, 28);
      geometry.dispose();
      selLineMesh = new THREE.LineSegments(edges, matSelLine);
      selLineMesh.renderOrder = 5;
      selLineMesh.raycast = () => {};
      root.add(selLineMesh);
    }
  }
  applyVisual();
  renderDetail();
  renderListSelection();
  if (fit && state.selected.size) fitBox(toWorld(selectionBox()));
}

function setBase(recs, { fit = true, history = true } = {}) {
  if (history) pushHistory();
  state.base = new Set(recs);
  state.excluded.clear();
  if (!state.base.size) {
    state.isolated = false;
    state.radius = 0; $("radius").value = 0; syncRadiusLabel();
  }
  refreshSelection({ fit });
}

function togglePart(r) {
  pushHistory();
  if (state.selected.has(r)) {
    if (state.base.has(r)) state.base.delete(r);
    else state.excluded.add(r);
  } else {
    state.base.add(r);
    state.excluded.delete(r);
  }
  refreshSelection({ fit: false });
}

function toggleElement(r) {
  pushHistory();
  const set = elementSet(r);
  const anySelected = [...set].some((x) => state.selected.has(x));
  if (anySelected) {
    for (const x of set) { state.base.delete(x); state.excluded.add(x); }
  } else {
    for (const x of set) { state.base.add(x); state.excluded.delete(x); }
  }
  refreshSelection({ fit: false });
}

function selectPackage(pkg, { fit = true } = {}) {
  setBase([...captureSet(packageRecs(pkg))], { fit });
}
function selectElementByRec(r, { fit = false } = {}) {
  setBase([...elementSet(r)], { fit });
}

// "layer" = every part of the same reinforcement layer inside this element:
// same package + same IFC class + same Name (e.g. all bars named "REBAR", or a
// whole mesh split into pieces) — so one Alt+click grabs the entire layer.
function layerSet(r) {
  const pkg = state.rec.pkg[r];
  const cls = recClass(r);
  const nm = state.names.get(state.rec.ids[r]) || "";
  const out = [];
  for (let x = 0; x < state.rec.count; x++) {
    if (state.hidden.has(x)) continue;
    if (state.rec.pkg[x] !== pkg) continue;
    if (recClass(x) !== cls) continue;
    if ((state.names.get(state.rec.ids[x]) || "") !== nm) continue;
    out.push(x);
  }
  return out.length ? out : [r];
}
function toggleLayer(r) {
  pushHistory();
  const layer = layerSet(r);
  const anySelected = layer.some((x) => state.selected.has(x));
  if (anySelected) {
    for (const x of layer) { state.base.delete(x); state.excluded.add(x); }
  } else {
    for (const x of layer) { state.base.add(x); state.excluded.delete(x); }
  }
  refreshSelection({ fit: false });
}

/* --------------------------------------------------------------- hide */
function rebuildHidden() {
  for (const entry of state.meshEntries) rebuildEntry(entry);
  edgeCache.clear();
  updateUnhideButton();
}
function hideRecs(recs) {
  if (!recs.length) return;
  pushHistory();
  const affected = new Set();
  for (const r of recs) {
    state.hidden.add(r);
    state.base.delete(r);
    state.excluded.delete(r);
    if (state.recToEntry[r] >= 0) affected.add(state.recToEntry[r]);
  }
  for (const idx of affected) rebuildEntry(state.meshEntries[idx]);
  updateUnhideButton();
  refreshSelection({ fit: false });
  setHover(-1);
}
function unhideAll() {
  if (!state.hidden.size) return;
  pushHistory();
  state.hidden.clear();
  rebuildHidden();
  refreshSelection({ fit: false });
}
function updateUnhideButton() {
  const btn = $("btn-unhide");
  btn.hidden = !state.hidden.size;
  btn.textContent = `Peidetud: ${state.hidden.size}`;
}

/* --------------------------------------------------------- visual states */
function applyVisual() {
  const hasSel = state.selected.size > 0;
  const showCtx = $("show-context").checked;
  for (const entry of state.meshEntries) {
    if (state.isolated && hasSel) { entry.mesh.visible = false; continue; }
    if (entry.empty) { entry.mesh.visible = false; continue; }
    if (entry.part === "context") {
      entry.mesh.visible = showCtx;
      entry.mesh.material = state.xray ? matGhost : matBase;
    } else if (entry.part === "shell") {
      entry.mesh.visible = true;
      entry.mesh.material = state.xray ? matGhost : matBase;
    } else {
      entry.mesh.visible = true;
      entry.mesh.material = matBase;
    }
    entry.mesh.renderOrder = entry.mesh.material === matGhost ? 3 : 0;
  }
  for (const m of state.isolatedMeshes) {
    m.mesh.visible = state.isolated && hasSel;
    m.mesh.material = (m.part === "shell" && state.xray) ? matGhost : matBase;
    m.mesh.renderOrder = m.mesh.material === matGhost ? 3 : 0;
  }
  for (const [rec, mesh] of resizeMeshes) {
    mesh.visible = !state.hidden.has(rec) && (!state.isolated || state.selected.has(rec));
    mesh.material = state.selected.has(rec) ? matResizeSel : matBase;
    mesh.renderOrder = 1;
  }
  $("btn-xray").classList.toggle("on", state.xray);
  $("btn-isolate").classList.toggle("on", state.isolated);
}

/* ------------------------------------------------------------- picking */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function resolveRec(entry, faceIndex) {
  const { triStarts, triRecs } = entry;
  let lo = 0, hi = triStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (triStarts[mid] <= faceIndex) lo = mid; else hi = mid - 1;
  }
  return triRecs[lo];
}

function setPointerFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
}

function pick(e) {
  setPointerFromEvent(e);
  if (state.isolated) {
    const meshes = state.isolatedMeshes.filter((m) => m.mesh.visible && !(state.xray && m.part === "shell")).map((m) => m.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    return null; // isolate: clicks stay neutral (selection is already the isolate set)
  }
  const targets = [];
  for (const entry of state.meshEntries) {
    if (!entry.mesh.visible || entry.empty) continue;
    if (state.xray && entry.mesh.material === matGhost) continue;
    targets.push(entry.mesh);
  }
  for (const mesh of resizeMeshes.values()) if (mesh.visible) targets.push(mesh);
  const hits = raycaster.intersectObjects(targets, false);
  const hit = hits[0];
  if (!hit) return null;
  if (hit.object.parent === resizeGroup) {
    return { entry: null, rec: hit.object.userData.id, point: hit.point };
  }
  const entry = state.meshEntries.find((en) => en.mesh === hit.object);
  if (!entry) return null;
  return { entry, rec: resolveRec(entry, hit.faceIndex), point: hit.point };
}

// Longest IFC axis of a part + which end the click grabbed (far end stays fixed)
function resizeGrab(rec, pointWorld) {
  const box = recBox(rec);
  const size = box.getSize(new THREE.Vector3());
  const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
  root.updateMatrixWorld(true);
  const ifcPoint = pointWorld.clone().applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());
  const lo = box.min.getComponent(axis), hi = box.max.getComponent(axis);
  const nearHi = Math.abs(ifcPoint.getComponent(axis) - hi) < Math.abs(ifcPoint.getComponent(axis) - lo);
  return { axis, pivot: nearHi ? lo : hi, origEnd: nearHi ? hi : lo, center: box.getCenter(new THREE.Vector3()) };
}
function rayCoordAlongAxis(grab) {
  const ray = raycaster.ray.clone().applyMatrix4(new THREE.Matrix4().copy(root.matrixWorld).invert());
  const pivotVec = grab.center.clone(); pivotVec.setComponent(grab.axis, grab.pivot);
  const ro = ray.origin, rd = ray.direction;
  const w0 = ro.clone().sub(pivotVec);
  const a = rd.dot(rd), b = rd.getComponent(grab.axis), dd = rd.dot(w0), e2 = w0.getComponent(grab.axis);
  const denom = a - b * b;
  const tc = Math.abs(denom) < 1e-9 ? e2 : (a * e2 - b * dd) / denom;
  return grab.pivot + tc;
}

// Capture phase: decide the gesture BEFORE OrbitControls sees the pointerdown, so
// a resize/move drag can disable the camera in time (else the camera "wins").
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  let grab = false;
  if (tab === "editor") {
    const hit = editor.moveMode ? editorPick(e) : null;
    grab = !!(hit && editor.selected.has(hit.object.userData.id));
  } else if (e.shiftKey && state.selected.size === 1 && !state.isolated) {
    const hit = pick(e);
    grab = !!(hit && hit.rec === [...state.selected][0]);
  }
  if (grab) controls.enabled = false;
}, true);

let downPos = null;
canvas.addEventListener("pointerdown", (e) => {
  hideCtxMenu();
  if (tab === "editor") { editorPointerDown(e); return; }
  if (e.button === 0 && e.shiftKey && state.selected.size === 1 && !state.isolated) {
    const rec = [...state.selected][0];
    const hit = pick(e);
    if (hit && hit.rec === rec) {           // start in-place length change
      pushHistory();
      ensureResizeMesh(rec);
      projResize = { rec, op: state.endOp, ...resizeGrab(rec, hit.point), moved: false };
      applyVisual();
      return;
    }
  }
  downPos = [e.clientX, e.clientY];
});
canvas.addEventListener("pointermove", (e) => {
  if (!projResize || tab === "editor") return;
  setPointerFromEvent(e);
  const grabbed = rayCoordAlongAxis(projResize);
  const rec = projResize.rec;
  if (projResize.op === "cut") {
    // trim: cut plane at the grabbed coordinate, keep the pivot (far) side
    const lo = Math.min(projResize.pivot, projResize.origEnd), hi = Math.max(projResize.pivot, projResize.origEnd);
    const coord = Math.max(lo, Math.min(hi, grabbed));
    state.cuts.set(rec, { axis: projResize.axis, coord, keepBelow: projResize.pivot < projResize.origEnd });
  } else {
    let factor = (grabbed - projResize.pivot) / (projResize.origEnd - projResize.pivot);
    factor = Math.max(0.05, Math.min(20, factor));
    state.resizes.set(rec, { axis: projResize.axis, factor, pivot: projResize.pivot });
  }
  updateResizeMesh(rec);
  projResize.moved = true;
  renderDetail();
});
canvas.addEventListener("pointerup", () => {
  if (projResize) {
    if (!projResize.moved) { state.undo.pop(); if (!isEdited(projResize.rec)) clearResize(projResize.rec); }
    projResize = null;
    refreshSelection({ fit: false });
  }
  if (!editor.drag) controls.enabled = true;   // never leave the camera stuck off
}, true);

canvas.addEventListener("pointerup", (e) => {
  if (tab === "editor") { editorPointerUp(e); return; }
  if (!downPos) return;
  const moved = Math.hypot(e.clientX - downPos[0], e.clientY - downPos[1]);
  downPos = null;
  if (moved > 5 || e.button !== 0 || state.isolated) return;
  const hit = pick(e);
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.altKey && ctrl) { if (hit) toggleLayer(hit.rec); return; }        // Ctrl+Alt = add/remove whole layer
  if (e.altKey) { if (hit) setBase(layerSet(hit.rec), { fit: false }); return; } // Alt = select whole layer
  if (ctrl) { if (hit) togglePart(hit.rec); return; }                    // Ctrl = add/remove single part
  if (!hit) { setBase([]); return; }
  if (isShell(hit.rec)) selectElementByRec(hit.rec); // shell → whole element + internals
  else setBase([hit.rec], { fit: false });           // rebar/embed → just this one part
});
canvas.addEventListener("dblclick", (e) => {
  if (tab === "editor") return;
  const hit = pick(e);
  if (hit) selectElementByRec(hit.rec);      // double click = whole element from anywhere
});

/* --------------------------------------------------------- context menu */
function hideCtxMenu() { $("ctxmenu").hidden = true; }
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const menu = $("ctxmenu");
  if (tab === "editor") {
    const hit = editorPick(e);
    const items = [];
    if (hit) {
      const id = hit.object.userData.id;
      const nm = editor.items.get(id)?.name || "osa";
      if (!editor.selected.has(id)) items.push([`Vali "${esc(nm)}"`, () => editorSelect([id])]);
      items.push(["Peida osa", () => editorHide([id])]);
      items.push(["Kustuta osa", () => { editorSelect([id]); editorDelete(); }]);
    }
    if (editor.selected.size) {
      items.push([`Peida valik (${editor.selected.size})`, () => editorHide([...editor.selected])]);
      items.push([`Kustuta valik (${editor.selected.size})`, editorDelete]);
    }
    if (editor.hidden.size) items.push([`Näita peidetud (${editor.hidden.size})`, editorUnhideAll]);
    if (!items.length) { hideCtxMenu(); return; }
    menu.innerHTML = items.map(([label], i) => `<div class="ctx-item" data-i="${i}">${label}</div>`).join("");
    [...menu.querySelectorAll(".ctx-item")].forEach((el, i) => el.addEventListener("click", () => { hideCtxMenu(); items[i][1](); }));
    menu.style.left = Math.min(e.clientX, window.innerWidth - 240) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12) + "px";
    menu.hidden = false;
    return;
  }
  const hit = state.isolated ? null : pick(e);
  const items = [];
  if (hit) {
    const r = hit.rec;
    items.push([`Vali element (${esc(recMark(r) || recName(r))})`, () => selectElementByRec(r)]);
    items.push([`Vali ainult osa "${esc(recName(r))}"`, () => setBase([r], { fit: false })]);
    items.push(["Peida osa", () => hideRecs([r])]);
    items.push(["Peida element", () => hideRecs([...elementSet(r)])]);
  }
  if (state.selected.size) {
    items.push([`Peida valik (${state.selected.size})`, () => hideRecs([...state.selected])]);
    items.push([`Kopeeri valik (Ctrl+C)`, copySelection]);
  }
  if (state.hidden.size) items.push([`Näita peidetud (${state.hidden.size})`, unhideAll]);
  if (!items.length) { hideCtxMenu(); return; }
  menu.innerHTML = items.map(([label], i) => `<div class="ctx-item" data-i="${i}">${label}</div>`).join("");
  [...menu.querySelectorAll(".ctx-item")].forEach((el, i) => {
    el.addEventListener("click", () => { hideCtxMenu(); items[i][1](); });
  });
  menu.style.left = Math.min(e.clientX, window.innerWidth - 240) + "px";
  menu.style.top = Math.min(e.clientY, window.innerHeight - items.length * 34 - 12) + "px";
  menu.hidden = false;
});
window.addEventListener("pointerdown", (e) => {
  if (!$("ctxmenu").hidden && !$("ctxmenu").contains(e.target)) hideCtxMenu();
});

/* hover: element edge outline + tooltip */
const edgeCache = new Map();
function edgesFor(r) {
  if (edgeCache.has(r)) return edgeCache.get(r);
  let edges;
  if (state.rec.iCnt[r] / 3 > 80000) {
    // huge part: cheap bbox outline instead of a multi-second EdgesGeometry stall
    const box = recBox(r);
    edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(
      box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z));
    edges.translate((box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2);
  } else {
    const { geometry } = geometryFromRecs([r], false, false);
    edges = new THREE.EdgesGeometry(geometry, 28);
    geometry.dispose();
  }
  if (edgeCache.size > 300) {
    const first = edgeCache.keys().next().value;
    edgeCache.get(first).dispose();
    edgeCache.delete(first);
  }
  edgeCache.set(r, edges);
  return edges;
}
function setHover(r) {
  if (r === state.hoverRec) return;
  state.hoverRec = r;
  if (hoverLineMesh) { root.remove(hoverLineMesh); hoverLineMesh = null; }
  if (r >= 0) {
    hoverLineMesh = new THREE.LineSegments(edgesFor(r), matHoverLine);
    hoverLineMesh.renderOrder = 6;
    hoverLineMesh.raycast = () => {};
    root.add(hoverLineMesh);
  }
}
let hoverTimer = 0;
canvas.addEventListener("pointermove", (e) => {
  if (tab === "editor") { editorPointerMove(e); return; }
  if (projResize) { $("tooltip").hidden = true; return; }  // resizing in place — no hover
  const now = performance.now();
  if (now - hoverTimer < 60) return;
  hoverTimer = now;
  const tooltip = $("tooltip");
  if (!state.rec) { tooltip.hidden = true; return; }
  const hit = downPos ? null : pick(e);
  if (hit) {
    const r = hit.rec;
    tooltip.textContent = [recName(r), recMark(r)].filter(Boolean).join(" — ");
    tooltip.style.left = e.clientX + "px";
    tooltip.style.top = (e.clientY - 52) + "px";
    tooltip.hidden = false;
    canvas.style.cursor = "pointer";
    setHover(r);
  } else {
    tooltip.hidden = true;
    canvas.style.cursor = "";
    setHover(-1);
  }
});
canvas.addEventListener("pointerleave", () => { $("tooltip").hidden = true; setHover(-1); });

/* ------------------------------------------------------------- keyboard */
function copySelection() {
  if (!state.selected.size) return;
  // snapshot geometry + labels so the editor is independent of the current project
  const parts = [...state.selected].map((r) => ({
    stepId: state.rec.ids[r], name: recName(r), mark: recMark(r), cls: recClass(r),
    positions: geometryFromRecs([r], true, false).geometry,   // BufferGeometry snapshot
  }));
  clipboard = { sourceKey: currentProjectKey, sourceName: openDocs.get(currentProjectKey)?.name || "", parts };
  toast(`Kopeeritud ${parts.length} osa — ava Redaktor ja vajuta Ctrl+V`);
}
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === "z") { e.preventDefault(); tab === "editor" ? editorUndo() : undo(); return; }
  if (ctrl && (e.key.toLowerCase() === "y" || (e.shiftKey && e.key.toLowerCase() === "z"))) { e.preventDefault(); if (tab !== "editor") redo(); return; }
  if (ctrl && e.key.toLowerCase() === "c") { if (tab !== "editor") { e.preventDefault(); copySelection(); } return; }
  if (ctrl && e.key.toLowerCase() === "v") { if (tab === "editor") { e.preventDefault(); editorPaste(); } else if (clipboard && clipboard.parts && clipboard.parts.length) { setTab("editor"); editorPaste(); } return; }
  if (e.key === "Delete" || e.key === "Backspace") {
    if (tab === "editor") editorDelete();
    else if (state.selected.size) hideRecs([...state.selected]);
    return;
  }
  if (e.key === "Escape") { tab === "editor" ? editorSelect([]) : setBase([]); return; }
  if (e.key === "f" || e.key === "F") { fitAll(); return; }
  if (e.key === "x" || e.key === "X") { toggleXray(); return; }
  if (e.key === "i" || e.key === "I") { toggleIsolate(); return; }
  if (e.key === "h" || e.key === "H") {
    if (tab === "editor") { if (editor.selected.size) editorHide([...editor.selected]); }
    else if (state.selected.size) hideRecs([...state.selected]);
    return;
  }
  if (e.key === "m" || e.key === "M") { if (tab === "editor") toggleMoveMode(); return; }
});

/* ------------------------------------------------------------- sidebar */
function counts(info) {
  const c = info.counts || {};
  const parts = [];
  if (c.concrete) parts.push(`<span class="c-bet">${c.concrete} betoon</span>`);
  if (c.bars) parts.push(`<span class="c-bar">${c.bars} varrast</span>`);
  if (c.meshes) parts.push(`<span class="c-mes">${c.meshes} võrku</span>`);
  if (c.embeds) parts.push(`<span class="c-emb">${c.embeds} tarvikut</span>`);
  if (c.other) parts.push(`<span>${c.other} muud</span>`);
  return parts.join("");
}
function categoryLabel(cat) {
  return (cat || "").replace(/^\d+_/, "").replaceAll("_", " ").toLowerCase();
}
function storeyLabel(storey) {
  return storey && storey !== "Undefined" ? storey : "";
}

function renderList() {
  const query = $("search").value.trim().toUpperCase();
  const cat = $("category-filter").value;
  const container = $("package-list");
  container.textContent = "";
  const byMark = new Map();
  let shown = 0;
  for (const info of state.packages) {
    if (cat && info.category !== cat) continue;
    if (query && !(`${info.mark} ${info.name} ${info.category}`.toUpperCase().includes(query))) continue;
    if (!byMark.has(info.mark)) byMark.set(info.mark, []);
    byMark.get(info.mark).push(info);
    shown++;
  }
  const frag = document.createDocumentFragment();
  for (const [mark, list] of [...byMark.entries()].sort((a, b) => a[0].localeCompare(b[0], "et", { numeric: true }))) {
    if (list.length > 1) {
      const head = document.createElement("div");
      head.className = "pkg-group-head";
      head.innerHTML = `<b>${esc(mark)}</b> × ${list.length}`;
      frag.appendChild(head);
    }
    for (const info of list) {
      const row = document.createElement("div");
      row.className = "pkg-row";
      row.dataset.pkg = info.i;
      const sub = [info.name, storeyLabel(info.storey)].filter(Boolean).join(" · ");
      row.innerHTML =
        `<div class="mark">${esc(list.length > 1 ? `${mark} · ${storeyLabel(info.storey) || "#" + info.i}` : mark)}` +
        `<span class="pkg-cat">${esc(categoryLabel(info.category))}</span></div>` +
        `<div class="sub">${esc(sub)}</div>` +
        `<div class="cnt">${counts(info)}</div>`;
      row.addEventListener("click", () => selectPackage(info.i));
      frag.appendChild(row);
    }
  }
  container.appendChild(frag);
  const file = state.meta?.file;
  $("list-summary").textContent =
    `${shown} elementi · ${file ? file.triangles.toLocaleString("et") + " kolmnurka" : ""}`;
  renderListSelection();
}

function renderListSelection() {
  const perPkg = new Map();
  for (const r of state.selected) {
    const pkg = state.rec.pkg[r];
    if (pkg >= 0) perPkg.set(pkg, (perPkg.get(pkg) || 0) + 1);
  }
  for (const row of document.querySelectorAll(".pkg-row")) {
    const pkg = Number(row.dataset.pkg);
    const on = perPkg.get(pkg) && perPkg.get(pkg) >= (state.pkgTotals.get(pkg) || Infinity);
    row.classList.toggle("sel", !!on);
  }
}

/* --------------------------------------------- nearby / touching suggest */
function computeNearby(maxDist = 0.10, cap = 24) {
  if (!state.selected.size) return [];
  const selArr = [...state.selected];
  const union = new THREE.Box3();
  for (const r of selArr) union.union(recBox(r));
  union.expandByScalar(maxDist + 0.001);
  const bounds = state.rec.bounds;
  const out = [];
  for (let r = 0; r < state.rec.count; r++) {
    if (state.selected.has(r) || state.hidden.has(r)) continue;
    const o = r * 6;
    if (bounds[o] > union.max.x || bounds[o + 3] < union.min.x ||
        bounds[o + 1] > union.max.y || bounds[o + 4] < union.min.y ||
        bounds[o + 2] > union.max.z || bounds[o + 5] < union.min.z) continue;
    let best = Infinity;
    for (const s of selArr) {
      const so = s * 6;
      const d = boxDistance(r, bounds[so], bounds[so + 1], bounds[so + 2], bounds[so + 3], bounds[so + 4], bounds[so + 5]);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best <= maxDist) out.push([r, best]);
  }
  out.sort((a, b) => a[1] - b[1]);
  return out.slice(0, cap);
}

function addRec(r) {
  pushHistory();
  state.base.add(r);
  state.excluded.delete(r);
  refreshSelection({ fit: false });
}

function renderNearby() {
  const el = $("detail-nearby");
  if (!state.selected.size) { el.innerHTML = ""; return; }
  const nearby = computeNearby();
  if (!nearby.length) { el.innerHTML = ""; return; }
  const touching = nearby.filter(([, d]) => d < 0.005);
  let html = `<div class="member-class">Puutub / läheduses — vajuta ＋ et lisada</div>`;
  if (touching.length > 1) {
    html += `<button class="btn btn-mini" id="btn-add-touching">＋ Lisa kõik puutuvad (${touching.length})</button>`;
  }
  for (const [r, d] of nearby) {
    const mark = recMark(r);
    const dist = d < 0.005 ? "puutub" : `${Math.round(d * 100)} cm`;
    html += `<div class="nearby-row" data-rec="${r}">` +
      `<span class="add">＋</span>` +
      `<span class="t">${esc(recName(r))}${mark ? ` <i>· ${esc(mark)}</i>` : ""}</span>` +
      `<span class="d">${dist}</span></div>`;
  }
  el.innerHTML = html;
  const addAll = $("btn-add-touching");
  if (addAll) addAll.addEventListener("click", () => {
    pushHistory();
    for (const [r] of touching) { state.base.add(r); state.excluded.delete(r); }
    refreshSelection({ fit: false });
  });
  for (const row of el.querySelectorAll(".nearby-row")) {
    const r = Number(row.dataset.rec);
    row.addEventListener("click", () => addRec(r));
    row.addEventListener("pointerenter", () => setHover(r));
    row.addEventListener("pointerleave", () => setHover(-1));
  }
}

/* --------------------------------------------------------- detail panel */
function dominantPackage() {
  const perPkg = new Map();
  for (const r of state.selected) {
    const pkg = state.rec.pkg[r];
    if (pkg >= 0) perPkg.set(pkg, (perPkg.get(pkg) || 0) + 1);
  }
  let best = -1, bestN = 0;
  for (const [pkg, n] of perPkg) if (n > bestN) { best = pkg; bestN = n; }
  return { pkg: best, distinct: perPkg.size };
}
function defaultExportName() {
  if (!state.selected.size) return "";
  const { pkg, distinct } = dominantPackage();
  if (pkg >= 0) {
    const info = state.packages[pkg];
    if (distinct === 1 || state.selected.size <= (state.pkgTotals.get(pkg) || 0) * 1.5) {
      return `${info.mark}__${info.name}`;
    }
    return `${info.mark}_jt_${state.selected.size}_osa`;
  }
  return `valik_${state.selected.size}_osa`;
}

function renderDetail() {
  const panel = $("detail");
  renderNearby();
  if (!state.selected.size) { panel.hidden = true; return; }
  panel.hidden = false;
  const recs = [...state.selected];
  const { pkg, distinct } = dominantPackage();
  let title, subtitle;
  if (state.selected.size === 1) {
    const r = recs[0];
    title = recName(r);
    subtitle = pkg >= 0 ? `kuulub: ${state.packages[pkg]?.mark}` : "muu geomeetria";
  } else if (pkg >= 0 && distinct === 1) {
    const info = state.packages[pkg];
    title = info.mark;
    subtitle = info.name;
  } else {
    title = `Valik — ${state.selected.size} osa`;
    subtitle = pkg >= 0 ? `põhielement: ${state.packages[pkg]?.mark}` : "";
  }
  $("detail-mark").textContent = title;
  $("detail-name").textContent = subtitle || "";

  const chips = [`${state.selected.size} osa`];
  if (distinct > 1) chips.push(`${distinct} elementi`);
  if (state.radius > 0) chips.push(`haare ${Math.round(state.radius * 100)} cm`);
  if (state.excluded.size) chips.push(`−${state.excluded.size} eemaldatud`);
  const resizedSel = recs.filter((r) => state.resizes.has(r));
  const cutSel = recs.filter((r) => state.cuts.has(r));
  if (resizedSel.length === 1) chips.push(`pikkus ${Math.round(state.resizes.get(resizedSel[0]).factor * 100)}%`);
  else if (resizedSel.length > 1) chips.push(`${resizedSel.length} muudetud pikkust`);
  if (cutSel.length) chips.push(`✂ ${cutSel.length} lõigatud`);
  $("detail-chips").innerHTML = chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("");

  // single-part hint: length/cut editing lives right here in the project view
  const single = state.selected.size === 1;
  $("resize-hint").hidden = !single;
  if (single) {
    const r = recs[0];
    const opBtns =
      `<div class="op-row"><span class="op-lbl">Otsa lohistus:</span>` +
      `<button class="op-btn ${state.endOp === "cut" ? "on" : ""}" data-op="cut">✂ Lõika</button>` +
      `<button class="op-btn ${state.endOp === "resize" ? "on" : ""}" data-op="resize">↔ Venita</button></div>`;
    let status = "";
    if (state.cuts.has(r)) status = `Lõigatud → <a href="#" id="reset-resize">taasta algne</a>.`;
    else if (state.resizes.has(r)) status = `Pikkus ${Math.round(state.resizes.get(r).factor * 100)}% → <a href="#" id="reset-resize">taasta algne</a>.`;
    const concreteBtn = state.rec.pkg[r] >= 0 && !isShell(r)
      ? `<button class="btn btn-mini" id="btn-cut-concrete">✂ Lõika betooni servani</button>` : "";
    $("resize-hint").innerHTML =
      opBtns +
      `<div class="op-note">${state.endOp === "cut"
        ? "<b>Shift+lohista otsa</b> — lõikab tüki ära (kuju ei moondu)."
        : "<b>Shift+lohista otsa</b> — venitab/lühendab (mastaap)."}</div>` +
      concreteBtn + (status ? `<div class="op-status">${status}</div>` : "");
    for (const b of $("resize-hint").querySelectorAll(".op-btn")) {
      b.addEventListener("click", () => { state.endOp = b.dataset.op; renderDetail(); });
    }
    const reset = $("reset-resize");
    if (reset) reset.addEventListener("click", (ev) => { ev.preventDefault(); pushHistory(); clearResize(r); refreshSelection({ fit: false }); });
    const cc = $("btn-cut-concrete");
    if (cc) cc.addEventListener("click", () => cutAtConcrete(r));
  }

  const box = selectionBox();
  const size = box.getSize(new THREE.Vector3());
  $("detail-dims").textContent = `Mõõdud: ${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`;

  const byClass = new Map();
  for (const r of recs) {
    const cls = recClass(r) || "?";
    const name = state.names.get(state.rec.ids[r]) || "(nimeta)";
    if (!byClass.has(cls)) byClass.set(cls, new Map());
    const names = byClass.get(cls);
    names.set(name, (names.get(name) || 0) + 1);
  }
  const order = ["IfcReinforcingBar", "IfcReinforcingMesh", "IfcDiscreteAccessory", "IfcMechanicalFastener", "IfcFastener", "IfcPlate", "IfcMember"];
  const sorted = [...byClass.entries()].sort((a, b) => {
    const ai = order.indexOf(a[0]), bi = order.indexOf(b[0]);
    return (ai === -1 ? -1 : ai) - (bi === -1 ? -1 : bi);
  });
  let html = "";
  if (state.selected.size === 1 && state.rec.pkg[recs[0]] >= 0) {
    const info = state.packages[state.rec.pkg[recs[0]]];
    html += `<button class="btn btn-mini" id="btn-whole-pkg">⬚ Vali kogu element ${esc(info.mark)}</button>`;
  }
  for (const [cls, names] of sorted) {
    html += `<div class="member-class">${esc(cls.replace(/^Ifc/, ""))} — ${[...names.values()].reduce((a, b) => a + b, 0)}</div>`;
    for (const [name, n] of [...names.entries()].sort((a, b) => b[1] - a[1])) {
      html += `<div class="member-row"><span class="t">${esc(name)}</span><span class="n">${n}×</span></div>`;
    }
  }
  $("detail-members").innerHTML = html;
  const wholeBtn = $("btn-whole-pkg");
  if (wholeBtn) wholeBtn.addEventListener("click", () => selectElementByRec(recs[0], { fit: false }));
  $("export-name").value = defaultExportName();
  $("extract-status").hidden = true;
  $("btn-extract").disabled = false;
}
$("btn-close-detail").addEventListener("click", () => setBase([]));
$("btn-remove").addEventListener("click", () => { if (state.selected.size) hideRecs([...state.selected]); });

/* ------------------------------------------------------------- toolbar */
function toggleIsolate() {
  if (tab === "editor") {
    if (!editor.selected.size) return;
    state.isolated = !state.isolated;
    editorApplyVisual();
    return;
  }
  if (!state.selected.size) return;
  state.isolated = !state.isolated;
  refreshSelection({ fit: false });
}
function toggleXray() {
  state.xray = !state.xray;
  tab === "editor" ? editorApplyVisual() : applyVisual();
}
function toggleMoveMode() {
  editor.moveMode = !editor.moveMode;
  editorApplyVisual();
  toast(editor.moveMode ? "Liigutamise režiim SEES — lohista valitud osi (Shift+otsast = pikkus)" : "Liigutamise režiim VÄLJAS — klõps valib, parem klõps peidab");
}
function syncRadiusLabel() {
  $("radius-value").textContent = state.radius > 0 ? `${Math.round(state.radius * 100)} cm` : "väljas";
}
$("btn-fit").addEventListener("click", fitAll);
$("btn-isolate").addEventListener("click", toggleIsolate);
$("btn-xray").addEventListener("click", toggleXray);
$("btn-move-mode").addEventListener("click", toggleMoveMode);
$("btn-unhide").addEventListener("click", () => (tab === "editor" ? editorUnhideAll() : unhideAll()));
$("xray").addEventListener("input", () => {
  matGhost.opacity = parseInt($("xray").value, 10) / 100;
});
$("radius").addEventListener("input", () => {
  state.radius = parseInt($("radius").value, 10) / 100;
  syncRadiusLabel();
  if (state.base.size) refreshSelection({ fit: false });
});
$("show-context").addEventListener("change", applyVisual);
$("search").addEventListener("input", renderList);
$("category-filter").addEventListener("change", renderList);

/* ------------------------------------------------------------- extract */
async function runExtract(elements, name, opts, statusEl, button) {
  opts = opts || {};
  button.disabled = true;
  statusEl.hidden = false;
  statusEl.className = "extract-status";
  statusEl.textContent = "Alustan eksporti …";
  try {
    const res = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ elements, name, key: opts.key || null, moves: opts.moves || null, deforms: opts.deforms || null, cuts: opts.cuts || null }),
    });
    if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
    while (true) {
      await sleep(600);
      const snap = await (await fetch("/api/extract/status")).json();
      if (snap.error) throw new Error(snap.error);
      if (snap.done) {
        const r = snap.result;
        statusEl.className = "extract-status ok";
        statusEl.innerHTML =
          `<b>${r.ok ? "✓ Valmis" : "⚠ Valmis (kontrolli!)"}</b> — ${r.products} toodet, ${r.sizeMB} MB` +
          `<div class="path">${esc(r.path)}</div>` +
          `<button class="btn btn-reveal">Näita kaustas</button>`;
        statusEl.querySelector(".btn-reveal").addEventListener("click", () =>
          fetch("/api/reveal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: r.path }) }));
        break;
      }
      statusEl.textContent = `${snap.message || snap.stage} (${Math.round(snap.pct)}%)`;
    }
  } catch (err) {
    statusEl.className = "extract-status err";
    statusEl.textContent = "Viga: " + err.message;
  } finally {
    button.disabled = false;
  }
}
$("btn-extract").addEventListener("click", () => {
  if (!state.selected.size) return;
  const elements = [...state.selected].map((r) => state.rec.ids[r]);
  const deforms = {}, cuts = {};
  for (const r of state.selected) {
    if (state.cuts.has(r)) cuts[String(state.rec.ids[r])] = cutPlaneWorld(state.cuts.get(r));
    else if (state.resizes.has(r)) deforms[String(state.rec.ids[r])] = matrixRows(resizeMatrixIFC(r));
  }
  runExtract(elements, $("export-name").value.trim() || defaultExportName(),
    { deforms: Object.keys(deforms).length ? deforms : null, cuts: Object.keys(cuts).length ? cuts : null },
    $("extract-status"), $("btn-extract"));
});

function matrixRows(m) {
  const e = m.elements;                     // three.js Matrix4 is column-major
  const rows = [];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) rows.push(e[i + 4 * j]);
  return rows;                              // 16 floats, row-major
}

/* ================================================================ EDITOR */
let tab = "project";
const editor = {
  items: new Map(),   // stepId -> {mesh, offset, resize, bbox, name, mark, cls}
  pool: new Map(),    // stepId -> {geom, name, mark, cls, bbox} snapshot (project-independent)
  selected: new Set(),
  hidden: new Set(),
  sourceKey: null,    // which project the parts were copied from (for export)
  moveMode: false,    // OFF = select/hide like the project view; ON = drag to move/resize
  undo: [],
  drag: null,
  downPos: null,
};

function setTab(next) {
  tab = next;
  document.body.dataset.tab = tab;
  activeView = tab === "editor" ? "editor" : currentProjectKey;
  root.visible = tab === "project";
  editorRoot.visible = tab === "editor";
  $("editor-panel").hidden = tab !== "editor";   // the whole editor panel (with the Save button)
  if (selFillMesh) selFillMesh.visible = tab === "project";
  if (selLineMesh) selLineMesh.visible = tab === "project";
  if (hoverLineMesh) hoverLineMesh.visible = tab === "project";
  for (const m of state.isolatedMeshes) m.mesh.visible = tab === "project" && state.isolated;
  $("tooltip").hidden = true;
  hideCtxMenu();
  for (const mesh of resizeMeshes.values()) mesh.visible = tab === "project" && mesh.visible;
  if (tab === "editor") { editorApplyVisual(); if (editor.items.size) fitAll(); }
  else { updateUnhideButton(); applyVisual(); }
  renderDocTabs();
}

// IFC-local matrix for an editor item: translate(offset) ∘ scaleAboutPivot(axis)
function itemMatrixIFC(it) {
  const m = new THREE.Matrix4();
  if (it.resize) {
    const { axis, factor, pivot } = it.resize;
    const s = [1, 1, 1]; s[axis] = factor;
    const t = [0, 0, 0]; t[axis] = pivot * (1 - factor);
    m.set(s[0], 0, 0, t[0], 0, s[1], 0, t[1], 0, 0, s[2], t[2], 0, 0, 0, 1);
  }
  const tm = new THREE.Matrix4().makeTranslation(it.offset.x, it.offset.y, it.offset.z);
  return tm.multiply(m);
}
function editorUpdateItem(it) {
  it.mesh.matrix.copy(itemMatrixIFC(it));
  it.mesh.matrixWorldNeedsUpdate = true;
}

function editorSnapshot() {
  return [...editor.items.entries()].map(([id, it]) => ({
    id, o: [it.offset.x, it.offset.y, it.offset.z], resize: it.resize ? { ...it.resize } : null,
  }));
}
function editorPushHistory() {
  editor.undo.push({ items: editorSnapshot(), selected: new Set(editor.selected), hidden: new Set(editor.hidden) });
  if (editor.undo.length > 60) editor.undo.shift();
}
function editorUndo() {
  const snap = editor.undo.pop();
  if (!snap) return;
  const keep = new Set(snap.items.map((s) => s.id));
  for (const [id, it] of [...editor.items]) {
    if (!keep.has(id)) { editorRoot.remove(it.mesh); editor.items.delete(id); }
  }
  for (const s of snap.items) {
    if (!editor.items.has(s.id)) editorAddItem(s.id);
    const it = editor.items.get(s.id);
    if (!it) continue;
    it.offset.set(s.o[0], s.o[1], s.o[2]);
    it.resize = s.resize ? { ...s.resize } : null;
    editorUpdateItem(it);
  }
  editor.selected = new Set([...snap.selected].filter((id) => editor.items.has(id)));
  editor.hidden = new Set([...(snap.hidden || [])].filter((id) => editor.items.has(id)));
  editorApplyVisual();
  renderEditorPanel();
}

// stepId-keyed; geometry + labels come from editor.pool (snapshotted at paste time),
// so the editor survives switching to a different project tab.
function editorAddItem(stepId) {
  const snap = editor.pool.get(stepId);
  if (!snap) return;
  const mesh = new THREE.Mesh(snap.geom, matBase);   // geometry shared from the pool
  mesh.userData.id = stepId;
  mesh.matrixAutoUpdate = false;
  editorRoot.add(mesh);
  const it = { mesh, offset: new THREE.Vector3(), resize: null, bbox: snap.bbox, name: snap.name, mark: snap.mark, cls: snap.cls };
  editor.items.set(stepId, it);
  editorUpdateItem(it);
}
function editorPaste() {
  if (!clipboard || !clipboard.parts || !clipboard.parts.length) { toast("Kopeeri kõigepealt valik projektist (Ctrl+C)"); return; }
  if (editor.items.size && editor.sourceKey && editor.sourceKey !== clipboard.sourceKey) {
    if (!confirm("Redaktoris on osad teisest failist. Tühjendan ja kleebin uued?")) return;
    editorClear(true);
  }
  editor.sourceKey = clipboard.sourceKey;
  editorPushHistory();
  let added = 0;
  for (const part of clipboard.parts) {
    if (!editor.pool.has(part.stepId)) {
      const geom = part.positions.clone();
      geom.computeBoundingBox();
      editor.pool.set(part.stepId, { geom, name: part.name, mark: part.mark, cls: part.cls, bbox: geom.boundingBox.clone() });
    }
    if (!editor.items.has(part.stepId)) { editorAddItem(part.stepId); added++; }
  }
  editor.selected = new Set(clipboard.parts.map((p) => p.stepId).filter((id) => editor.items.has(id)));
  editorApplyVisual();
  renderEditorPanel();
  if (tab === "editor") fitAll();
  toast(added ? `Kleebitud ${added} osa` : "Need osad on juba redaktoris");
}
function editorDelete() {
  if (!editor.selected.size) return;
  editorPushHistory();
  for (const id of editor.selected) {
    const it = editor.items.get(id);
    if (it) { editorRoot.remove(it.mesh); editor.items.delete(id); }
  }
  editor.selected.clear();
  editorApplyVisual();
  renderEditorPanel();
}
function editorClear(silent = false) {
  for (const [, it] of editor.items) editorRoot.remove(it.mesh);
  for (const snap of editor.pool.values()) snap.geom.dispose();
  editor.items.clear();
  editor.pool.clear();
  editor.selected.clear();
  editor.hidden.clear();
  editor.sourceKey = null;
  editor.undo = [];
  if (!silent) { editorApplyVisual(); renderEditorPanel(); }
}
function editorSelect(ids) {
  editor.selected = new Set(ids);
  editorApplyVisual();
  renderEditorPanel();
}
function editorApplyVisual() {
  for (const [id, it] of editor.items) {
    it.mesh.visible = !editor.hidden.has(id) && (!state.isolated || editor.selected.has(id));
    if (editor.selected.has(id)) it.mesh.material = matEditorSel;
    else if (state.xray && isShellCls(it.cls)) it.mesh.material = matGhost;   // x-ray the concrete
    else it.mesh.material = matBase;
    it.mesh.renderOrder = it.mesh.material === matGhost ? 3 : 0;
  }
  const ec = $("editor-count");
  if (ec) ec.textContent = editor.items.size ? `(${editor.items.size})` : "";
  const unhide = $("btn-unhide");
  if (tab === "editor") { unhide.hidden = !editor.hidden.size; unhide.textContent = `Peidetud: ${editor.hidden.size}`; }
  $("btn-move-mode").classList.toggle("on", editor.moveMode);
  $("btn-xray").classList.toggle("on", state.xray);
  $("btn-isolate").classList.toggle("on", state.isolated);
}
function editorHide(recs) {
  const list = recs.filter((r) => editor.items.has(r));
  if (!list.length) return;
  editorPushHistory();
  for (const r of list) { editor.hidden.add(r); editor.selected.delete(r); }
  editorApplyVisual();
  renderEditorPanel();
}
function editorUnhideAll() {
  if (!editor.hidden.size) return;
  editorPushHistory();
  editor.hidden.clear();
  editorApplyVisual();
  renderEditorPanel();
}

function editorPick(e) {
  setPointerFromEvent(e);
  const targets = [];
  for (const it of editor.items.values()) {
    if (it.mesh.visible && it.mesh.material !== matGhost) targets.push(it.mesh); // pick through x-ray ghosts
  }
  const hits = raycaster.intersectObjects(targets, false);
  return hits[0] || null;
}
const IFC_INV = new THREE.Matrix4();  // inverse of editorRoot world matrix (world → IFC)
function editorRayIFC() {
  editorRoot.updateMatrixWorld(true);
  IFC_INV.copy(editorRoot.matrixWorld).invert();
  return raycaster.ray.clone().applyMatrix4(IFC_INV);
}
function editorPointerDown(e) {
  if (e.button !== 0) return;
  const hit = editorPick(e);
  const canDrag = editor.moveMode && hit && editor.selected.has(hit.object.userData.id);
  if (canDrag) {
    editorPushHistory();
    if (e.shiftKey) {
      // RESIZE: stretch/shrink the grabbed part along its longest axis about the far end
      const it = editor.items.get(hit.object.userData.id);
      const size = it.bbox.getSize(new THREE.Vector3());
      const axis = size.x >= size.y && size.x >= size.z ? 0 : (size.y >= size.z ? 1 : 2);
      setPointerFromEvent(e);
      const hitIfc = hit.point.clone().applyMatrix4(IFC_INV.copy(editorRoot.matrixWorld).invert());
      const lo = it.bbox.min.getComponent(axis), hi = it.bbox.max.getComponent(axis);
      const nearHi = Math.abs(hitIfc.getComponent(axis) - hi) < Math.abs(hitIfc.getComponent(axis) - lo);
      const pivot = nearHi ? lo : hi;      // fixed (far) end
      const origEnd = nearHi ? hi : lo;    // grabbed (moving) end
      editor.drag = { mode: "resize", item: it, axis, pivot, origEnd, center: it.bbox.getCenter(new THREE.Vector3()), moved: false };
    } else {
      // MOVE: drag on ground plane (XZ); Alt = vertical (Y)
      const vertical = e.altKey;
      const planeNormal = vertical
        ? camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize().negate()
        : new THREE.Vector3(0, 1, 0);
      if (vertical && planeNormal.lengthSq() < 0.01) planeNormal.set(0, 0, 1);
      editor.drag = {
        mode: "move",
        plane: new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, hit.point),
        start: hit.point.clone(), vertical, moved: false,
      };
    }
    controls.enabled = false;
  } else {
    editor.downPos = [e.clientX, e.clientY, e.ctrlKey || e.metaKey];
  }
}
function editorPointerMove(e) {
  if (editor.drag && editor.drag.mode === "resize") {
    setPointerFromEvent(e);
    const ray = editorRayIFC();
    const d = editor.drag;
    const pivotVec = d.center.clone(); pivotVec.setComponent(d.axis, d.pivot);
    // closest point of the IFC-space ray to the axis line through pivotVec
    const ro = ray.origin, rd = ray.direction;
    const w0 = ro.clone().sub(pivotVec);
    const a = rd.dot(rd), b = rd.getComponent(d.axis), dd = rd.dot(w0), e2 = w0.getComponent(d.axis);
    const denom = a - b * b;
    const tc = Math.abs(denom) < 1e-9 ? e2 : (a * e2 - b * dd) / denom;
    const grabbed = d.pivot + tc;
    let factor = (grabbed - d.pivot) / (d.origEnd - d.pivot);
    factor = Math.max(0.05, Math.min(20, factor));
    d.item.resize = { axis: d.axis, factor, pivot: d.pivot };
    editorUpdateItem(d.item);
    d.moved = true;
    return;
  }
  if (editor.drag) {
    setPointerFromEvent(e);
    const point = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(editor.drag.plane, point)) return;
    const deltaWorld = point.clone().sub(editor.drag.start);
    if (editor.drag.vertical) { deltaWorld.x = 0; deltaWorld.z = 0; }
    const deltaIfc = new THREE.Vector3(deltaWorld.x, -deltaWorld.z, deltaWorld.y);
    for (const r of editor.selected) {
      const it = editor.items.get(r);
      it.mesh.matrix.copy(itemMatrixIFC(it)).premultiply(new THREE.Matrix4().makeTranslation(deltaIfc.x, deltaIfc.y, deltaIfc.z));
      it.mesh.matrixWorldNeedsUpdate = true;
    }
    editor.drag.deltaIfc = deltaIfc;
    editor.drag.moved = true;
    return;
  }
  const hit = editorPick(e);
  const onSel = hit && editor.selected.has(hit.object.userData.id);
  canvas.style.cursor = hit ? (editor.moveMode && onSel ? "move" : "pointer") : "";
}
function editorPointerUp(e) {
  if (editor.drag) {
    if (editor.drag.mode === "resize") {
      if (!editor.drag.moved) editor.undo.pop();
    } else if (editor.drag.moved && editor.drag.deltaIfc) {
      for (const r of editor.selected) {
        const it = editor.items.get(r);
        it.offset.add(editor.drag.deltaIfc);
        editorUpdateItem(it);
      }
    } else {
      editor.undo.pop();
    }
    editor.drag = null;
    controls.enabled = true;
    renderEditorPanel();
    return;
  }
  if (!editor.downPos) return;
  const [x0, y0, ctrl] = editor.downPos;
  editor.downPos = null;
  if (Math.hypot(e.clientX - x0, e.clientY - y0) > 5 || e.button !== 0) return;
  const hit = editorPick(e);
  if (!hit) { if (!ctrl) editorSelect([]); return; }
  const r = hit.object.userData.id;
  if (ctrl) {
    const next = new Set(editor.selected);
    next.has(r) ? next.delete(r) : next.add(r);
    editorSelect([...next]);
  } else {
    editorSelect([r]);
  }
}

function renderEditorPanel() {
  const listEl = $("editor-list");
  if (!editor.items.size) {
    listEl.innerHTML = `<div class="hint" style="padding:10px 2px">Redaktor on tühi.<br>1. Vali projektis element või osad<br>2. Vajuta Ctrl+C<br>3. Siin Ctrl+V — kleebi<br>4. Lohista osi, kustuta liigsed (Del)<br>5. Salvesta uus IFC</div>`;
  } else {
    const rows = [];
    for (const [id, it] of editor.items) {
      let tag = "";
      if (editor.hidden.has(id)) tag = ` <i>· peidetud</i>`;
      else if (it.resize) tag = ` <i>· pikkus ${Math.round(it.resize.factor * 100)}%</i>`;
      else if (it.offset.lengthSq() > 1e-9) tag = ` <i>· nihutatud</i>`;
      const cls = `member-row editor-row ${editor.selected.has(id) ? "sel" : ""} ${editor.hidden.has(id) ? "hidden-row" : ""}`;
      rows.push(`<div class="${cls}" data-id="${id}">` +
        `<span class="t">${esc(it.name)}${tag}</span><span class="n">${esc(it.mark)}</span></div>`);
    }
    listEl.innerHTML = rows.join("");
    for (const row of listEl.querySelectorAll(".editor-row")) {
      const id = Number(row.dataset.id);
      row.addEventListener("click", (e) => {
        if (e.ctrlKey || e.metaKey) {
          const next = new Set(editor.selected);
          next.has(id) ? next.delete(id) : next.add(id);
          editorSelect([...next]);
        } else editorSelect([id]);
      });
    }
  }
  if (!$("editor-name").value && editor.items.size) $("editor-name").value = defaultEditorName();
  $("btn-del").disabled = !editor.selected.size;
  $("btn-editor-extract").disabled = !editor.items.size;
}
function defaultEditorName() {
  const first = editor.items.values().next().value;
  return first && first.mark ? `${first.mark}_uus` : "uus_projekt";
}
$("btn-paste").addEventListener("click", editorPaste);
$("btn-del").addEventListener("click", editorDelete);
$("btn-clear-editor").addEventListener("click", () => { editorPushHistory(); editorClear(); });
$("btn-editor-extract").addEventListener("click", () => {
  const kept = [...editor.items.keys()].filter((id) => !editor.hidden.has(id));  // hidden = not exported
  if (!kept.length) { toast("Redaktoris pole nähtavaid osi"); return; }
  const moves = {}, deforms = {};
  for (const stepId of kept) {
    const it = editor.items.get(stepId);
    if (it.resize) deforms[String(stepId)] = matrixRows(itemMatrixIFC(it));       // baked geometry
    else if (it.offset.lengthSq() > 1e-9) moves[String(stepId)] = [it.offset.x, it.offset.y, it.offset.z];
  }
  runExtract(kept, $("editor-name").value.trim() || defaultEditorName(),
    { moves: Object.keys(moves).length ? moves : null, deforms: Object.keys(deforms).length ? deforms : null, key: editor.sourceKey },
    $("editor-extract-status"), $("btn-editor-extract"));
});

/* ============================================================ documents */
const openDocs = new Map();     // key -> {key, name, path, sizeMB, packages, view}
let currentProjectKey = null;   // the loaded project (server "current")
let activeView = null;          // a project key, or "editor"

function shortName(name) {
  const base = String(name).replace(/\.ifc$/i, "");
  return base.length > 22 ? base.slice(0, 20) + "…" : base;
}
function ensureDoc(key, file, path) {
  if (!openDocs.has(key)) {
    openDocs.set(key, { key, name: file?.name || "IFC", path: path || file?.path || "", sizeMB: file?.sizeMB, packages: file?.packages, view: null });
  }
}
function renderDocTabs() {
  const el = $("doctabs");
  el.innerHTML = "";
  for (const [key, doc] of openDocs) {
    const t = document.createElement("div");
    t.className = "doctab" + (activeView === key && tab === "project" ? " on" : "");
    t.innerHTML = `<span class="doctab__ico">📄</span><span class="doctab__name" title="${esc(doc.name)}">${esc(shortName(doc.name))}</span><span class="doctab__x" title="Sulge vahekaart">×</span>`;
    t.querySelector(".doctab__name").addEventListener("click", () => activateProject(key));
    t.querySelector(".doctab__ico").addEventListener("click", () => activateProject(key));
    t.querySelector(".doctab__x").addEventListener("click", (e) => { e.stopPropagation(); closeProject(key); });
    el.appendChild(t);
  }
  const ed = document.createElement("div");
  ed.className = "doctab doctab--editor" + (tab === "editor" ? " on" : "");
  ed.innerHTML = `<span class="doctab__ico">✂️</span><span class="doctab__name">Redaktor</span><span id="editor-count">${editor.items.size ? "(" + editor.items.size + ")" : ""}</span>`;
  ed.addEventListener("click", () => setTab("editor"));
  el.appendChild(ed);
}

function saveCurrentView() {
  if (!currentProjectKey || !state.rec) return;
  const doc = openDocs.get(currentProjectKey);
  if (!doc) return;
  doc.view = {
    base: [...state.base], excluded: [...state.excluded], hidden: [...state.hidden],
    resizes: [...state.resizes].map(([r, v]) => [r, { ...v }]),
    cuts: [...state.cuts].map(([r, v]) => [r, { ...v }]),
    camPos: camera.position.toArray(), camTarget: controls.target.toArray(),
  };
}
function restoreView(view) {
  if (!view) return;
  state.hidden = new Set(view.hidden);
  rebuildHidden();
  state.resizes = new Map((view.resizes || []).map(([r, v]) => [r, { ...v }]));
  state.cuts = new Map((view.cuts || []).map(([r, v]) => [r, { ...v }]));
  syncResizeMeshes();
  state.base = new Set(view.base);
  state.excluded = new Set(view.excluded);
  refreshSelection({ fit: false });
  if (view.camPos) { fly = null; camera.position.fromArray(view.camPos); controls.target.fromArray(view.camTarget); }
}

function activateProject(key) {
  if (key === currentProjectKey && tab === "project") return;
  if (key === currentProjectKey) { setTab("project"); return; }  // same model, was in editor
  switchToProject(key);
}
async function switchToProject(key) {
  saveCurrentView();
  const res = await fetch("/api/switch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
  if (!res.ok) { toast("Ei saa vahekaarti vahetada"); return; }
  currentProjectKey = key;
  await loadModelData(key);
  restoreView(openDocs.get(key)?.view);
  renderDocTabs();
}
async function closeProject(key) {
  await fetch("/api/close", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) }).catch(() => {});
  openDocs.delete(key);
  if (currentProjectKey === key) {
    currentProjectKey = null;
    const next = [...openDocs.keys()][0];
    if (next) { await switchToProject(next); }
    else { clearModel(); state.rec = null; $("welcome").hidden = false; $("toolbar").hidden = true; $("file-chip").hidden = true; setTab("project"); }
  }
  renderDocTabs();
}

/* --------------------------------------------------------- file loading */
async function openIfc(path) {
  closeModal();
  saveCurrentView();
  $("welcome").hidden = true;
  const res = await fetch("/api/open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) { toast((await res.json()).detail || "Viga faili avamisel"); return; }
  const data = await res.json();
  rememberRecent(path);
  if (data.started === false && data.key) {   // already open → just switch
    ensureDoc(data.key, data.file, path);
    currentProjectKey = data.key;
    await loadModelData(data.key);
    restoreView(openDocs.get(data.key)?.view);
    renderDocTabs();
    return;
  }
  $("load-progress").hidden = false;
  pollLoad(data.key, path);
}

async function pollLoad(key, path) {
  clearTimeout(state.polling);
  const snap = await (await fetch("/api/status")).json();
  $("load-progress-fill").style.width = (snap.pct || 0) + "%";
  $("load-progress-text").textContent = snap.message || snap.stage || "";
  if (snap.error) {
    toast("Viga: " + snap.error, 9000);
    $("load-progress").hidden = true;
    return;
  }
  if (snap.done) {
    $("load-progress-text").textContent = "Laen 3D andmeid brauserisse …";
    const resultKey = (snap.result && snap.result.key) || key;
    currentProjectKey = resultKey;
    ensureDoc(resultKey, snap.result && snap.result.file, path);
    await loadModelData(resultKey);
    renderDocTabs();
    $("load-progress").hidden = true;
    return;
  }
  state.polling = setTimeout(() => pollLoad(key, path), 700);
}

async function loadModelData(key) {
  // Always fetch a specific model by key so state.rec and currentProjectKey can
  // never desync (which would tag copied parts with the wrong source file).
  if (!key) key = (await (await fetch("/api/tabs")).json()).current;
  currentProjectKey = key;
  const q = key ? "?key=" + encodeURIComponent(key) : "";
  const [meta, buffer] = await Promise.all([
    (await fetch("/api/meta" + q)).json(),
    (await fetch("/api/mesh.bin" + q)).arrayBuffer(),
  ]);
  state.meta = meta;
  state.packages = meta.packages;
  $("welcome").hidden = true;
  $("toolbar").hidden = false;
  $("file-chip").hidden = false;
  $("file-chip").textContent =
    `${meta.file.name} — ${meta.file.sizeMB} MB · ${meta.file.schema} · ${meta.packages.length} elementi`;
  if (currentProjectKey) ensureDoc(currentProjectKey, meta.file);
  const cats = [...new Set(meta.packages.map((p) => p.category))].sort();
  $("category-filter").innerHTML =
    `<option value="">Kõik kategooriad</option>` +
    cats.map((c) => `<option value="${esc(c)}">${esc(categoryLabel(c))}</option>`).join("");
  setTab("project");        // switch to project BEFORE building — else fitAll frames the empty editor
  buildScene(buffer);       // builds root meshes and fits the camera on them
  renderList();
  renderEditorPanel();
  fitAll();                 // frame the new model even if a file was already open
}

function toast(message, ms = 4000) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.hidden = true; }, ms);
}

/* ------------------------------------------------------------- recents */
function recents() {
  try { return JSON.parse(localStorage.getItem("ifcExplorer/recent") || "[]"); } catch { return []; }
}
function rememberRecent(path) {
  const list = [path, ...recents().filter((p) => p !== path)].slice(0, 6);
  localStorage.setItem("ifcExplorer/recent", JSON.stringify(list));
  renderRecents();
}
function renderRecents() {
  const list = recents();
  const el = $("recent-files");
  el.innerHTML = list.length ? `<div class="recent-label">Viimased</div>` : "";
  for (const path of list) {
    const row = document.createElement("div");
    row.className = "recent-item";
    row.textContent = path;
    row.title = path;
    row.addEventListener("click", () => openIfc(path));
    el.appendChild(row);
  }
}

/* ------------------------------------------------------------- browser */
let browseDir = "";
async function browse(dir) {
  const res = await fetch("/api/browse?dir=" + encodeURIComponent(dir || ""));
  if (!res.ok) { toast((await res.json()).detail || "Viga"); return; }
  const data = await res.json();
  browseDir = data.dir;
  $("path-input").value = data.dir || "Arvuti";
  const el = $("browser");
  el.textContent = "";
  for (const d of data.dirs) {
    const row = document.createElement("div");
    row.className = "browse-row";
    row.innerHTML = `<span class="ico">📁</span><span class="nm">${esc(d.split("\\").filter(Boolean).pop() || d)}</span>`;
    row.addEventListener("click", () => browse(d));
    el.appendChild(row);
  }
  for (const f of data.files) {
    const row = document.createElement("div");
    row.className = "browse-row ifc";
    row.innerHTML = `<span class="ico">🧊</span><span class="nm">${esc(f.name)}</span><span class="sz">${f.sizeMB} MB</span>`;
    row.addEventListener("click", () => openIfc(f.path));
    el.appendChild(row);
  }
  if (!data.dirs.length && !data.files.length) {
    el.innerHTML = `<div style="padding:20px;color:#8b96a2">Tühi kaust</div>`;
  }
  window._parentDir = data.parent;
}
function openModal() { $("modal").hidden = false; browse(browseDir); }
function closeModal() { $("modal").hidden = true; }
$("btn-open").addEventListener("click", openModal);
$("btn-open2").addEventListener("click", openModal);
$("btn-close-modal").addEventListener("click", closeModal);
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) closeModal(); });
$("btn-up").addEventListener("click", () => browse(window._parentDir || "::drives"));
$("btn-go").addEventListener("click", () => {
  const value = $("path-input").value.trim();
  if (value.toLowerCase().endsWith(".ifc")) openIfc(value);
  else browse(value);
});
$("path-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("btn-go").click(); });

/* debug/support hook — inspect state from the console, no behaviour change */
function screenOf(rec) {
  root.updateMatrixWorld(true);
  const c = recBox(rec).getCenter(new THREE.Vector3()).applyMatrix4(root.matrixWorld).project(camera);
  const rect = canvas.getBoundingClientRect();
  return { x: rect.left + (c.x * 0.5 + 0.5) * rect.width, y: rect.top + (-c.y * 0.5 + 0.5) * rect.height };
}
window.__ime = { state, editor, isShell, recClass, recName, recBox, selectElementByRec, setBase, togglePart, toggleLayer, layerSet, hideRecs, unhideAll, editorPaste, itemMatrixIFC, editorUpdateItem, renderEditorPanel, screenOf, resizeMeshes, controls, camera, editorSelect, editorHide, editorUnhideAll, toggleMoveMode, openIfc, switchToProject, closeProject, openDocs, renderDocTabs, cutAtConcrete, cutPlaneWorld, updateResizeMesh, ensureResizeMesh };

/* ------------------------------------------------------------- startup */
renderRecents();
syncRadiusLabel();
renderEditorPanel();
document.body.dataset.tab = "project";
(async () => {
  try {
    const tabsData = await (await fetch("/api/tabs")).json();
    for (const t of tabsData.tabs || []) ensureDoc(t.key, t, t.path);
    currentProjectKey = tabsData.current || null;
    renderDocTabs();
    const snap = await (await fetch("/api/status")).json();
    if (currentProjectKey || (snap.done && !snap.error)) {
      const probe = await fetch("/api/meta");
      if (probe.ok) {
        $("welcome").hidden = true;
        await loadModelData();
        renderDocTabs();
        return;
      }
    }
    if (snap.stage && snap.stage !== "idle" && !snap.done) {
      $("welcome").hidden = true;
      $("load-progress").hidden = false;
      pollLoad(null, null);
    }
  } catch { /* server idle */ }
})();
