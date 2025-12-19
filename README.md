# Jellyfin Movies – Ranking & Swipe App

Small web app to pull your Jellyfin movie library, rank titles head-to-head (TrueSkill), and do group swipe voting to find matches. Backend is Flask; frontend is plain HTML/CSS/JS. Includes a Windows tray launcher for easy start/stop.

## What it does
- **Ranking:** fetch movies from Jellyfin (or load a CSV), compare pairs, and build a TrueSkill-based ordering. Filters: played/unplayed, runtime, critic score, year, 4K, max movies. Multiple voters, CSV export, top-10 image.
- **Swipe:** group-friendly swipe UI; people swipe Yes/No on the same list and matches are detected when everyone likes the same title. Works from a manual list or the same filtered Jellyfin fetch.
- **Translations:** `i18n.json` with UI/title language toggles; TMDB key is optional for title translation.
- **Persistence:** state in `state.json` / `swipe_state.json`; posters saved in `images/`.
- **Logs:** JSON lines per category under `logs/`.

## Project layout (top-level)
- `backend/` — Flask API (`server.py`), backend config (`config/server.json`), env template (`.env.example`), Python deps (`requirements.txt`).
- `frontend/` — static UI (`index.html`, `style.css`, `script.js`, `i18n.json`, `config/client.json`).
- `scripts/` — helper launchers (`start_servers.ps1`, `start_servers.bat`, `start_tray_launcher.vbs`).
- `tools/` — tray launcher (`tray_launcher.py`), PyInstaller helper, and utilities.
- Runtime data (created on first run, ignored by git): `backend/images/`, `backend/logs/`, `backend/saves/`, `backend/movies.csv`, `backend/state.json`, `backend/swipe_state.json`.

## Requirements
- Python 3.10+ with `pip` (see `backend/requirements.txt`).
- Jellyfin server with API key and user ID.
- Optional: TMDB API key for translated titles.
- Optional (Windows): `pystray`, `Pillow` for tray launcher (already in requirements).

## Setup
1. Install deps:
   ```bash
   pip install -r backend/requirements.txt
   ```
2. Env/secrets:
   - Copy `backend/.env.example` to `backend/.env`.
   - Set at least: `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID`, `SERVER_PORT` (default 5000).
   - Optional: `TMDB_API_KEY`.
3. Defaults:
   - `backend/config/server.json`: poster/state paths, base rating, default R, host/port, allowed CORS, `logDir` (defaults to `backend/logs/`).
   - `frontend/config/client.json`: frontend API base/port, default tab, filter presets, slider ranges, swipe poll interval.

### Precedence
- Backend: real env / `backend/.env` > `backend/config/server.json` > built-ins.
- Frontend: `frontend/config/client.json` > built-ins in `script.js`.

## Running
- PowerShell helper (backend + static server + open browser):
  ```powershell
  ./scripts/start_servers.ps1
  ```
  - Flask on `http://localhost:5000`, static server on `http://localhost:8000`, opens `http://localhost:8000/index.html`.
- Manual:
  ```bash
  python backend/server.py                           # API (cwd can be repo root)
  python -m http.server 8000 --directory frontend    # serve index.html
  ```
- Tray (Windows):
  ```bash
  python tools/tray_launcher.py
  ```
  - Or build with PyInstaller if desired (see `tools/build_tray_exe.py`).

## Frontend basics
- Open `http://localhost:8000/index.html`.
- Tabs: **Ranking** (pairwise TrueSkill) and **Swipe** (group likes).
- Filters: Played/Unplayed, runtime, critic rating, year, 4K, max movies.
- Sources:
  - “Filme laden” uses Jellyfin with current filters.
  - “CSV laden” reads `movies.csv` and matches posters in `images/`.

## API overview (stable endpoints)
- `GET /` health/info
- `POST /generate` fetch from Jellyfin, write CSV/posters, reset rank state
- `POST /load-csv` load `movies.csv`
- `POST /vote` submit TrueSkill vote
- `POST /reset` reset rank state (keep movies)
- `GET /state` current rank state
- `POST /rank-confirm` mark rank confirmed
- Swipe: `GET/POST /swipe-state`, `POST /swipe-action`, `POST /swipe-reset`, `POST /swipe-confirm`
- `GET /movies` list from Jellyfin (for autocomplete)
- `GET /client-config` TMDB key presence
- Assets: `GET /images/<file>`

## Logging
- Location: `backend/logs/` (change via `logDir` in `backend/config/server.json`).
- Files are per category (e.g. `frontend.log`, `dom.log`, `api.log`, `errors.log`, `debug.log`, `tray_servers.log`).
- Frontend errors/unhandled rejections are sent to `/client-log` (category `errors`).
- Tray writes to `backend/logs/tray_servers.log`.

## Data & persistence
- Posters: `backend/images/`
- State: `backend/state.json` (ranker), `backend/swipe_state.json` (swipe)
- CSV: `backend/movies.csv` (last fetched list)
- Logs: `backend/logs/`

## Tips
- Port change: update `SERVER_PORT` in `backend/.env` and `api.port/api.base` in `frontend/config/client.json`.
- CORS: set `allowedOrigins` in `backend/config/server.json`.
- Light/dark toggle and filters persist in local storage/state.

## Release / publishing
- Ensure `.env.example`, `backend/config/server.json`, `frontend/config/client.json` reflect your intended defaults.
- Keep secrets in `backend/.env` (ignored by git).
- `backend/logs/` is ignored by git; clear local logs/state/images before packaging if needed.
- Optional: build tray exe via `tools/build_tray_exe.py`.
