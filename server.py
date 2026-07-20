"""IFC Model Explorer — local server.

Run:  py -3.10 server.py            (opens the browser automatically)
      py -3.10 server.py --no-browser --port 8177
"""

from __future__ import annotations

import argparse
import os
import string
import subprocess
import threading
import webbrowser
from pathlib import Path
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import engine

TOOL_ROOT = Path(__file__).resolve().parent
DEFAULT_DIR = Path(os.environ.get("IFC_EXPLORER_START_DIR", r"D:\LiisbetSystem\fable site"))

app = FastAPI(title="IFC Model Explorer")

# Several models can be open at once (one browser tab each). Models are cheap to
# keep in memory — they hold only the gzipped meta + a path to the on-disk mesh.
state: dict[str, Any] = {"models": {}, "current": None, "load_job": None, "extract_job": None}
state_lock = threading.Lock()


def current_model() -> Optional["engine.Model"]:
    key = state.get("current")
    return state["models"].get(key) if key else None


class OpenRequest(BaseModel):
    path: str


class SwitchRequest(BaseModel):
    key: str


class CloseRequest(BaseModel):
    key: str


class ExtractRequest(BaseModel):
    elements: list[int]
    name: Optional[str] = None
    out_dir: Optional[str] = None
    key: Optional[str] = None                          # source model (defaults to current)
    moves: Optional[dict[str, list[float]]] = None    # stepId -> [dx,dy,dz] metres
    deforms: Optional[dict[str, list[float]]] = None  # stepId -> 16 floats (row-major 4x4, IFC world m)
    cuts: Optional[dict[str, list[float]]] = None      # stepId -> [ax, ay, az, d] world plane, keep n·x <= d


class RevealRequest(BaseModel):
    path: str


@app.get("/api/browse")
def browse(dir: str = "") -> dict[str, Any]:
    if not dir:
        target = DEFAULT_DIR if DEFAULT_DIR.is_dir() else Path.home()
    elif dir == "::drives":
        drives = [f"{letter}:\\" for letter in string.ascii_uppercase if Path(f"{letter}:\\").exists()]
        return {"dir": "", "parent": None, "dirs": drives, "files": []}
    else:
        target = Path(dir)
    if not target.is_dir():
        raise HTTPException(404, f"Kausta ei ole: {target}")
    dirs, files = [], []
    try:
        for entry in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            try:
                if entry.is_dir():
                    if not entry.name.startswith((".", "$")) and entry.name.lower() not in {"node_modules", "__pycache__"}:
                        dirs.append(str(entry))
                elif entry.suffix.lower() == ".ifc":
                    stat = entry.stat()
                    files.append({"name": entry.name, "path": str(entry), "sizeMB": round(stat.st_size / 1e6, 1)})
            except OSError:
                continue
    except PermissionError:
        raise HTTPException(403, f"Ligipääs puudub: {target}")
    parent = str(target.parent) if target.parent != target else "::drives"
    return {"dir": str(target), "parent": parent, "dirs": dirs, "files": files}


def _tab_info(model: "engine.Model") -> dict[str, Any]:
    f = model.meta.get("file", {})
    return {"key": model.key, "name": f.get("name", model.path.name), "path": str(model.path),
            "sizeMB": f.get("sizeMB"), "packages": len(model.meta.get("packages", [])), "ready": True}


@app.get("/api/tabs")
def tabs() -> dict[str, Any]:
    return {"current": state.get("current"), "tabs": [_tab_info(m) for m in state["models"].values()]}


@app.post("/api/open")
def open_file(request: OpenRequest) -> dict[str, Any]:
    path = Path(request.path)
    if not path.is_file() or path.suffix.lower() != ".ifc":
        raise HTTPException(404, f"IFC faili ei ole: {path}")
    key = engine.file_key(path)
    with state_lock:
        if key in state["models"]:            # already open — just switch to it
            state["current"] = key
            return {"started": False, "key": key, "file": state["models"][key].meta.get("file", {})}
        job = state.get("load_job")
        if job and job.is_alive():
            raise HTTPException(409, "Laadimine juba käib")

        def run(status):
            model = engine.load_model(path, status)
            with state_lock:
                state["models"][model.key] = model
                state["current"] = model.key
            return {"key": model.key, "file": model.meta.get("file", {})}

        job = engine.Job("load", run)
        state["load_job"] = job
        job.start()
    return {"started": True, "key": key}


