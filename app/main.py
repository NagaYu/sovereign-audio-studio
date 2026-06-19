"""
Sovereign Audio Studio — Hybrid Local Server (OPTIONAL)
=======================================================

The entire product runs 100% in the browser (WebGPU / WASM). No audio ever
leaves the device. This FastAPI server is a *thin, optional* convenience layer
for users who want a "desktop app" experience:

    * Serves the SPA + static assets (so the worker / WASM load with correct
      CORS + cross-origin-isolation headers required by SharedArrayBuffer).
    * Stores transcription *metadata* history in a local SQLite DB so a single
      machine can keep a searchable log of past jobs.

IMPORTANT: Even with the server running, raw audio is NEVER uploaded. Only the
final text + lightweight metadata the user explicitly chooses to save is sent
to localhost, and it is persisted only on the user's own disk.

Run:
    uvicorn app.main:app --reload --port 8000
or simply:
    python -m app.main
"""

from __future__ import annotations

import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"
DB_PATH = BASE_DIR / "sovereign_history.db"

app = FastAPI(
    title="Sovereign Audio Studio",
    version="1.0.0",
    description="Local-first, zero-cost edge audio AI. No audio ever leaves the device.",
)

# Local desktop usage only — wide open is fine because it binds to localhost.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Headers
# ---------------------------------------------------------------------------
# We deliberately do NOT set COEP: require-corp. The AI runs inside a dedicated
# Web Worker with ONNX Runtime in single-thread mode (see transcribe.worker.js),
# so SharedArrayBuffer is not required — and require-corp would risk blocking the
# one-time cross-origin model download from the CDN. WebGPU (the fast path) needs
# no cross-origin isolation. COOP is kept for general hardening only.
@app.middleware("http")
async def add_security_headers(request, call_next):
    response: Response = await call_next(request)
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
    # General hardening (safe for a same-origin, self-hosted app).
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
    # Versioned caching: immutable assets cached forever, app code revalidated.
    path = request.url.path
    immutable = ("/static/df3/", "/static/vendor/", "/static/models/", "/static/icon-")
    if any(seg in path for seg in immutable):
        # Large, versioned, immutable assets (AI models + wasm + vendored libs):
        # cache hard so the one-time download happens once and the app then works
        # fully offline / air-gapped.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif path == "/" or path == "/sw.js" or path.endswith((".js", ".html", ".mjs")):
        # Force revalidation of app code so updates propagate (cheap 304 via ETag).
        response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------
# SQLite history (metadata only — never audio)
# ---------------------------------------------------------------------------
@contextmanager
def get_db() -> Iterator[sqlite3.Connection]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS jobs (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                filename        TEXT    NOT NULL,
                language        TEXT    NOT NULL,
                model           TEXT    NOT NULL,
                backend         TEXT    NOT NULL,
                duration_sec    REAL    NOT NULL DEFAULT 0,
                process_ms      REAL    NOT NULL DEFAULT 0,
                noise_strength  REAL    NOT NULL DEFAULT 0,
                cloud_cost_saved REAL   NOT NULL DEFAULT 0,
                transcript      TEXT    NOT NULL DEFAULT '',
                created_at      REAL    NOT NULL
            )
            """
        )


init_db()


class JobIn(BaseModel):
    filename: str = Field(..., max_length=512)
    language: str = "auto"
    model: str = "unknown"
    backend: str = "wasm"
    duration_sec: float = 0.0
    process_ms: float = 0.0
    noise_strength: float = 0.0
    cloud_cost_saved: float = 0.0
    transcript: str = ""


class JobOut(JobIn):
    id: int
    created_at: float


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------
@app.get("/api/health")
def health() -> dict:
    return {"status": "sovereign", "audio_leaves_device": False, "monthly_cost_usd": 0.0}


@app.post("/api/jobs", response_model=JobOut)
def create_job(job: JobIn) -> JobOut:
    created = time.time()
    with get_db() as conn:
        cur = conn.execute(
            """
            INSERT INTO jobs (filename, language, model, backend, duration_sec,
                              process_ms, noise_strength, cloud_cost_saved,
                              transcript, created_at)
            VALUES (:filename, :language, :model, :backend, :duration_sec,
                    :process_ms, :noise_strength, :cloud_cost_saved,
                    :transcript, :created_at)
            """,
            {**job.model_dump(), "created_at": created},
        )
        job_id = cur.lastrowid
    return JobOut(id=job_id, created_at=created, **job.model_dump())


@app.get("/api/jobs", response_model=list[JobOut])
def list_jobs(limit: int = 50) -> list[JobOut]:
    limit = max(1, min(limit, 500))
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [JobOut(**dict(r)) for r in rows]


@app.get("/api/jobs/{job_id}", response_model=JobOut)
def get_job(job_id: int) -> JobOut:
    with get_db() as conn:
        row = conn.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="job not found")
    return JobOut(**dict(row))


@app.delete("/api/jobs/{job_id}")
def delete_job(job_id: int) -> JSONResponse:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM jobs WHERE id = ?", (job_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="job not found")
    return JSONResponse({"deleted": job_id})


@app.get("/api/stats")
def stats() -> dict:
    with get_db() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*)               AS jobs,
                   COALESCE(SUM(duration_sec), 0)     AS total_audio_sec,
                   COALESCE(SUM(cloud_cost_saved), 0) AS total_saved_usd
            FROM jobs
            """
        ).fetchone()
    return {
        "jobs": row["jobs"],
        "total_audio_minutes": round(row["total_audio_sec"] / 60.0, 2),
        "total_cloud_cost_saved_usd": round(row["total_saved_usd"], 2),
        "server_cost_usd": 0.0,
    }


# ---------------------------------------------------------------------------
# Static + SPA
# ---------------------------------------------------------------------------
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index() -> FileResponse:
    return FileResponse(TEMPLATES_DIR / "index.html")


@app.get("/sw.js")
def service_worker() -> FileResponse:
    # Served from the root so its scope covers the whole app ("/"), not /static.
    return FileResponse(
        STATIC_DIR / "sw.js",
        media_type="application/javascript",
        headers={"Service-Worker-Allowed": "/"},
    )


@app.get("/favicon.ico")
def favicon() -> FileResponse:
    return FileResponse(STATIC_DIR / "favicon-32.png", media_type="image/png")


if __name__ == "__main__":
    import uvicorn

    print("\n  Sovereign Audio Studio  →  http://localhost:8000\n")
    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)
