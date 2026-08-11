# Fronus Matrix 6K — InverterZone Cloud Dashboard

Cloud-ready SOLARMAN Business dashboard styled to match the existing InverterZone / Fronus Meta PV9000 dashboard.

## Included
- Dashboard / Charts / Totals / Power / Alerts / Configuration tabs
- 10-second live polling
- SOLARMAN Business token generated automatically on the backend
- PV1/PV2, inverter, grid, load, battery, Smart Load (physical GEN port)
- Browser-session live charts
- Gujrat weather
- Health / alarm summary
- No SOLARMAN secrets are exposed to the browser

## GitHub + Render
Upload server.js, package.json, render.yaml, README.md and public/index.html to a new GitHub repository.

Render settings:
- Runtime: Node
- Build command: npm install
- Start command: npm start

Environment variables:
- SOLARMAN_BASE_URL=https://globalapi.solarmanpv.com
- SOLARMAN_APP_ID=<your app id>
- SOLARMAN_APP_SECRET=<your app secret>
- SOLARMAN_EMAIL=<your SOLARMAN Business email>
- SOLARMAN_PASSWORD_HASH=<your lowercase SHA-256 login password>
- SOLARMAN_ORG_ID=195093
- SOLARMAN_DEVICE_SN=0230306052
- SOLARMAN_STATION_ID=3332398

Do not commit APP_SECRET or PASSWORD_HASH to GitHub.

## Smart Load
The inverter's physical GEN port is used as Smart Load for AC/motor/heavy loads. SOLARMAN still exposes generator-style field names, so the dashboard relabels them as Smart Load and keeps the raw signed power in the Power tab for verification.

## Refresh
Frontend polls every 10 seconds. Duplicate SOLARMAN collectionTime values are not added twice to charts.
