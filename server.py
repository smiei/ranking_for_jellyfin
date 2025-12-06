import csv
import glob
import json
import math
import os
import re
import shutil
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple

import requests
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS

ROOT = Path(__file__).resolve().parent
CONFIG_DIR = ROOT / "config"
ENV_PATH = ROOT / ".env"


def load_env_file(path: Path) -> Dict[str, str]:
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
    if not path.is_file():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


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
BASE_RATING = int(server_cfg.get("baseRating", 1500))
DEFAULT_R = int(server_cfg.get("defaultR", 2))
SERVER_HOST = server_cfg.get("host", "0.0.0.0")
SERVER_PORT = int(env.get("SERVER_PORT", server_cfg.get("port", 5000)))
ALLOWED_ORIGINS = server_cfg.get("allowedOrigins") or "*"
# =======================

app = Flask(__name__)
CORS(app, origins=ALLOWED_ORIGINS)
os.makedirs(POSTER_DIR, exist_ok=True)

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


def sanitize_filename(name: str) -> str:
    name = re.sub(r'[\\/*?:"<>|,]', '', name).strip()
    name = re.sub(r'\s+', ' ', name)
    return name[:150] if name else "unbenannt"


def tmdb_title_by_id(session: requests.Session, tmdb_id: str, lang: str) -> Optional[str]:
    try:
        resp = session.get(f"{TMDB_API_URL}/movie/{tmdb_id}", params={"language": lang}, timeout=8)
        if resp.status_code == 200:
            data = resp.json()
            return data.get("title") or data.get("original_title") or data.get("name")
    except Exception:
        return None
    return None


def tmdb_title_by_search(session: requests.Session, title: str, year: Optional[int], lang: str) -> Optional[str]:
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


def minutes_to_ticks(val: Optional[float]) -> Optional[int]:
    if val is None:
        return None
    try:
        return int(float(val) * 60 * 10_000_000)
    except Exception:
        return None


def expected_score(rA, rB):
    return 1 / (1 + math.pow(10, (rB - rA) / 400))


def k_factor(games):
    return 32 * max(0.35, 1 / math.sqrt(games + 1))


def update_elo(winner, loser):
    exp_w = expected_score(winner["rating"], loser["rating"])
    exp_l = 1 - exp_w
    k_w = k_factor(winner["games"])
    k_l = k_factor(loser["games"])
    winner["rating"] += k_w * (1 - exp_w)
    loser["rating"] += k_l * (0 - exp_l)
    winner["games"] += 1
    loser["games"] += 1
    winner["wins"] += 1


def fetch_movies(filters: List[str], runtime_min=None, runtime_max=None, critic_min=None, critic_max=None,
                 year_min=None, year_max=None, limit=10000) -> List[Dict[str, Any]]:
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


def download_poster(session, item):
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
    if not os.path.isfile(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def load_swipe_state():
    if not os.path.isfile(SWIPE_STATE_FILE):
        return None
    try:
        with open(SWIPE_STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_swipe_state(state):
    with open(SWIPE_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)


def ensure_swipe_progress(state: Dict[str, Any]):
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
        ratings[title] = {"rating": BASE_RATING, "games": 0, "wins": 0}
    return ratings


@app.get("/")
def info():
    return jsonify({"message": "API laeuft", "endpoints": ["/generate", "/state", "/vote", "/reset", "/movies"]})


@app.get("/state")
def get_state():
    state = load_state()
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
    state = load_state()
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


@app.post("/reset-all")
def reset_all():
    """Reset ranker and swipe state and clear posters."""
    try:
        clear_poster_dir()
        save_state({
            "movies": [],
            "ratings": {},
            "comparisonCount": {},
            "totalVotes": 0,
            "personCount": 1,
            "rFactor": DEFAULT_R,
            "filters": [],
            "runtimeMin": 20,
            "runtimeMax": 300,
            "criticMin": 0,
            "criticMax": 10,
            "yearMin": 1950,
            "yearMax": None,
            "rankerConfirmed": False,
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
    r_factor = data.get("rFactor")
    state = load_state()
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    ratings = state.get("ratings", {})
    if winner_title not in ratings or loser_title not in ratings:
        return jsonify({"ok": False, "error": "unknown title"}), 400
    update_elo(ratings[winner_title], ratings[loser_title])
    comp = state.get("comparisonCount", {})
    comp[current_person] = comp.get(current_person, 0) + 1
    state["ratings"] = ratings
    state["comparisonCount"] = comp
    state["totalVotes"] = state.get("totalVotes", 0) + 1
    if r_factor is not None:
        state["rFactor"] = max(DEFAULT_R, int(r_factor))
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
    person_count = data.get("personCount") or 1
    r_factor = data.get("rFactor") or DEFAULT_R
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
            movie_list.append({"title": display_title, "display": display_title, "image": file_title + ".jpg"})

        ratings = base_ratings_from_movies(movie_list)
        state = {
            "movies": movie_list,
            "ratings": ratings,
            "comparisonCount": {},
            "totalVotes": 0,
            "personCount": person_count,
            "rFactor": r_factor,
            "filters": filters,
            "runtimeMin": runtime_min,
            "runtimeMax": runtime_max,
            "criticMin": critic_min,
            "criticMax": critic_max,
            "yearMin": year_min,
            "yearMax": year_max,
            "rankerConfirmed": False,
        }
        save_state(state)
        return jsonify({"ok": True, "count": len(movie_list)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.post("/reset")
def reset_state():
    data = request.get_json(silent=True) or {}
    state = load_state()
    if not state:
        return jsonify({"ok": False, "error": "no state"}), 404
    movies = state.get("movies", [])
    person_count = max(1, int(data.get("personCount") or state.get("personCount") or 1))
    r_factor = max(DEFAULT_R, int(data.get("rFactor") or state.get("rFactor") or DEFAULT_R))
    ratings = base_ratings_from_movies(movies)
    comparison = {f"person{i+1}": 0 for i in range(person_count)}
    state.update({
        "ratings": ratings,
        "comparisonCount": comparison,
        "totalVotes": 0,
        "personCount": person_count,
        "rFactor": r_factor,
        "rankerConfirmed": False,
    })
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


if __name__ == "__main__":
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=False)
