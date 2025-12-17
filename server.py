import csv
import glob
import json
import random
import os
import re
import shutil
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple, Set

import requests
import trueskill
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
ENV_PATH = ROOT / ".env"


def load_env_file(path: Path) -> Dict[str, str]:
    """Load simple KEY=VALUE pairs from a .env-style file."""
    env: Dict[str, str] = {}
    if not path.is_file():
        return env
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip()
    return env


def load_json(path: Path, default: Any = None) -> Any:
    """Load JSON safely, returning default on missing file or errors."""
    if not path.is_file():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def save_json(path: Path, data: Any) -> None:
    """Persist JSON data with utf-8 encoding."""
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def append_debug_log(message: str, extra: Optional[Dict[str, Any]] = None) -> None:
    """Append a debug line to the debug log file (backward compatibility)."""
    log_event("debug", message, extra)


def log_event(category: str, message: str, extra: Optional[Dict[str, Any]] = None) -> None:
    """Append structured log line to <category>.log."""
    try:
        filename = f"{category}.log"
        log_path = (ROOT / LOG_DIR / filename).resolve()
        log_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"msg": message}
        if extra:
            payload.update(extra)
        line = json.dumps(payload, ensure_ascii=False)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


env_file = load_env_file(ENV_PATH)
server_cfg = load_json(CONFIG_DIR / "server.json", {}) or {}
env = {**env_file, **os.environ}

# ==== KONFIGURATION ====
JELLYFIN_URL = env.get("JELLYFIN_URL", server_cfg.get("jellyfinUrl", "http://localhost:8096"))
API_KEY = env.get("JELLYFIN_API_KEY") or env.get("API_KEY") or server_cfg.get("apiKey", "")
USER_ID = env.get("JELLYFIN_USER_ID") or server_cfg.get("userId", "")
TMDB_API_KEY = env.get("TMDB_API_KEY") or server_cfg.get("tmdbApiKey", "")
TMDB_API_URL = "https://api.themoviedb.org/3"
OUTPUT_CSV = server_cfg.get("outputCsv", "movies.csv")
POSTER_DIR = server_cfg.get("posterDir", "images")
STATE_FILE = server_cfg.get("stateFile", "state.json")
SWIPE_STATE_FILE = server_cfg.get("swipeStateFile", "swipe_state.json")
SERVER_HOST = server_cfg.get("host", "0.0.0.0")
SERVER_PORT = int(env.get("SERVER_PORT", server_cfg.get("port", 5000)))
ALLOWED_ORIGINS = server_cfg.get("allowedOrigins") or "*"
DEBUG_LOG = server_cfg.get("debugLog", "debug.log")
LOG_DIR = Path(server_cfg.get("logDir") or "logs")
SAVES_DIR = Path(server_cfg.get("savesDir") or "saves")
# TrueSkill configuration (scaled to approx. old Elo range)
TS_MU = float(server_cfg.get("tsMu", 1500))
TS_SIGMA = float(server_cfg.get("tsSigma", 400))
TS_BETA = float(server_cfg.get("tsBeta", TS_SIGMA / 2))
TS_TAU = float(server_cfg.get("tsTau", TS_SIGMA / 100))
TS_DRAW_PROB = float(server_cfg.get("tsDrawProbability", 0.0))
TS_ENV = trueskill.TrueSkill(
    mu=TS_MU,
    sigma=TS_SIGMA,
    beta=TS_BETA,
    tau=TS_TAU,
    draw_probability=TS_DRAW_PROB,
)
# Expose the active TrueSkill configuration so it can be persisted with state.
def current_ts_config() -> Dict[str, float]:
    return {
        "mu": TS_ENV.mu,
        "sigma": TS_ENV.sigma,
        "beta": TS_ENV.beta,
        "tau": TS_ENV.tau,
        "drawProbability": TS_ENV.draw_probability,
    }
# =======================

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)
os.makedirs(POSTER_DIR, exist_ok=True)
os.makedirs(SAVES_DIR, exist_ok=True)

EMPTY_SWIPE_STATE = {
    "movies": [],
    "progress": {},
    "persons": [],
    "locked": False,
    "likes": {},
    "matches": [],
}
EMPTY_RANK_STATE_EXTRA = {"rankerConfirmed": False}
TMDB_TITLE_CACHE: Dict[Tuple[str, str], Optional[str]] = {}
PAIR_SEPARATOR = "||"


def new_rating() -> Dict[str, Any]:
    """Create a fresh TrueSkill rating entry."""
    return {"ts_mu": TS_ENV.mu, "ts_sigma": TS_ENV.sigma, "games": 0, "wins": 0}