@app.post("/api/switch")
def switch(request: SwitchRequest) -> dict[str, Any]:
    with state_lock:
        if request.key not in state["models"]:
            raise HTTPException(404, "Tab pole avatud")
        state["current"] = request.key
        return {"key": request.key, "file": state["models"][request.key].meta.get("file", {})}


@app.post("/api/close")
def close(request: CloseRequest) -> dict[str, Any]:
    with state_lock:
        state["models"].pop(request.key, None)
        if state.get("current") == request.key:
            state["current"] = next(iter(state["models"]), None)
        return {"current": state.get("current")}


@app.get("/api/status")
def load_status() -> dict[str, Any]:
    job = state.get("load_job")
    if job is None:
        return {"stage": "idle", "pct": 0, "done": False}
    return job.snapshot()


def _model_for(key: Optional[str]) -> "engine.Model":
    model = state["models"].get(key) if key else current_model()
    if model is None or not model.meta_gz:
        raise HTTPException(404, "Mudel ei ole laetud")
    return model


@app.get("/api/meta")
def meta(key: Optional[str] = None) -> Response:
    model = _model_for(key)
    return Response(
        content=model.meta_gz,
        media_type="application/json",
        headers={"Content-Encoding": "gzip", "Cache-Control": "no-store"},
    )


@app.get("/api/mesh.bin")
def mesh(key: Optional[str] = None) -> FileResponse:
    model = _model_for(key)
    if not model.mesh_path or not model.mesh_path.is_file():
        raise HTTPException(404, "Mudel ei ole laetud")
    return FileResponse(model.mesh_path, media_type="application/octet-stream")


@app.post("/api/extract")
def extract(request: ExtractRequest) -> dict[str, Any]:
    model = state["models"].get(request.key) if request.key else current_model()
    if model is None:
        raise HTTPException(404, "Mudel ei ole laetud")
    with state_lock:
        job = state.get("extract_job")
        if job and job.is_alive():
            raise HTTPException(409, "Eksport juba käib")
        out_dir = Path(request.out_dir) if request.out_dir else None
        job = engine.Job("extract", lambda status: model.extract(
            request.elements, request.name, out_dir, status,
            moves=request.moves, deforms=request.deforms, cuts=request.cuts))
        state["extract_job"] = job
        job.start()
    return {"started": True}


@app.get("/api/extract/status")
def extract_status() -> dict[str, Any]:
    job = state.get("extract_job")
    if job is None:
        return {"stage": "idle", "pct": 0, "done": False}
    return job.snapshot()


@app.post("/api/reveal")
def reveal(request: RevealRequest) -> dict[str, Any]:
    path = Path(request.path)
    if not path.exists():
        raise HTTPException(404, str(path))
    target = path if path.is_dir() else path.parent
    if path.is_file():
        subprocess.Popen(["explorer", "/select,", str(path)])
    else:
        os.startfile(str(target))  # noqa: S606 — local convenience
    return {"ok": True}


@app.get("/")
def index() -> FileResponse:
    return FileResponse(TOOL_ROOT / "static" / "index.html")


app.mount("/static", StaticFiles(directory=TOOL_ROOT / "static"), name="static")


def open_browser(url: str) -> None:
    edge_paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    for edge in edge_paths:
        if Path(edge).is_file():
            subprocess.Popen([edge, f"--app={url}", "--window-size=1500,950"])
            return
    webbrowser.open(url)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8177)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    url = f"http://127.0.0.1:{args.port}"
    if not args.no_browser:
        threading.Timer(1.2, open_browser, [url]).start()
    print(f"IFC Model Explorer — {url}  (Ctrl+C sulgeb)")
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
