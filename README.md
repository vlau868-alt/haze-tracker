# Haze Tracker

An installable web app (PWA) showing the latest 24-hr PSI and 1-hr PM2.5 for each region of Singapore, using NEA's real-time data from data.gov.sg. Set a region, a measure and a threshold to get a notification when the reading reaches it.

No build step. Plain HTML/CSS/JS.

## Run

PWAs need HTTPS (or localhost). Locally: `python3 -m http.server 8000` then open http://localhost:8000.
To host it, enable GitHub Pages on this repo (Settings > Pages > deploy from `main`, root).

## Notes

- Data: `api-open.data.gov.sg/v2/real-time/api/psi` (24-hr PSI) and `.../pm25` (1-hr PM2.5). NEA does not publish an hourly PSI.
- Alerts fire when a reading moves from below to at/above the threshold, not on every refresh.
- Notifications are local (no push server). Chrome on Android with the app installed can check about hourly in the background. Elsewhere, including iPhone, alerts are delivered only while the app is open.
- `icons/` holds the SVG source and PNG renders.