def ensure_rating(entry: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalize a rating dict to include TrueSkill fields."""
    if not isinstance(entry, dict):
        return new_rating()
    mu = entry.get("ts_mu")
    sigma = entry.get("ts_sigma")
    # migrate old Elo rating into mu if needed
    if mu is None and entry.get("rating") is not None:
        mu = float(entry.get("rating"))
    if sigma is None:
        sigma = TS_ENV.sigma
    games = int(entry.get("games", 0))
    wins = int(entry.get("wins", 0))
    return {"ts_mu": float(mu if mu is not None else TS_ENV.mu), "ts_sigma": float(sigma), "games": games, "wins": wins}


def pair_key(a: str, b: str) -> str:
    """Normalized key for an unordered pair of titles."""
    return PAIR_SEPARATOR.join(sorted([a, b]))


def ensure_pair_counts(state: Dict[str, Any]) -> Dict[str, Any]:
    """Guarantee per-person pair count maps exist."""
    pair_counts = state.get("pairCounts")
    if not isinstance(pair_counts, dict):
        pair_counts = {}
    # derive persons from comparisonCount or personCount
    persons: Set[str] = set()
    comp = state.get("comparisonCount") or {}
    persons.update(comp.keys())
    count = max(1, int(state.get("personCount") or len(persons) or 1))
    if not persons:
        persons = {f"person{i+1}" for i in range(count)}
    for p in persons:
        if p not in pair_counts or not isinstance(pair_counts[p], dict):
            pair_counts[p] = {}
    state["pairCounts"] = pair_counts
    return state


def record_pair_result(state: Dict[str, Any], person: str, title_a: str, title_b: str) -> None:
    """Increment pair count for a person."""
    ensure_pair_counts(state)
    key = pair_key(title_a, title_b)
    pair_map = state["pairCounts"].setdefault(person, {})
    pair_map[key] = pair_map.get(key, 0) + 1


def compute_pair_coverage(state: Dict[str, Any]) -> Dict[str, Any]:
    """Compute coverage stats overall and per person."""
    ensure_pair_counts(state)
    movies = state.get("movies") or []
    title_set = {m.get("title") for m in movies if m.get("title")}
    total_pairs = max(0, len(movies) * (len(movies) - 1) // 2)
    pair_counts = state.get("pairCounts") or {}
    overall_keys: Set[str] = set()
    per_person: Dict[str, Dict[str, Any]] = {}
    for person, pairs in pair_counts.items():
        valid_keys = set()
        for key in (pairs or {}):
            parts = key.split(PAIR_SEPARATOR)
            if len(parts) == 2 and (not title_set or (parts[0] in title_set and parts[1] in title_set)):
                valid_keys.add(key)
        covered = len(valid_keys)
        ratio = (covered / total_pairs) if total_pairs else 0.0
        per_person[person] = {"coveredPairs": covered, "totalPairs": total_pairs, "ratio": ratio}
        overall_keys.update(valid_keys)
    covered_pairs = len(overall_keys)
    ratio = (covered_pairs / total_pairs) if total_pairs else 0.0
    state["pairCoverage"] = {"coveredPairs": covered_pairs, "totalPairs": total_pairs, "ratio": ratio}
    state["pairCoveragePerPerson"] = per_person
    return state


def normalize_ranking_state(state: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Ensure ratings, pair counts, and coverage are present."""
    if not state:
        return state
    raw_ratings = state.get("ratings") or {}
    movies = state.get("movies") or []
    normalized: Dict[str, Dict[str, Any]] = {}
    for item in movies:
        title = item.get("title")
        if not title:
            continue
        normalized[title] = ensure_rating(raw_ratings.get(title))
    # keep stray ratings for titles not in list
    for title, entry in raw_ratings.items():
        if title not in normalized:
            normalized[title] = ensure_rating(entry)
    state["ratings"] = normalized
    ensure_pair_counts(state)
    compute_pair_coverage(state)
    base_cfg = current_ts_config()
    existing_cfg = state.get("tsConfig") or {}
    merged_cfg = {**base_cfg, **existing_cfg}
    state["tsConfig"] = merged_cfg
    return state


def sanitize_save_name(name: str) -> str:
    name = re.sub(r"[^a-zA-Z0-9_-]", "_", name or "")
    name = re.sub(r"_+", "_", name).strip("_")
    return name or datetime.now().strftime("save_%Y%m%d_%H%M%S")


def list_saves() -> List[Dict[str, Any]]:
    saves: List[Dict[str, Any]] = []
    SAVES_DIR.mkdir(parents=True, exist_ok=True)
    for entry in SAVES_DIR.iterdir():
        if not entry.is_dir():
            continue
        stat = entry.stat()
        saves.append({
            "name": entry.name,
            "createdAt": datetime.fromtimestamp(stat.st_mtime).isoformat(),
        })
    saves.sort(key=lambda x: x["createdAt"], reverse=True)
    return saves


def create_save_snapshot(name: Optional[str] = None) -> str:
    snapshot_name = sanitize_save_name(name or "")
    dest = SAVES_DIR / snapshot_name
    if dest.exists():
        raise ValueError("save already exists")
    state_path = Path(STATE_FILE)
    if not state_path.is_file():
        raise FileNotFoundError("no ranking state to save")
    dest.mkdir(parents=True, exist_ok=False)
    shutil.copy2(state_path, dest / state_path.name)
    swipe_path = Path(SWIPE_STATE_FILE)
    if swipe_path.is_file():
        shutil.copy2(swipe_path, dest / swipe_path.name)
    csv_path = Path(OUTPUT_CSV)
    if csv_path.is_file():
        shutil.copy2(csv_path, dest / csv_path.name)
    images_path = Path(POSTER_DIR)
    if images_path.is_dir():
        shutil.copytree(images_path, dest / images_path.name, dirs_exist_ok=True)
    return snapshot_name


def load_save_snapshot(name: str) -> Dict[str, Any]:
    snapshot_name = sanitize_save_name(name)
    src = SAVES_DIR / snapshot_name
    if not src.is_dir():
        raise FileNotFoundError("save not found")
    state_src = src / Path(STATE_FILE).name
    if not state_src.is_file():
        raise FileNotFoundError("save missing state")
    shutil.copy2(state_src, Path(STATE_FILE))
    swipe_src = src / Path(SWIPE_STATE_FILE).name
    if swipe_src.is_file():
        shutil.copy2(swipe_src, Path(SWIPE_STATE_FILE))
    csv_src = src / Path(OUTPUT_CSV).name
    if csv_src.is_file():
        shutil.copy2(csv_src, Path(OUTPUT_CSV))
    images_src = src / Path(POSTER_DIR).name
    if images_src.is_dir():
        clear_poster_dir()
        shutil.copytree(images_src, POSTER_DIR, dirs_exist_ok=True)
    return normalize_ranking_state(load_state()) or {}


def sanitize_filename(name: str) -> str:
    """Make a string safe for filenames while keeping spaces."""
    name = re.sub(r'[\\/*?:"<>|,]', '', name).strip()
    name = re.sub(r'\s+', ' ', name)
    return name[:150] if name else "unbenannt"


def tmdb_title_by_id(session: requests.Session, tmdb_id: str, lang: str) -> Optional[str]:
    """Lookup TMDB title by ID with language fallback."""
    try:
        resp = session.get(f"{TMDB_API_URL}/movie/{tmdb_id}", params={"language": lang}, timeout=8)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("title") or data.get("original_title") or data.get("name")
    except Exception:
        return None
    return None


def tmdb_title_by_search(session: requests.Session, title: str, year: Optional[int], lang: str) -> Optional[str]:
    """Search TMDB for a movie title, preferring matching year when available."""
    params = {"query": title, "language": lang, "include_adult": False}
    if year:
        params["year"] = year
    try:
        resp = session.get(f"{TMDB_API_URL}/search/movie", params=params, timeout=8)
        if resp.status_code != 200:
            return None
        results = resp.json().get("results") or []
        candidate = None
        if year:
            candidate = next((r for r in results if str(year) == (r.get("release_date") or "")[:4]), None)
        candidate = candidate or (results[0] if results else None)
        if candidate:
            return candidate.get("title") or candidate.get("original_title") or candidate.get("name")
    except Exception:
        return None
    return None


def resolve_tmdb_title(session: requests.Session, item: Dict[str, Any], lang: str) -> Optional[str]:
    """Resolve translated title via TMDB, with in-memory caching."""
    if not session:
        return None
    raw_title = item.get("Name") or ""
    year = item.get("ProductionYear")
    provider_ids = item.get("ProviderIds") or {}
    tmdb_id = provider_ids.get("Tmdb") or provider_ids.get("tmdb")
    cache_key = (lang, f"id:{tmdb_id}" if tmdb_id else f"title:{raw_title.lower().strip()}|{year or ''}")
    if cache_key in TMDB_TITLE_CACHE:
        return TMDB_TITLE_CACHE[cache_key]
    title = None
    if tmdb_id:
        title = tmdb_title_by_id(session, tmdb_id, lang)
    if not title and raw_title:
        title = tmdb_title_by_search(session, raw_title, year, lang)
    TMDB_TITLE_CACHE[cache_key] = title
    return title


def clear_poster_dir() -> None:
    """Remove all files/dirs inside poster directory and recreate it."""
    if os.path.isdir(POSTER_DIR):
        for path in glob.glob(os.path.join(POSTER_DIR, "*")):
            try:
                if os.path.isfile(path):
                    os.remove(path)
                else:
                    shutil.rmtree(path)
            except PermissionError:
                pass
    os.makedirs(POSTER_DIR, exist_ok=True)


def normalize_image_key(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def build_image_lookup() -> Dict[str, str]:
    """Build mapping from normalized image names to filenames."""
    lookup: Dict[str, str] = {}
    if not os.path.isdir(POSTER_DIR):
        return lookup
    for fname in os.listdir(POSTER_DIR):
        path = os.path.join(POSTER_DIR, fname)
        if not os.path.isfile(path):
            continue
        key = normalize_image_key(Path(fname).stem)
        if key:
            lookup[key] = fname
    return lookup


def match_image_for_title(title: str, lookup: Dict[str, str]) -> Optional[str]:
    """Try multiple sanitized variants to find a matching poster image."""
    if not title:
        return None
    safe = sanitize_filename(title)
    cleaned = re.sub(r"[’']", "", safe)
    candidates = [
        safe,
        safe.replace(" ", "_"),
        safe.replace(" ", ""),
        cleaned,
        cleaned.replace(" ", "_"),
        cleaned.replace(" ", ""),
    ]
    for cand in candidates:
        key = normalize_image_key(cand)
        if key and key in lookup:
            return lookup[key]
    return None


def load_movies_from_csv() -> Dict[str, Any]:
    """Load titles from CSV and reconstruct baseline ranking state."""
    path = Path(OUTPUT_CSV)
    if not path.is_file():
        raise FileNotFoundError(f"{OUTPUT_CSV} not found")

    titles: List[str] = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        for idx, row in enumerate(reader):
            if not row:
                continue
            title = (row[0] or "").strip()
            if idx == 0 and title.lower() == "title":
                continue
            if title:
                titles.append(title)

    if not titles:
        raise ValueError("CSV enthaelt keine Titel")

    image_lookup = build_image_lookup()
    seen: Set[str] = set()
    movies: List[Dict[str, Any]] = []
    for title in titles:
        key = title.lower()
        if key in seen:
            continue
        seen.add(key)
        image = match_image_for_title(title, image_lookup) or ""
        movies.append({"title": title, "display": title, "image": image, "source": "csv"})

    ratings = base_ratings_from_movies(movies)
    existing_state = load_state() or {}
    person_count = max(1, int(existing_state.get("personCount") or 1))
    state = {
        "movies": movies,
        "ratings": ratings,
        "comparisonCount": {},
        "totalVotes": 0,
        "personCount": person_count,
        "filters": existing_state.get("filters") or [],
        "runtimeMin": existing_state.get("runtimeMin"),
        "runtimeMax": existing_state.get("runtimeMax"),
        "criticMin": existing_state.get("criticMin"),
        "criticMax": existing_state.get("criticMax"),
        "yearMin": existing_state.get("yearMin"),
        "yearMax": existing_state.get("yearMax"),
        "rankerConfirmed": False,
        "pairCounts": {},
        "tsConfig": current_ts_config(),
    }
    state.update(EMPTY_RANK_STATE_EXTRA)
    compute_pair_coverage(state)
    save_state(state)
    return state


def minutes_to_ticks(val: Optional[float]) -> Optional[int]:
    """Convert minutes to Jellyfin ticks (100ns units)."""
    if val is None:
        return None
    try:
        return int(float(val) * 60 * 10_000_000)
    except Exception:
        return None


def update_trueskill(winner: Dict[str, Any], loser: Dict[str, Any]) -> None:
    """TrueSkill update for one match."""
    w_rating = trueskill.Rating(mu=winner["ts_mu"], sigma=winner["ts_sigma"])
    l_rating = trueskill.Rating(mu=loser["ts_mu"], sigma=loser["ts_sigma"])
    new_w, new_l = TS_ENV.rate_1vs1(w_rating, l_rating)
    winner["ts_mu"], winner["ts_sigma"] = new_w.mu, new_w.sigma
    loser["ts_mu"], loser["ts_sigma"] = new_l.mu, new_l.sigma
    winner["games"] += 1
    loser["games"] += 1
    winner["wins"] = winner.get("wins", 0) + 1


def fetch_movies(filters: List[str], runtime_min=None, runtime_max=None, critic_min=None, critic_max=None,
                 year_min=None, year_max=None, limit=10000) -> List[Dict[str, Any]]:
    """Fetch movies from Jellyfin, applying filters and runtime guardrails."""
    session = requests.Session()
    session.headers.update({"X-Emby-Token": API_KEY})
    min_ticks = minutes_to_ticks(runtime_min)
    max_ticks = minutes_to_ticks(runtime_max)
    params = {
        "IncludeItemTypes": "Movie",
        "Recursive": "true",
        "Filters": ",".join(filters) if filters else None,
        "SortBy": "SortName",
        "SortOrder": "Ascending",
        "Limit": limit,
        "Fields": "RunTimeTicks,ProviderIds,OriginalTitle",
        # Community Rating
        "MinCommunityRating": critic_min,
        "MaxCommunityRating": critic_max,
    }
    if year_min:
        params["MinPremiereDate"] = f"{int(year_min)}-01-01T00:00:00Z"
    if year_max:
        params["MaxPremiereDate"] = f"{int(year_max)}-12-31T23:59:59Z"
    params = {k: v for k, v in params.items() if v is not None}
    url = f"{JELLYFIN_URL}/Users/{USER_ID}/Items"
    resp = session.get(url, params=params)
    resp.raise_for_status()
    items = resp.json().get("Items", [])
    raw_count = len(items)

    # Laufzeit-Filter rein in Python, da Jellyfin den Parameter teils ignoriert
    if min_ticks is not None or max_ticks is not None:
        filtered = []
        for it in items:
            rt = it.get("RunTimeTicks")
            if rt is None:
                continue
            if min_ticks is not None and rt < min_ticks:
                continue
            if max_ticks is not None and rt > max_ticks:
                continue
            filtered.append(it)
        items = filtered

    try:
        print(f"Jellyfin URL: {resp.url} | Items: {len(items)} (raw {raw_count}) | runtimeTicks=({min_ticks},{max_ticks})", flush=True)
    except Exception:
        pass
    return items


def fetch_shows(limit: int = 10000) -> List[Dict[str, Any]]:
    """Fetch all shows (Series) from Jellyfin without filters."""
    session = requests.Session()
    session.headers.update({"X-Emby-Token": API_KEY})
    params = {
        "IncludeItemTypes": "Series",
        "Recursive": "true",
        "SortBy": "SortName",
        "SortOrder": "Ascending",
        "Limit": limit,
        "Fields": "ProviderIds,ProductionYear,ImageTags,Type,CollectionType",
        "UserId": USER_ID,
    }
    url = f"{JELLYFIN_URL}/Items"
    resp = session.get(url, params=params)
    resp.raise_for_status()
    raw_items = resp.json().get("Items", [])
    items = [it for it in raw_items if (it.get("Type") == "Series" or it.get("CollectionType") == "tvshows")]
    if raw_items and not items:
        # Fallback if server returns unexpected types despite filters
        items = raw_items
    try:
        print(f"Jellyfin URL: {resp.url} | Shows: {len(items)} (raw {len(raw_items)})", flush=True)
    except Exception:
        pass
    return items


def download_poster(session, item):
    """Download a poster for a Jellyfin item if missing locally."""
    movie_id = item["Id"]
    title = sanitize_filename(item.get("Name", "Unbenannt"))
    image_tags = item.get("ImageTags", {})
    tag = image_tags.get("Primary")
    out_path = os.path.join(POSTER_DIR, f"{title}.jpg")
    if os.path.exists(out_path):
        return
    if tag:
        poster_url = f"{JELLYFIN_URL}/Items/{movie_id}/Images/Primary?tag={tag}&format=jpg"
    else:
        poster_url = f"{JELLYFIN_URL}/Items/{movie_id}/Images/Primary?format=jpg"
    resp = session.get(poster_url, stream=True)
    if resp.status_code == 200:
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(8192):
                if chunk:
                    f.write(chunk)


def load_state():
    return load_json(Path(STATE_FILE))


def save_state(state):
    save_json(Path(STATE_FILE), state)


def load_swipe_state():
    return load_json(Path(SWIPE_STATE_FILE))


def save_swipe_state(state):
    save_json(Path(SWIPE_STATE_FILE), state)


def ensure_swipe_progress(state: Dict[str, Any]):
    """Guarantee per-person swipe order/progress exists for all persons."""
    movies = state.get("movies") or []
    persons = state.get("persons") or []
    progress = state.get("progress") or {}
    titles = [m.get("title") for m in movies if m.get("title")]
    for p in persons:
        if p not in progress or not progress[p].get("order"):
            progress[p] = {"idx": 0, "done": False, "order": titles.copy()}
    state["progress"] = progress
    return state


# beim Serverstart einen leeren Swipe-State anlegen, falls nicht vorhanden
if not os.path.isfile(SWIPE_STATE_FILE):
    try:
        save_swipe_state(EMPTY_SWIPE_STATE.copy())
    except Exception:
        pass


@app.route("/images/<path:filename>")
def serve_image(filename: str):
    return send_from_directory(POSTER_DIR, filename)


def base_ratings_from_movies(movies):
    ratings = {}
    for item in movies:
        title = item["title"]
        ratings[title] = new_rating()
    return ratings


@app.get("/")
def info():
    return jsonify({"message": "API laeuft", "endpoints": ["/generate", "/state", "/vote", "/reset", "/movies"]})


@app.get("/state")
def get_state():
    state = normalize_ranking_state(load_state())
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    return jsonify({"ok": True, "state": state})

@app.get("/swipe-state")
def get_swipe_state():
    state = load_swipe_state()
    if not state:
        return jsonify({"ok": False, "error": "no swipe state"}), 404
    state = ensure_swipe_progress(state)
    return jsonify({"ok": True, "state": state})

@app.post("/swipe-state")
def set_swipe_state():
    data = request.get_json(silent=True) or {}
    movies = data.get("movies") or []
    progress = data.get("progress") or {}
    persons = data.get("persons") or []
    locked = bool(data.get("locked", False))
    likes = data.get("likes") or {}
    matches = data.get("matches") or []
    try:
        state = {
            "movies": movies,
            "progress": progress,
            "persons": persons,
            "locked": locked,
            "likes": likes,
            "matches": matches,
        }
        ensure_swipe_progress(state)
        save_swipe_state(state)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.post("/swipe-reset")
def swipe_reset():
    try:
        save_swipe_state(EMPTY_SWIPE_STATE.copy())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

@app.post("/rank-confirm")
def rank_confirm():
    state = normalize_ranking_state(load_state())
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    data = request.get_json(silent=True) or {}
    confirmed = bool(data.get("confirmed", True))
    state["rankerConfirmed"] = confirmed
    save_state(state)
    return jsonify({"ok": True, "state": state})

# Optional: expliziter Confirm-Endpunkt
@app.post("/swipe-confirm")
def swipe_confirm():
    data = request.get_json(silent=True) or {}
    movies = data.get("movies") or []
    persons = data.get("persons") or []
    progress = data.get("progress") or {}
    try:
        state = {
            "movies": movies,
            "progress": progress,
            "persons": persons,
            "locked": True,
            "likes": {},
            "matches": [],
        }
        ensure_swipe_progress(state)
        save_swipe_state(state)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/saves")
def list_saves_endpoint():
    try:
        return jsonify({"ok": True, "saves": list_saves()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/save-state")
def save_state_snapshot():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    try:
        saved_name = create_save_snapshot(name)
        return jsonify({"ok": True, "name": saved_name, "saves": list_saves()})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/load-state")
def load_state_snapshot():
    data = request.get_json(silent=True) or {}
    name = data.get("name")
    if not name:
        return jsonify({"ok": False, "error": "name required"}), 400
    try:
        state = load_save_snapshot(name)
        return jsonify({"ok": True, "state": state, "name": sanitize_save_name(name)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/reset-all")
def reset_all():
    """Reset ranker and swipe state and clear posters."""
    try:
        save_state({
            "movies": [],
            "ratings": {},
            "comparisonCount": {},
            "totalVotes": 0,
            "personCount": 1,
            "filters": [],
            "runtimeMin": 20,
            "runtimeMax": 300,
            "criticMin": 0,
            "criticMax": 10,
            "yearMin": 1950,
            "yearMax": None,
            "rankerConfirmed": False,
            "pairCounts": {},
            "pairCoverage": {"coveredPairs": 0, "totalPairs": 0, "ratio": 0},
            "pairCoveragePerPerson": {},
            "tsConfig": current_ts_config(),
        })
        save_swipe_state(EMPTY_SWIPE_STATE.copy())
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/swipe-action")
def swipe_action():
    data = request.get_json(silent=True) or {}
    decision = data.get("decision")
    title = data.get("title")
    person = data.get("person") or "p1"
    state = load_swipe_state()
    if not state:
        return jsonify({"ok": False, "error": "no swipe state"}), 404
    ensure_swipe_progress(state)
    movies = state.get("movies") or []
    persons = state.get("persons") or []
    progress = state.get("progress") or {}
    likes = state.get("likes") or {}
    matches = set(state.get("matches") or [])
    if decision not in ("Ja", "Yes", "Nein", "No"):
        return jsonify({"ok": False, "error": "invalid decision"}), 400
    # Progress update
    if person not in progress:
        progress[person] = {"idx": 0, "done": False, "order": [m.get("title") for m in movies if m.get("title")]}
    order = progress[person].get("order") or []
    idx = min(progress[person].get("idx", 0), max(len(order) - 1, 0))
    if idx < len(order):
        current_title = order[idx]
        if decision.lower().startswith("j"):  # yes
            likes.setdefault(current_title, [])
            if person not in likes[current_title]:
                likes[current_title].append(person)
            if len(likes[current_title]) >= max(1, len(persons)):
                matches.add(current_title)
        # advance
        idx += 1
    progress[person]["idx"] = idx
    progress[person]["done"] = idx >= len(order)
    state.update({"progress": progress, "likes": likes, "matches": list(matches)})
    save_swipe_state(state)
    return jsonify({"ok": True, "state": state})


@app.post("/vote")
def vote():
    data = request.get_json(silent=True) or {}
    winner_title = data.get("winner")
    loser_title = data.get("loser")
    current_person = data.get("person") or "person1"
    state = normalize_ranking_state(load_state())
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    ratings = state.get("ratings", {})
    if winner_title not in ratings or loser_title not in ratings:
        return jsonify({"ok": False, "error": "unknown title"}), 400
    ratings[winner_title] = ensure_rating(ratings[winner_title])
    ratings[loser_title] = ensure_rating(ratings[loser_title])
    update_trueskill(ratings[winner_title], ratings[loser_title])
    comp = state.get("comparisonCount", {})
    comp[current_person] = comp.get(current_person, 0) + 1
    state["ratings"] = ratings
    state["comparisonCount"] = comp
    state["totalVotes"] = state.get("totalVotes", 0) + 1
    record_pair_result(state, current_person, winner_title, loser_title)
    compute_pair_coverage(state)
    save_state(state)
    return jsonify({"ok": True, "state": state})


@app.post("/generate")
def generate():
    data = request.get_json(silent=True) or {}
    filters = data.get("filters") or []
    runtime_min = data.get("runtimeMin")
    runtime_max = data.get("runtimeMax")
    critic_min = data.get("criticMin")
    critic_max = data.get("criticMax")
    year_min = data.get("yearMin")
    year_max = data.get("yearMax")
    max_movies = int(data.get("maxMovies") or 0)
    person_count = data.get("personCount") or 1
    lang = (data.get("lang") or "en").lower()
    tmdb_key = data.get("tmdbKey") or TMDB_API_KEY
    translate_titles = bool(tmdb_key) and lang != "en"
    tmdb_session = None
    if translate_titles:
        tmdb_session = requests.Session()
        tmdb_session.params = {"api_key": tmdb_key}
    try:
        clear_poster_dir()
        movies_raw = fetch_movies(filters, runtime_min, runtime_max, critic_min, critic_max, year_min, year_max)
        if max_movies > 0 and len(movies_raw) > max_movies:
            movies_raw = random.sample(movies_raw, max_movies)
        # CSV speichern
        with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["title"])
            for item in movies_raw:
                raw_title = item.get("Name", "Unbenannt")
                file_title = sanitize_filename(raw_title)
                display_title = file_title
                if translate_titles and tmdb_session:
                    translated = resolve_tmdb_title(tmdb_session, item, lang)
                    if translated:
                        display_title = sanitize_filename(translated)
                w.writerow([display_title])

        # Poster laden
        session = requests.Session()
        session.headers.update({"X-Emby-Token": API_KEY})
        for item in movies_raw:
            download_poster(session, item)

        movie_list = []
        for item in movies_raw:
            raw_title = item.get("Name", "Unbenannt")
            file_title = sanitize_filename(raw_title)
            display_title = file_title
            if translate_titles and tmdb_session:
                translated = resolve_tmdb_title(tmdb_session, item, lang)
                if translated:
                    display_title = sanitize_filename(translated)
            year = item.get("ProductionYear")
            movie_list.append({"title": display_title, "display": display_title, "image": file_title + ".jpg", "year": year})

        ratings = base_ratings_from_movies(movie_list)
        state = {
            "movies": movie_list,
            "ratings": ratings,
            "comparisonCount": {},
            "totalVotes": 0,
            "personCount": person_count,
            "filters": filters,
            "runtimeMin": runtime_min,
            "runtimeMax": runtime_max,
            "criticMin": critic_min,
            "criticMax": critic_max,
            "yearMin": year_min,
            "yearMax": year_max,
            "rankerConfirmed": False,
            "pairCounts": {},
            "tsConfig": current_ts_config(),
        }
        compute_pair_coverage(state)
        save_state(state)
        return jsonify({"ok": True, "count": len(movie_list)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/add-shows")
def add_shows():
    data = request.get_json(silent=True) or {}
    lang = (data.get("lang") or "en").lower()
    tmdb_key = data.get("tmdbKey") or TMDB_API_KEY
    translate_titles = bool(tmdb_key) and lang != "en"
    tmdb_session = None
    if translate_titles:
        tmdb_session = requests.Session()
        tmdb_session.params = {"api_key": tmdb_key}
    try:
        stored_state = normalize_ranking_state(load_state()) or {}
        person_count = max(1, int(stored_state.get("personCount") or data.get("personCount") or 1))
        # Hard reset state so repeated fetches do not accumulate entries.
        state = {
            "movies": [],
            "ratings": {},
            "comparisonCount": {f"person{i+1}": 0 for i in range(person_count)},
            "totalVotes": 0,
            "personCount": person_count,
            "filters": [],
            "runtimeMin": None,
            "runtimeMax": None,
            "criticMin": None,
            "criticMax": None,
            "yearMin": None,
            "yearMax": None,
            "rankerConfirmed": False,
            "pairCounts": {},
            "tsConfig": current_ts_config(),
        }
        clear_poster_dir()
        existing_movies: List[Dict[str, Any]] = []
        existing_titles = set()
        existing_ids = set()
        movies_raw = fetch_shows()
        session = requests.Session()
        session.headers.update({"X-Emby-Token": API_KEY})
        added = 0
        for item in movies_raw:
            raw_title = item.get("Name", "Unbenannt")
            file_title = sanitize_filename(raw_title)
            jellyfin_id = item.get("Id")
            item_type = (item.get("Type") or "").lower()
            collection_type = (item.get("CollectionType") or "").lower()
            if item_type == "movie" or collection_type == "movies":
                continue
            if item_type and item_type not in {"series", "season", "episode", "boxset"} and collection_type != "tvshows":
                continue
            if jellyfin_id and jellyfin_id in existing_ids:
                continue
            if not file_title or file_title in existing_titles:
                continue
            display_title = file_title
            if translate_titles and tmdb_session:
                translated = resolve_tmdb_title(tmdb_session, item, lang)
                if translated:
                    display_title = sanitize_filename(translated)
            year = item.get("ProductionYear")
            download_poster(session, item)
            entry = {
                "title": file_title,
                "display": display_title,
                "image": f"{file_title}.jpg",
                "year": year,
                "jellyfinId": jellyfin_id,
                "source": "jellyfin",
            }
            existing_movies.append(entry)
            existing_titles.add(file_title)
            if jellyfin_id:
                existing_ids.add(jellyfin_id)
            if file_title not in state["ratings"]:
                state["ratings"][file_title] = new_rating()
            added += 1
        state["movies"] = existing_movies
        state["rankerConfirmed"] = False
        compute_pair_coverage(state)
        save_state(state)
        return jsonify({"ok": True, "added": added, "total": len(existing_movies), "state": state})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/load-csv")
def load_csv_endpoint():
    try:
        state = normalize_ranking_state(load_movies_from_csv())
        return jsonify({"ok": True, "count": len(state.get("movies") or []), "state": state})
    except FileNotFoundError:
        return jsonify({"ok": False, "error": f"{OUTPUT_CSV} not found"}), 404
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/reset")
def reset_state():
    data = request.get_json(silent=True) or {}
    state = normalize_ranking_state(load_state())
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    movies = state.get("movies", [])
    person_count = max(1, int(data.get("personCount") or state.get("personCount") or 1))
    ratings = base_ratings_from_movies(movies)
    comparison = {f"person{i+1}": 0 for i in range(person_count)}
    state.update({
        "ratings": ratings,
        "comparisonCount": comparison,
        "totalVotes": 0,
        "personCount": person_count,
        "rankerConfirmed": False,
        "pairCounts": {},
        "tsConfig": current_ts_config(),
    })
    compute_pair_coverage(state)
    save_state(state)
    return jsonify({"ok": True, "state": state})


@app.get("/movies")
def list_movies():
    try:
        lang = (request.args.get("lang") or "en").lower()
        tmdb_key = request.args.get("tmdbKey") or TMDB_API_KEY
        translate_titles = bool(tmdb_key) and lang != "en"
        tmdb_session = None
        if translate_titles:
            tmdb_session = requests.Session()
            tmdb_session.params = {"api_key": tmdb_key}

        items = fetch_movies([], limit=5000)
        results = []
        for item in items:
            raw_title = item.get("Name", "Unbenannt")
            title = sanitize_filename(raw_title)
            display_title = title
            if translate_titles and tmdb_session:
                translated = resolve_tmdb_title(tmdb_session, item, lang)
                if translated:
                    display_title = translated
            image_tags = item.get("ImageTags", {})
            tag = image_tags.get("Primary")
            if tag:
                image_url = f"{JELLYFIN_URL}/Items/{item['Id']}/Images/Primary?tag={tag}&format=jpg&X-Emby-Token={API_KEY}"
            else:
                image_url = f"{JELLYFIN_URL}/Items/{item['Id']}/Images/Primary?format=jpg&X-Emby-Token={API_KEY}"
            year = item.get("ProductionYear")
            results.append({"title": display_title, "display": display_title, "image": image_url, "year": year})
        return jsonify({"ok": True, "items": results, "lang": lang, "translated": translate_titles})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.get("/client-config")
def client_config():
    return jsonify({"tmdbKeyConfigured": bool(TMDB_API_KEY)})


@app.post("/debug-log")
def debug_log_endpoint():
    """Append frontend debug messages to debug log file."""
    data = request.get_json(silent=True) or {}
    msg = data.get("message", "")
    extra = data.get("data") if isinstance(data.get("data"), dict) else None
    append_debug_log(msg or "no-message", extra)
    return jsonify({"ok": True})


@app.post("/client-log")
def client_log_endpoint():
    """General client logging endpoint; writes to <category>.log."""
    data = request.get_json(silent=True) or {}
    category = data.get("category") or "frontend"
    msg = data.get("message") or "no-message"
    extra = data.get("data") if isinstance(data.get("data"), dict) else None
    log_event(category, msg, extra)
    return jsonify({"ok": True})


if __name__ == "__main__":
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False)
