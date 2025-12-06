# Jellyfin Movies – Configuration

## Files

- `.env` (local, not committed) / `.env.example` (template): `JELLYFIN_URL`, `JELLYFIN_API_KEY`, `JELLYFIN_USER_ID`, `TMDB_API_KEY`, `SERVER_PORT`. Copy `.env.example` to `.env` and fill in your values.
- `config/server.json`: Backend defaults (poster/state paths, base rating, default R factor, host/port, allowed CORS origins, asset base). Non-secret; keys should stay in `.env`.
- `config/client.json`: Frontend defaults (API base/port, default tab, filter presets and slider ranges for Ranking & Swipe, swipe polling interval).
- `i18n.json`: UI translations and language defaults.

## Precedence

- Backend: Environment variables (`.env` or real ENV) override `config/server.json`, which falls back to built-in defaults.
- Frontend: `config/client.json` overrides built-in defaults when loaded in the browser.

## Notes

- `.env` is ignored by Git to avoid leaking keys.
- If you change the server port, update `SERVER_PORT` in `.env` and `api.port`/`api.base` in `config/client.json` accordingly.
- Restrict CORS via `allowedOrigins` in `config/server.json`, e.g. `["http://localhost:3000"]`.
