import os
import csv
import re
import requests
import shutil

# ==== KONFIGURATION ANPASSEN ====
JELLYFIN_URL = "http://localhost:8096"  # deine Jellyfin-URL
API_KEY = "585a1302cfb64f209fc65e1fb3ab1dc3"          # dein API-Key
USER_ID = "b5ef4872dd5445a6934f00e99b88bc8b"         # dein User-Id

OUTPUT_CSV = "movies.csv"
POSTER_DIR = "images"

# ================================

os.makedirs(POSTER_DIR, exist_ok=True)

session = requests.Session()
session.headers.update({
    "X-Emby-Token": API_KEY
})

def sanitize_filename(name: str) -> str:
    """
    Entfernt problematische Zeichen aus Dateinamen, behalt aber Leerzeichen bei.
    Reduziert mehrfachen Whitespace auf ein Leerzeichen und trimmt Rander.
    """
    name = re.sub(r'[\\/*?:"<>|,]', '', name)
    name = name.strip()
    name = re.sub(r'\s+', ' ', name)
    if len(name) > 150:
        name = name[:150]
    return name or "unbenannt"

def make_safe_title(item):
    """
    Liefert:
      - original_title: wie Jellyfin ihn liefert
      - safe_title: bereinigt fuer Dateinamen (Leerzeichen bleiben)
    """
    original_title = item.get("Name", "Unbenannt")
    safe_title = sanitize_filename(original_title)
    return original_title, safe_title

def get_unplayed_movies():
    url = f"{JELLYFIN_URL}/Users/{USER_ID}/Items"
    params = {
        "IncludeItemTypes": "Movie",
        "Recursive": "true",
        "Filters": "IsUnplayed",
        "SortBy": "SortName",
        "SortOrder": "Ascending",
        "Limit": 10000
    }
    resp = session.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()
    return data.get("Items", [])

def download_poster(item):
    movie_id = item["Id"]
    original_title, safe_title = make_safe_title(item)

    image_tags = item.get("ImageTags", {})
    primary_tag = image_tags.get("Primary")

    out_path = os.path.join(POSTER_DIR, f"{safe_title}.jpg")

    if os.path.exists(out_path):
        print(f"Poster existiert schon, ueberspringe: {out_path}")
        return

    if primary_tag:
        poster_url = f"{JELLYFIN_URL}/Items/{movie_id}/Images/Primary?tag={primary_tag}&format=jpg"
    else:
        poster_url = f"{JELLYFIN_URL}/Items/{movie_id}/Images/Primary?format=jpg"

    resp = session.get(poster_url, stream=True)
    if resp.status_code == 200:
        with open(out_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        print(f"Poster gespeichert: {out_path}")
    else:
        print(f"Kein Poster gefunden fuer '{original_title}' (HTTP {resp.status_code})")

def clear_poster_dir():
    """Loescht den Poster-Ordner und legt ihn leer neu an."""
    if os.path.isdir(POSTER_DIR):
        shutil.rmtree(POSTER_DIR)
    os.makedirs(POSTER_DIR, exist_ok=True)
    print(f"Poster-Ordner geleert: {POSTER_DIR}")

def main():
    print("Hole ungespielte Filme aus Jellyfin...")
    movies = get_unplayed_movies()
    print(f"{len(movies)} ungespielte Filme gefunden.")

    clear_poster_dir()

    with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(["title"])
        for item in movies:
            _, safe_title = make_safe_title(item)
            writer.writerow([safe_title])

    print(f"CSV geschrieben: {OUTPUT_CSV}")

    for item in movies:
        download_poster(item)

    print("Fertig!")

if __name__ == "__main__":
    main()
