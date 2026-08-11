import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = Number(process.env.PORT || 10000);

const BASE_URL = process.env.SOLARMAN_BASE_URL || "https://globalapi.solarmanpv.com";
const APP_ID = process.env.SOLARMAN_APP_ID || "";
const APP_SECRET = process.env.SOLARMAN_APP_SECRET || "";
const EMAIL = process.env.SOLARMAN_EMAIL || "";
const PASSWORD_HASH = process.env.SOLARMAN_PASSWORD_HASH || "";
const ORG_ID = Number(process.env.SOLARMAN_ORG_ID || 195093);
const DEVICE_SN = process.env.SOLARMAN_DEVICE_SN || "0230306052";
const STATION_ID = Number(process.env.SOLARMAN_STATION_ID || 3332398);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const HISTORY_FILE = path.join(DATA_DIR, "history.json");
const ALERTS_FILE = path.join(DATA_DIR, "alerts.json");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "app")));

let tokenCache = { token: "", expiresAt: 0 };
let liveCache = { at: 0, data: null };
let weatherCache = { at: 0, data: null };
let collecting = false;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2)); } catch (e) { console.error("write failed", file, e.message); }
}
function number(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function valueMap(dataList = []) {
  const out = {};
  for (const row of dataList) out[row.key] = { value: row.value, unit: row.unit, name: row.name };
  return out;
}
function n(m, key) { return number(m[key]?.value); }
function s(m, key) { const v = m[key]?.value; return v == null ? null : String(v); }

async function requestToken(force = false) {
  if (!force && tokenCache.token && Date.now() < tokenCache.expiresAt - 300000) return tokenCache.token;
  if (!APP_ID || !APP_SECRET || !EMAIL || !PASSWORD_HASH) throw new Error("Missing SOLARMAN credentials in Render environment");

  const url = `${BASE_URL}/account/v1.0/token?appId=${encodeURIComponent(APP_ID)}&language=en`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ appSecret: APP_SECRET, email: EMAIL, password: PASSWORD_HASH, orgId: ORG_ID })
  });
  const data = await response.json();
  if (!data.success || !data.access_token) throw new Error(data.msg || data.message || "SOLARMAN authentication failed");
  tokenCache = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return tokenCache.token;
}

function looksLikeAuthError(data) {
  const msg = String(data?.msg || data?.message || data?.code || "").toLowerCase();
  return msg.includes("auth") || msg.includes("token") || msg.includes("401") || msg.includes("unauthor");
}

