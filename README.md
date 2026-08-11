# Raja Fraz — Fronus Matrix 6K Cloud Dashboard

Final GitHub + Render project for the Fronus Matrix 6K using the SOLARMAN Business API.

The frontend follows the same layout and styling as the existing Raja Fraz / former InverterZone dashboard, with Matrix-specific Battery and Smart Load support.

## Dashboard features

- Dashboard, Charts, Totals, Power, Alerts and Configuration pages
- Same semicircular gauges and chart layout as the reference dashboard
- 10-second live refresh by default
- PV1 / PV2, solar, house load and signed grid import/export
- Battery SOC, voltage, power, charge/discharge state and temperature
- Smart Load / physical GEN port shown as AC / Motor heavy load
- Transformer and radiator temperatures
- Daily SOLARMAN energy totals
- Hosted one-minute history collector
- Gujrat, Pakistan weather
- Automatic SOLARMAN Business-token generation and retry on invalid/expired tokens

## Render Blueprint

Upload the complete project to the existing `fronus-matrix-dashboard` GitHub repository and let Render redeploy it.

The Blueprint asks for these secrets:

- `SOLARMAN_APP_ID`
- `SOLARMAN_APP_SECRET`
- `SOLARMAN_EMAIL`
- `SOLARMAN_PASSWORD_HASH`

The following are already configured in `render.yaml`:

- `SOLARMAN_BASE_URL=https://globalapi.solarmanpv.com`
- `SOLARMAN_ORG_ID=195093`
- `SOLARMAN_DEVICE_SN=0230306052`
- `SOLARMAN_STATION_ID=3332398`
- `ELECTRICITY_RATE_PKR=60`

Keep secrets only in Render Environment. Do not commit them to GitHub.

## Smart Load

SOLARMAN names the physical GEN-port registers as generator data. On this installation the GEN port is used as Smart Load for AC / motor / heavy load, so the dashboard labels it **Smart Load**.

## History note

Render Free instances can sleep and their local filesystem can be reset. Live monitoring remains functional, but long-term persistent charts require persistent storage or an external database.
