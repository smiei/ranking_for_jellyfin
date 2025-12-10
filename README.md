# Jellyfin Movies – Ranking & Swipe App

Small web app to pull your Jellyfin movie library, rank titles head-to-head (Elo), and do group swipe voting to find matches. Backend is Flask; frontend is plain HTML/CSS/JS. Includes a Windows tray launcher for easy start/stop.

## What it does
- **Ranking:** fetch movies from Jellyfin (or load a CSV), compare pairs, and build an Elo-based ordering. Filters: played/unplayed, runtime, critic score, year, 4K, max movies. Multiple voters, CSV export, top-10 image.
- **Swipe:** group-friendly swipe UI; people swipe Yes/No on the same list and matches are detected when everyone likes the same title. Works from a manual list or the same filtered Jellyfin fetch.
- **Translations:** `i18n.json` with UI/title language toggles; TMDB key is optional for title translation.
- **Persistence:** state in `state.json` / `swipe_state.json`; posters saved in `images/`.
- **Logs:** JSON lines per category under `logs/`.

## Project layout (top-level)
- `server.py` — Flask API (Jellyfin fetch, TMDB translation, state, swipe/rank endpoints, image serving).
- `index.html`, `style.css`, `script.js`, `i18n.json` — frontend UI/logic/translations.
- `config/` — `server.json` (backend defaults), `client.json` (frontend defaults).
- `tray_launcher.py` — Windows tray helper to start backend and static server.
- `start_servers.ps1` / `.bat` — startup scripts.
- `logs/` — runtime logs (created on first run).
- Data/state: `movies.csv`, `images/`, `state.json`, `swipe_state.json`.

## Requirements
- Python 3.10+ with `pip` (see `requirements.txt`).
- Jellyfin server with API key and user ID.
- Optional: TMDB API key for translated titles.
- Optional (Windows): `pystray`, `Pillow` for tray launcher (already in requirements).

## Setup
1. Install deps:
   ```bash
   pip install -r requirements.txt
   ```
2. Env/secrets:
   - Copy `.env.example` to `.env`.
   - Set at least: `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID`, `SERVER_PORT` (default 5000).
   - Optional: `TMDB_API_KEY`.
3. Defaults:
   - `config/server.json`: poster/state paths, base rating, default R, host/port, allowed CORS, `logDir` (defaults to `logs/`).
   - `config/client.json`: frontend API base/port, default tab, filter presets, slider ranges, swipe poll interval.

### Precedence
- Backend: real env / `.env` > `config/server.json` > built-ins.
- Frontend: `config/client.json` > built-ins in `script.js`.

## Running
- PowerShell helper (backend + static server + open browser):
  ```powershell
  ./start_servers.ps1
  ```
  - Flask on `http://localhost:5000`, static server on `http://localhost:8000`, opens `http://localhost:8000/index.html`.
- Manual:
  ```bash
  python server.py              # API
  python -m http.server 8000    # serve index.html
  ```
- Tray (Windows):
  ```bash
  python tray_launcher.py
  ```
  - Or build with PyInstaller if desired (see `JellyfinMoviesTray.spec` / `build_tray_exe.py`).

## Frontend basics
- Open `http://localhost:8000/index.html`.
- Tabs: **Ranking** (pairwise Elo) and **Swipe** (group likes).
- Filters: Played/Unplayed, runtime, critic rating, year, 4K, max movies.
- Sources:
  - “Filme laden” uses Jellyfin with current filters.
  - “CSV laden” reads `movies.csv` and matches posters in `images/`.

## API overview (stable endpoints)
- `GET /` health/info
- `POST /generate` fetch from Jellyfin, write CSV/posters, reset rank state
- `POST /load-csv` load `movies.csv`
- `POST /vote` submit Elo vote
- `POST /reset` reset rank state (keep movies)
- `GET /state` current rank state
- `POST /rank-confirm` mark rank confirmed
- Swipe: `GET/POST /swipe-state`, `POST /swipe-action`, `POST /swipe-reset`, `POST /swipe-confirm`
- `GET /movies` list from Jellyfin (for autocomplete)
- `GET /client-config` TMDB key presence
- Assets: `GET /images/<file>`

## Logging
- Location: `logs/` (change via `logDir` in `config/server.json`).
- Files are per category (e.g. `frontend.log`, `dom.log`, `api.log`, `errors.log`, `debug.log`, `tray_servers.log`).
- Frontend errors/unhandled rejections are sent to `/client-log` (category `errors`).
- Tray writes to `logs/tray_servers.log`.

## Data & persistence
- Posters: `images/`
- State: `state.json` (ranker), `swipe_state.json` (swipe)
- CSV: `movies.csv` (last fetched list)
- Logs: `logs/`

## Tips
- Port change: update `SERVER_PORT` in `.env` and `api.port/api.base` in `config/client.json`.
- CORS: set `allowedOrigins` in `config/server.json`.
- Light/dark toggle and filters persist in local storage/state.

## Release / publishing
- Ensure `.env.example`, `config/server.json`, `config/client.json` reflect your intended defaults.
- Keep secrets in `.env` (ignored by git).
- `logs/` is ignored by git; clear local logs/state/images before packaging if needed.
- Optional: build tray exe via `build_tray_exe.py` / `JellyfinMoviesTray.spec`.