async function solarmanPost(apiPath, body) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = await requestToken(attempt === 1);
    const response = await fetch(`${BASE_URL}${apiPath}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `bearer ${token}` },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (data?.success) return data;
    if (attempt === 0 && (response.status === 401 || looksLikeAuthError(data))) {
      tokenCache = { token: "", expiresAt: 0 };
      continue;
    }
    throw new Error(data?.msg || data?.message || `SOLARMAN request failed (${response.status})`);
  }
  throw new Error("SOLARMAN authentication failed after token refresh");
}

function normaliseCurrent(raw) {
  const m = valueMap(raw.dataList || []);
  const pv1W = n(m, "DP1") || 0;
  const pv2W = n(m, "DP2") || 0;
  const solarW = pv1W + pv2W + (n(m, "DP3") || 0) + (n(m, "DP4") || 0);
  const loadW = n(m, "E_Puse_t1") ?? n(m, "I_O_P_LN") ?? 0;
  const ctRaw = n(m, "CT_P_T");
  const reportedGrid = n(m, "PG_Pt1") || 0;
  // On this Matrix installation CT_P_T < 0 means utility import, > 0 means export.
  const gridW = ctRaw == null ? reportedGrid : (ctRaw < 0 ? Math.abs(ctRaw) : ctRaw > 0 ? -Math.abs(ctRaw) : 0);
  const batteryRaw = n(m, "B_Pdcg1");
  const batterySoc = n(m, "B_R_C");
  const batteryV = n(m, "B_V1");
  const smartRaw = n(m, "GEN_P_T");
  const faultCodes = [s(m,"Fault_Code1"),s(m,"Fault_Code2"),s(m,"Fault_Code3"),s(m,"Fault_Code4")].filter(Boolean).filter(x => x.trim());
  const alarm = (n(m,"INV_ERR_STin1") || 0) || (n(m,"INV_ERR_STin2") || 0);
  const transformer = n(m, "T_TFM1");
  const radiator = n(m, "T_RDT1");
  const batteryTemp = n(m, "B_T1");
  const collectionMs = Number(raw.collectionTime || 0) * 1000;

  return {
    deviceId: raw.deviceSn || DEVICE_SN,
    name: "Fronus Matrix 6K",
    model: "Fronus Matrix 6K",
    protocol: "SOLARMAN Business API",
    firmware: s(m,"ARMv1") || s(m,"DSPv2") || "Not supplied",
    inverterSoftware: s(m,"DSPv2") || "Not supplied",
    netMetering: "Enabled",
    realTime: collectionMs ? new Date(collectionMs).toISOString() : new Date().toISOString(),
    receivedAt: collectionMs || Date.now(),

    solarW,
    solarWatts: solarW,
    solarV: (n(m,"DV1") || 0) + (n(m,"DV2") || 0),
    solarVoltage: (n(m,"DV1") || 0) + (n(m,"DV2") || 0),
    solarW1: pv1W,
    pv1Watts: pv1W,
    solarV1: n(m,"DV1"),
    pv1Voltage: n(m,"DV1"),
    solarA1: n(m,"DC1"),
    pv1Ampere: n(m,"DC1"),
    solarW2: pv2W,
    pv2Watts: pv2W,
    solarV2: n(m,"DV2"),
    pv2Voltage: n(m,"DV2"),
    solarA2: n(m,"DC2"),
    pv2Ampere: n(m,"DC2"),

    acOutW: loadW,
    loadWatts: loadW,
    acOutVa: loadW,
    loadVa: loadW,
    acOutV: n(m,"C_V_L1") ?? n(m,"I_V_LN"),
    loadVoltage: n(m,"C_V_L1") ?? n(m,"I_V_LN"),
    acOutHz: n(m,"I_O_F1"),
    loadHz: n(m,"I_O_F1"),
    loadAmpere: n(m,"E_Cuse1") || ((n(m,"C_V_L1") || 0) > 1 ? loadW / n(m,"C_V_L1") : null),
    acOutPercent: Math.max(0, Math.min(100, loadW / 6000 * 100)),

    gridW,
    gridWatts: gridW,
    gridV: n(m,"G_V_L1") ?? n(m,"G_V_LN"),
    gridVoltage: n(m,"G_V_L1") ?? n(m,"G_V_LN"),
    gridAmpere: n(m,"G_C_L1"),
    gridHz: n(m,"PG_F1"),

    battV: batteryV,
    batteryVoltage: batteryV,
    battPercent: batterySoc,
    batteryPercentage: batterySoc,
    batteryCurrent: n(m,"B_C1"),
    batteryPowerWatts: batteryRaw == null ? null : Math.abs(batteryRaw),
    batteryPowerRawWatts: batteryRaw,
    batteryMode: batteryRaw == null || Math.abs(batteryRaw) < 20 ? "IDLE" : batteryRaw < 0 ? "CHARGING" : "DISCHARGING",
    batteryTemperature: batteryTemp,
    transformerTemperature: transformer,
    radiatorTemperature: radiator,

    smartLoadWatts: smartRaw == null ? 0 : Math.abs(smartRaw),
    smartLoadRawWatts: smartRaw,
    smartLoadActive: smartRaw != null && Math.abs(smartRaw) >= 50,
    smartLoadRelay: n(m,"ST_EG_RELAY1"),

    inverterOutputWatts: n(m,"I_O_P_LN"),
    inverterVoltage: n(m,"I_V_LN"),
    inverterFrequency: n(m,"I_O_F1"),
    ratedPowerWatts: n(m,"Pr1") || 6000,
    inverterTemperature: radiator,
    heatSinkDegC: Math.max(Number(transformer || 0), Number(radiator || 0)),
    heatSinkTemperature: Math.max(Number(transformer || 0), Number(radiator || 0)),
    busVoltage: n(m,"BUS_VOL"),
    signal: null,
    fault: faultCodes.length ? faultCodes.join(", ") : alarm ? `Alarm ${alarm}` : "NO",
    inverterMode: String(n(m,"RS_D") ?? ""),
    outputSource: "Hybrid output",
    inputVoltageType: "PV + Grid + Battery",

    todaySolar: n(m,"PVDE") ?? n(m,"Etdy_ge1") ?? 0,
    todayLoad: n(m,"Etdy_use1") ?? 0,
    todayGrid: n(m,"Etdy_pu1") ?? n(m,"E_B_D") ?? 0,
    todayNetGrid: n(m,"t_gc_tdy1") ?? n(m,"GRID_C_D") ?? 0,
    totalSolar: n(m,"E_PVhis_ge1") ?? 0,
    totalLoad: n(m,"Et_use1") ?? 0,
    totalGridImport: n(m,"Et_pu1") ?? n(m,"E_B_TO") ?? 0,
    totalGridExport: n(m,"t_gc1") ?? 0,
    todayBatteryCharge: n(m,"Etdy_cg1") ?? 0,
    todayBatteryDischarge: n(m,"Etdy_dcg1") ?? 0,
    totalBatteryCharge: n(m,"t_cg_n1") ?? 0,
    totalBatteryDischarge: n(m,"t_dcg_n1") ?? 0,
    todaySmartLoad: n(m,"GEN_P_D") ?? 0,
    totalSmartLoad: n(m,"EG_t_ge1") ?? 0,
    raw: m
  };
}

async function fetchLive(force = false) {
  if (!force && liveCache.data && Date.now() - liveCache.at < 4000) return liveCache.data;
  const raw = await solarmanPost("/device/v1.0/currentData?language=en", { deviceSn: DEVICE_SN });
  const data = normaliseCurrent(raw);
  liveCache = { at: Date.now(), data };
  return data;
}

function historyPoint(r) {
  return {
    timestamp: Number(r.receivedAt) || Date.now(), solarW: r.solarWatts || 0, pv1W: r.pv1Watts || 0, pv2W: r.pv2Watts || 0,
    loadW: r.loadWatts || 0, gridW: r.gridWatts || 0, gridV: r.gridVoltage || 0, outputV: r.loadVoltage || 0,
    temperature: r.heatSinkTemperature || 0, fan: 0, batterySoc: r.batteryPercentage || 0, smartLoadW: r.smartLoadWatts || 0,
    todaySolar: r.todaySolar || 0, todayLoad: r.todayLoad || 0, todayGrid: r.todayGrid || 0, todayNetGrid: r.todayNetGrid || 0
  };
}

async function collectSample() {
  if (collecting) return;
  collecting = true;
  try {
    const r = await fetchLive(true);
    const history = readJson(HISTORY_FILE, []);
    const p = historyPoint(r);
    const last = history.at(-1);
    if (!last || Number(last.timestamp) !== Number(p.timestamp)) history.push(p);
    const cutoff = Date.now() - 31 * 86400000;
    writeJson(HISTORY_FILE, history.filter(x => Number(x.timestamp) >= cutoff).slice(-50000));
  } catch (e) { console.error("collector:", e.message); }
  finally { collecting = false; }
}
setInterval(collectSample, 60000).unref();
setTimeout(collectSample, 3000).unref();

function dateKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year:"numeric", month:"2-digit", day:"2-digit" }).format(new Date(ms));
}
function monthKey(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year:"numeric", month:"2-digit" }).format(new Date(ms));
}
function derivedPeriod(history, period) {
  const now = Date.now();
  const today = dateKey(now);
  const yesterday = dateKey(now - 86400000);
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(now); lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
  const lastMonth = monthKey(lastMonthDate.getTime());
  let points = history;
  if (period === "Y") points = history.filter(p => dateKey(p.timestamp) === yesterday);
  if (period === "TM") points = history.filter(p => monthKey(p.timestamp) === thisMonth);
  if (period === "LM") points = history.filter(p => monthKey(p.timestamp) === lastMonth);
  if (period === "T") points = history.filter(p => dateKey(p.timestamp) === today);
  if (!points.length) return { solar:0, load:0, importKwh:0, exportKwh:0 };
  const first = points[0], last = points[points.length - 1];
  return {
    solar: Math.max(0, Number(last.todaySolar||0) - Number(first.todaySolar||0)),
    load: Math.max(0, Number(last.todayLoad||0) - Number(first.todayLoad||0)),
    importKwh: Math.max(0, Number(last.todayGrid||0) - Number(first.todayGrid||0)),
    exportKwh: Math.max(0, Number(last.todayNetGrid||0) - Number(first.todayNetGrid||0))
  };
}

async function weather() {
  if (weatherCache.data && Date.now() - weatherCache.at < 600000) return weatherCache.data;
  const q = new URLSearchParams({ latitude:"32.568498", longitude:"74.044652", timezone:"Asia/Karachi", current:"temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m" });
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);
  const d = await r.json();
  const out = { temperature:d.current?.temperature_2m, humidity:d.current?.relative_humidity_2m, weatherCode:d.current?.weather_code, windSpeed:d.current?.wind_speed_10m };
  weatherCache = { at:Date.now(), data:out };
  return out;
}

function currentSettings() {
  return { deviceId: DEVICE_SN, deviceIdLocked: true, refresh: 10000, temperature: 75, load: 90, gridLow: 180, gridHigh: 260, ...(readJson(SETTINGS_FILE, {}) || {}) };
}

app.get("/", (_req,res) => res.sendFile(path.join(__dirname,"app","index.html")));
app.get("/api/health", (_req,res) => res.json({ success:true, service:"Raja Fraz Fronus Matrix 6K Dashboard", deviceSn:DEVICE_SN, stationId:STATION_ID }));
app.get("/api/matrix", async (_req,res) => { try { res.json({ success:true, ...(await fetchLive(true)) }); } catch(e) { res.status(500).json({ success:false, msg:e.message }); } });
app.get("/api/live", async (req,res) => { try { res.json({ ok:true, data: await fetchLive(req.query.fresh === "1") }); } catch(e) { res.status(500).json({ ok:false, error:e.message }); } });
app.get("/api/history", (req,res) => {
  const hours = Math.max(1, Math.min(720, Number(req.query.hours || 24)));
  const cutoff = Date.now() - hours * 3600000;
  const data = readJson(HISTORY_FILE, []).filter(p => Number(p.timestamp) >= cutoff);
  res.json({ ok:true, data });
});
app.get("/api/weather", async (_req,res) => { try { res.json({ ok:true, data:await weather() }); } catch(e) { res.status(500).json({ ok:false,error:e.message }); } });
app.get("/api/status", (_req,res) => res.json({ ok:true, version:"2.0.0-matrix", deviceConfigured:true, deviceId:DEVICE_SN, deviceIdLocked:true, historyCount:readJson(HISTORY_FILE,[]).length }));
app.get("/api/settings", (_req,res) => res.json({ ok:true, data:currentSettings() }));
app.post("/api/settings", (req,res) => {
  const next = { ...currentSettings(), ...req.body, deviceId:DEVICE_SN, deviceIdLocked:true };
  writeJson(SETTINGS_FILE, next); res.json({ ok:true, data:next });
});
app.get("/api/alerts", (_req,res) => res.json({ ok:true, data:readJson(ALERTS_FILE,[]) }));
app.get("/api/energy", async (req,res) => {
  try {
    const period = String(req.query.period || "T");
    const rate = Number(process.env.ELECTRICITY_RATE_PKR || 60);
    let solar=0, load=0, importKwh=0, exportKwh=0;
    if (period === "T") {
      const r = await fetchLive(false);
      solar = Number(r.todaySolar || 0); load = Number(r.todayLoad || 0); importKwh = Number(r.todayGrid || 0); exportKwh = Number(r.todayNetGrid || 0);
    } else {
      const d = derivedPeriod(readJson(HISTORY_FILE,[]), period);
      solar=d.solar; load=d.load; importKwh=d.importKwh; exportKwh=d.exportKwh;
    }
    res.json({ ok:true, data:{ todaySolar:solar, todayLoad:load, todayGrid:importKwh, todayNetGrid:exportKwh, todayNetSolar:Math.max(0,solar-load), todayTotal:load, rate } });
  } catch(e) { res.status(500).json({ ok:false,error:e.message }); }
});

app.listen(PORT, "0.0.0.0", () => console.log(`Raja Fraz Matrix dashboard listening on ${PORT}`));
