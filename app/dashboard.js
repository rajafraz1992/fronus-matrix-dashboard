(function startDashboard() {
  "use strict";

  const T = window.PCTelemetry;
  const DEFAULT_DEVICE = "";
  const STORAGE = {
    settings: "inverterzone-pc-settings-v1",
    reading: "inverterzone-pc-reading-v1",
    history: "inverterzone-pc-history-v1"
  };
  const TITLES = {
    overview: ["LIVE SITE OVERVIEW", "Fronus Matrix 6K"],
    charts: ["HISTORICAL TELEMETRY", "Live Charts"],
    energy: ["SERVER ENERGY TOTALS", "Energy Totals"],
    alerts: ["SYSTEM SUPERVISION", "Alerts"],
    device: ["INVERTER TELEMETRY", "Power & Device"],
    settings: ["DASHBOARD CONFIGURATION", "Configuration"]
  };

  const $ = (id) => document.getElementById(id);
  const $$ = (selector) => Array.from(document.querySelectorAll(selector));
  const finite = T.finite;
  const setText = (id, text) => { const node = $(id); if (node) node.textContent = text; };
  const numberText = (value, decimals = 0) => Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) : "—";
  const metric = (value, unit, decimals = 1) => `${numberText(value, decimals)} ${unit}`;

  let settings = loadSettings();
  let serverDeviceLocked = false;
  let latest = readJson(STORAGE.reading);
  let history = normaliseHistory(readJson(STORAGE.history) || []);
  let activeHours = 24;
  let activePeriod = "T";
  let refreshTimer = null;
  let historyTimer = null;
  let lastHistorySample = 0;
  let currentView = "overview";
  let activeSeries = new Set(["solar", "load", "grid"]);
  let chartInstances = [];
  let alertEvents = [];
  let currentAlerts = [];
  let toastTimer = null;
  let refreshSequence = 0;
  let lastSuccessfulRefreshAt = 0;
  let lastReadingWasCached = false;
  let audioContext = null;
  let engineOscillator = null;
  let engineGain = null;
  let engineFilter = null;

  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key) || "null"); }
    catch (_error) { return null; }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (_error) { /* History remains available through the hosted collector while storage persists. */ }
  }

  function loadSettings() {
    const stored = readJson(STORAGE.settings) || {};
    return {
      deviceId: String(stored.deviceId || DEFAULT_DEVICE).trim() || DEFAULT_DEVICE,
      refresh: [2000, 5000, 10000, 30000].includes(Number(stored.refresh)) ? Number(stored.refresh) : 10000,
      theme: ["solar", "midnight", "carbon", "frost"].includes(stored.theme) ? stored.theme : "solar",
      sound: stored.sound === true,
      temperature: clamp(stored.temperature, 45, 95, 75),
      load: clamp(stored.load, 50, 100, 90),
      gridLow: clamp(stored.gridLow, 140, 230, 180),
      gridHigh: clamp(stored.gridHigh, 220, 290, 260)
    };
  }

  function clamp(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2600);
  }

  function applySettings() {
    document.documentElement.dataset.theme = settings.theme;
    document.querySelector('meta[name="color-scheme"]').content = ["midnight", "carbon"].includes(settings.theme) ? "dark" : "light";
    $$(".theme-option").forEach((button) => button.classList.toggle("is-active", button.dataset.theme === settings.theme));
    const deviceInput = $("settingDeviceId");
    deviceInput.value = settings.deviceId;
    deviceInput.disabled = serverDeviceLocked;
    deviceInput.placeholder = serverDeviceLocked ? "Managed by hosting settings" : "Enter device ID";
    setText("deviceLockNote", serverDeviceLocked ? "Managed by the DEVICE_ID environment variable on your host." : "Stored by the dashboard server.");
    $("settingRefresh").value = String(settings.refresh);
    $("settingSound").checked = settings.sound;
    $("settingTemp").value = String(settings.temperature);
    $("settingLoad").value = String(settings.load);
    $("settingGridLow").value = String(settings.gridLow);
    $("settingGridHigh").value = String(settings.gridHigh);
    $("soundButton").classList.toggle("is-active", settings.sound);
    setText("limitTemp", `${settings.temperature}°C`);
    setText("limitLoad", `${settings.load}%`);
    setText("limitGridLow", `${settings.gridLow} V`);
    setText("limitGridHigh", `${settings.gridHigh} V`);
    redrawCharts();
  }

  function clockTick() {
    const now = new Date();
    setText("clockTime", now.toLocaleTimeString("en-GB", { hour12: false }));
    setText("clockDate", now.toLocaleDateString("en-PK", { weekday: "short", day: "2-digit", month: "short" }));
    if (lastSuccessfulRefreshAt) {
      const seconds = Math.max(0, Math.floor((Date.now() - lastSuccessfulRefreshAt) / 1000));
      const age = seconds < 2 ? "Updated now" : seconds < 60 ? `Updated ${seconds}s ago` : `Updated ${Math.floor(seconds / 60)}m ago`;
      setText("lastUpdated", `${lastReadingWasCached ? "Saved reading" : age} · auto ${settings.refresh / 1000}s`);
    }
  }

  function setConnection(state, detail) {
    const online = state === "online";
    $("liveChip").classList.toggle("is-online", online);
    $("liveChip").classList.toggle("is-offline", state === "offline");
    setText("connectionStatus", online ? "LIVE" : state === "offline" ? "OFFLINE" : "CONNECTING");
    setText("inverterState", online ? "ONLINE" : state === "offline" ? "OFFLINE" : "CONNECTING");
    setText("deviceOnline", online ? "ONLINE" : state === "offline" ? "OFFLINE" : "CONNECTING");
    setText("lastUpdated", detail || (online ? "Updated just now" : "Waiting for API"));
  }

  function powerParts(watts) {
    const value = finite(watts);
    return Math.abs(value) >= 1000
      ? { value: (Math.abs(value) / 1000).toFixed(2), unit: "kW" }
      : { value: Math.round(Math.abs(value)).toLocaleString("en-US"), unit: "W" };
  }

  function setGauge(id, percent) {
    const node = $(id);
    if (node) node.style.strokeDasharray = `${T.clamp(percent).toFixed(2)} 100`;
  }

  function renderReading(reading, cached = false) {
    if (!reading) return;
    latest = reading;
    if (!cached) lastSuccessfulRefreshAt = Date.now();
    lastReadingWasCached = cached;
    writeJson(STORAGE.reading, reading);
    const solar = powerParts(reading.solarWatts);
    const load = powerParts(reading.loadWatts);
    const grid = powerParts(reading.gridWatts);
    const solarPercent = T.percent(reading.solarWatts, T.CAPACITY.installedPvWatts);
    const loadPercent = Number.isFinite(reading.loadPercentage) ? reading.loadPercentage : T.percent(reading.loadWatts, T.CAPACITY.inverterOutputWatts);
    const gridPercent = T.percent(reading.gridWatts, T.CAPACITY.gridScaleWatts);
    const direction = reading.gridDirection || T.gridDirection(reading.gridWatts);
    const temperature = Math.max(finite(reading.transformerTemperature), finite(reading.radiatorTemperature), finite(reading.heatSinkTemperature || reading.inverterTemperature));

    setText("solarPower", solar.value); setText("solarUnit", solar.unit); setText("solarGaugePower", solar.value); setText("solarGaugeUnit", solar.unit);
    setText("loadPower", load.value); setText("loadUnit", load.unit);
    setText("gridPower", grid.value); setText("gridUnit", grid.unit);
    setText("solarPercent", `${solarPercent.toFixed(0)}% of 4.36 kWp`);
    setText("loadPercent", `${loadPercent.toFixed(0)}% of 6 kW`);
    setText("gridPercent", direction === "import" ? "Import from grid" : direction === "export" ? "Export to grid" : "Grid balanced");
    setText("gridDirectionBadge", direction === "import" ? "IMPORTING" : direction === "export" ? "EXPORTING" : "IDLE");
    setText("gridChartCaption", direction === "import" ? "Importing from utility · red above zero" : direction === "export" ? "Exporting surplus solar · green below zero" : "Import red above zero · export green below zero");

    // Keep grid direction styling consistent across cards, gauges, captions and legends.
    document.documentElement.dataset.gridDirection = direction;
    const gridTile = $("gridDirectionBadge")?.closest(".equipment-tile");
    const gridGaugeCard = $("gridGauge")?.closest(".assistant-gauge");
    [gridTile, gridGaugeCard].forEach((node) => {
      node?.classList.toggle("is-importing", direction === "import");
      node?.classList.toggle("is-exporting", direction === "export");
      node?.classList.toggle("is-idle", direction === "idle");
    });

    setGauge("solarGauge", solarPercent); setGauge("loadGauge", loadPercent); setGauge("gridGauge", gridPercent);

    const batterySoc = T.clamp(reading.batteryPercentage);
    const smart = powerParts(reading.smartLoadWatts);
    const smartPercent = T.percent(reading.smartLoadWatts, T.CAPACITY.inverterOutputWatts);
    setText("batterySoc", numberText(batterySoc, 0));
    setText("batteryMode", reading.batteryMode || (reading.batteryActive ? "ACTIVE" : "IDLE"));
    setText("smartLoadPower", smart.value); setText("smartLoadUnit", smart.unit);
    setText("smartLoadState", reading.smartLoadActive ? "ACTIVE" : "IDLE");
    setGauge("smartLoadGauge", smartPercent);

    setText("pv1Mini", `PV1 ${numberText(reading.pv1Watts)} W`);
    setText("pv2Mini", `PV2 ${numberText(reading.pv2Watts)} W`);
    setText("solarSubtitle", `PV1 ${numberText(reading.pv1Watts)} W · PV2 ${numberText(reading.pv2Watts)} W`);
    setText("pv1Power", numberText(reading.pv1Watts));
    setText("pv2Power", numberText(reading.pv2Watts));
    setText("pv1Electrical", `${metric(reading.pv1Voltage, "V", 1)} · ${metric(reading.pv1Ampere, "A", 1)}`);
    setText("pv2Electrical", `${metric(reading.pv2Voltage, "V", 1)} · ${metric(reading.pv2Ampere, "A", 1)}`);
    setText("loadVoltageMini", metric(reading.loadVoltage, "V", 1));
    setText("loadCurrentMini", metric(reading.loadAmpere, "A", 1));
    setText("gridVoltageMini", metric(reading.gridVoltage, "V", 1));
    setText("gridFrequencyMini", metric(reading.gridHz, "Hz", 1));
    setText("batteryTemp", Number.isFinite(reading.batteryTemperature) ? numberText(reading.batteryTemperature, 0) : "—");
    setText("transformerTemp", Number.isFinite(reading.transformerTemperature) ? numberText(reading.transformerTemperature, 0) : "—");
    setText("radiatorTemp", Number.isFinite(reading.radiatorTemperature) ? numberText(reading.radiatorTemperature, 0) : "—");
    setText("peakSolar", Number.isFinite(reading.peakSolar) ? `Peak ${numberText(reading.peakSolar)} W` : "Peak —");
    setText("flowMode", reading.modeLabel || "Matrix inverter online");
    setText("flowHeadline", reading.flowHeadline || "Live inverter telemetry");
    setText("deviceName", String(reading.name || "Inverter").replace(/\s+0(?:\.0)?V\s+6000W$/i, ""));
    setText("deviceId", reading.deviceId || settings.deviceId);
    renderHealth(reading);
    renderDeviceDetails(reading);
    renderAlerts(reading);
    updateSound(reading);
    setConnection(cached ? "offline" : "online", cached ? "Showing saved reading" : `Updated now · auto ${settings.refresh / 1000}s`);
  }

  function renderHealth(reading) {
    const temperature = Math.max(finite(reading.transformerTemperature), finite(reading.radiatorTemperature), finite(reading.heatSinkTemperature || reading.inverterTemperature));
    const load = finite(reading.loadPercentage, T.percent(reading.loadWatts, T.CAPACITY.inverterOutputWatts));
    const voltage = finite(reading.gridVoltage);
    let score = 100;
    if (temperature >= settings.temperature) score -= 25;
    else if (temperature >= settings.temperature - 10) score -= 8;
    if (load >= settings.load) score -= 25;
    else if (load >= settings.load - 15) score -= 8;
    if (voltage && (voltage < settings.gridLow || voltage > settings.gridHigh)) score -= 25;
    if (reading.fault && !/^(NO|0|NONE|NORMAL)$/i.test(String(reading.fault))) score -= 30;
    score = Math.max(0, score);
    const grade = score >= 90 ? "Excellent" : score >= 75 ? "Good" : score >= 55 ? "Attention" : "Critical";
    setText("healthGrade", `${grade} · ${score}/100`);
    setText("healthSummary", score >= 90 ? "All monitored values are normal" : `${currentAlerts.length || 1} condition needs review`);
  }

  function details(targetId, rows) {
    const target = $(targetId);
    if (!target) return;
    target.replaceChildren(...rows.map(([label, value]) => {
      const div = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label; dd.textContent = value; div.append(dt, dd); return div;
    }));
  }

  function renderDeviceDetails(r) {
    const gridDirection = r.gridDirection || T.gridDirection(r.gridWatts);
    const gridPowerLabel = gridDirection === "import" ? "Grid import" : gridDirection === "export" ? "Grid export" : "Grid power";
    const gridDirectionLabel = gridDirection === "import" ? "IMPORTING" : gridDirection === "export" ? "EXPORTING" : "IDLE";
    details("acDetails", [
      [gridPowerLabel, metric(Math.abs(r.gridWatts), "W", 0)], ["Grid direction", gridDirectionLabel],
      ["Grid voltage", metric(r.gridVoltage, "V", 1)], ["Grid frequency", metric(r.gridHz, "Hz", 2)], ["Grid current", metric(Math.abs(r.gridAmpere), "A", 2)],
      ["House load", metric(r.loadWatts, "W", 0)], ["Inverter output", metric(r.inverterOutputWatts, "W", 0)],
      ["Output voltage", metric(r.loadVoltage, "V", 1)], ["Output frequency", metric(r.loadHz, "Hz", 2)]
    ]);
    details("pvDetails", [
      ["Total PV power", metric(r.solarWatts, "W", 0)], ["PV installed", "4,360 W"],
      ["PV1 power", metric(r.pv1Watts, "W", 0)], ["PV1 V / A", `${metric(r.pv1Voltage, "V", 1)} · ${metric(r.pv1Ampere, "A", 2)}`],
      ["PV2 power", metric(r.pv2Watts, "W", 0)], ["PV2 V / A", `${metric(r.pv2Voltage, "V", 1)} · ${metric(r.pv2Ampere, "A", 2)}`],
      ["Inverter PV limit", "6,000 W"], ["Solar today", `${numberText(r.todaySolar, 2)} kWh`]
    ]);
    details("inverterDetails", [
      ["Mode", r.modeLabel || "Hybrid Mode"], ["Battery SOC", `${numberText(r.batteryPercentage, 0)}%`],
      ["Battery", `${r.batteryMode || "IDLE"} · ${metric(r.batteryPowerWatts, "W", 0)} · ${metric(r.batteryVoltage, "V", 2)}`],
      ["Smart Load", `${r.smartLoadActive ? "ACTIVE" : "IDLE"} · ${metric(r.smartLoadWatts, "W", 0)}`],
      ["Battery temperature", metric(r.batteryTemperature, "°C", 0)], ["Transformer temperature", metric(r.transformerTemperature, "°C", 0)],
      ["Radiator temperature", metric(r.radiatorTemperature, "°C", 0)], ["Fault", r.fault || "NO"]
    ]);
    details("connectivityDetails", [
      ["Device SN", r.deviceId || settings.deviceId], ["Platform", "SOLARMAN Business"],
      ["Station ID", "3332398"], ["Organization ID", "195093"],
      ["Firmware", r.firmware || "Not supplied"], ["Inverter software", r.inverterSoftware || "Not supplied"],
      ["Model", r.model || "Fronus Matrix 6K"], ["Net metering", String(r.netMetering || "Enabled")]
    ]);
  }

  function evaluateAlerts(r) {
    const alerts = [];
    const temp = finite(r.heatSinkTemperature || r.inverterTemperature);
    if (temp >= settings.temperature) alerts.push({ severity: "High", condition: "MPPT temperature", reading: `${temp.toFixed(0)}°C`, message: `Temperature is above ${settings.temperature}°C.` });
    if (finite(r.loadPercentage) >= settings.load) alerts.push({ severity: "High", condition: "Inverter load", reading: `${finite(r.loadPercentage).toFixed(0)}%`, message: `AC load is above ${settings.load}%.` });
    if (finite(r.gridVoltage) && finite(r.gridVoltage) < settings.gridLow) alerts.push({ severity: "Warning", condition: "Grid undervoltage", reading: `${finite(r.gridVoltage).toFixed(1)} V`, message: `Grid is below ${settings.gridLow} V.` });
    if (finite(r.gridVoltage) > settings.gridHigh) alerts.push({ severity: "Warning", condition: "Grid overvoltage", reading: `${finite(r.gridVoltage).toFixed(1)} V`, message: `Grid is above ${settings.gridHigh} V.` });
    if (r.fault && !/^(NO|0|NONE|NORMAL)$/i.test(String(r.fault))) alerts.push({ severity: "Critical", condition: "Inverter fault", reading: String(r.fault), message: "The inverter API reports a fault." });
    return alerts;
  }

  function renderAlerts(reading) {
    currentAlerts = evaluateAlerts(reading);
    const count = currentAlerts.length;
    setText("activeAlertCount", String(count));
    setText("activeAlertTitle", count ? `${count} active condition${count === 1 ? "" : "s"}` : "No active warnings");
    setText("alertState", count ? "ATTENTION" : "ALL NORMAL");
    $("navAlertCount").hidden = count === 0;
    setText("navAlertCount", String(count));
    const list = $("activeAlertList");
    if (!count) {
      list.innerHTML = '<div class="empty-state"><svg><use href="#i-check"/></svg><div><strong>System operating normally</strong><p>All monitored values are inside the configured limits.</p></div></div>';
    } else {
      list.replaceChildren(...currentAlerts.map((alert) => {
        const article = document.createElement("article"); article.className = "alert-item";
        const title = document.createElement("b"); title.textContent = alert.condition;
        const text = document.createElement("span"); text.textContent = alert.message;
        const value = document.createElement("strong"); value.textContent = alert.reading;
        article.append(title, text, value); return article;
      }));
    }
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { cache: "no-store", ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }

  function serverPayload(payload) { return payload && Object.prototype.hasOwnProperty.call(payload, "ok") ? payload.data : payload; }

  async function syncServerSettings() {
    if (location.protocol === "file:") return;
    try {
      const remote = serverPayload(await fetchJson("/api/settings")) || {};
      serverDeviceLocked = remote.deviceIdLocked === true;
      settings = {
        ...settings,
        deviceId: String(remote.deviceId ?? settings.deviceId ?? "").trim(),
        refresh: [2000, 5000, 10000, 30000].includes(Number(remote.refresh)) ? Number(remote.refresh) : 10000,
        temperature: clamp(remote.temperature, 45, 95, settings.temperature),
        load: clamp(remote.load, 50, 100, settings.load),
        gridLow: clamp(remote.gridLow, 140, 230, settings.gridLow),
        gridHigh: clamp(remote.gridHigh, 220, 290, settings.gridHigh)
      };
      writeJson(STORAGE.settings, settings);
      applySettings();
    } catch (_error) { /* The live request will display the connection error. */ }
  }

  async function refreshLive(manual = false, force = manual) {
    if (manual) $("refreshButton").classList.add("is-spinning");
    try {
      let payload;
      if (location.protocol === "file:") {
        payload = await fetchJson("https://inverterzone.com/api/getRealtimeData", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: new URLSearchParams({ deviceId: settings.deviceId }).toString()
        });
      } else {
        payload = await fetchJson(`/api/live${force ? "?fresh=1" : ""}`);
      }
      const reading = T.normalize(serverPayload(payload));
      const cached = Boolean(payload && payload.cached);
      renderReading(reading, cached);
      $("connectionBanner").hidden = !cached;
      if (cached) setText("connectionMessage", "The SOLARMAN API did not respond; showing the most recent collector reading.");
      appendBrowserHistory(reading);
    } catch (error) {
      $("connectionBanner").hidden = false;
      setText("connectionMessage", latest ? "Showing the latest saved values while reconnecting." : `Could not reach the API: ${error.message}`);
      if (latest) renderReading(latest, true);
      setConnection("offline", "Reconnecting…");
    } finally {
      $("refreshButton").classList.remove("is-spinning");
    }
  }

  function appendBrowserHistory(reading) {
    const now = Date.now();
    if (now - lastHistorySample < 60000) return;
    lastHistorySample = now;
    history.push(T.historyPoint(reading));
    history = normaliseHistory(history).filter((point) => point.timestamp > now - 48 * 3600000).slice(-3000);
    writeJson(STORAGE.history, history);
    redrawCharts();
  }

  function normaliseHistory(points) {
    if (!Array.isArray(points)) return [];
    return points.map((point) => ({
      timestamp: Number(point.timestamp || point.at || point.time) || Date.now(),
      solarW: finite(point.solarW ?? point.solar), pv1W: finite(point.pv1W ?? point.pv1), pv2W: finite(point.pv2W ?? point.pv2),
      loadW: finite(point.loadW ?? point.load), gridW: finite(point.gridW ?? point.grid), gridV: finite(point.gridV ?? point.gridVoltage),
      outputV: finite(point.outputV ?? point.loadVoltage), temperature: finite(point.temperature), fan: finite(point.fan)
    })).filter((point) => Number.isFinite(point.timestamp)).sort((a, b) => a.timestamp - b.timestamp);
  }

  async function loadHistory(hours = activeHours) {
    activeHours = Number(hours) || 24;
    try {
      if (location.protocol !== "file:") {
        const payload = await fetchJson(`/api/history?hours=${activeHours}`);
        const serverHistory = normaliseHistory(serverPayload(payload));
        if (serverHistory.length) history = serverHistory;
      }
    } catch (_error) { /* Browser history remains usable if the collector is temporarily offline. */ }
    const cutoff = Date.now() - activeHours * 3600000;
    history = history.filter((point) => point.timestamp >= cutoff);
    redrawCharts();
  }

  async function loadEnergy(period = activePeriod) {
    activePeriod = period;
    setText("energySync", "Syncing…");
    try {
      let payload;
      if (location.protocol === "file:") {
        payload = await fetchJson("https://inverterzone.com/api/getEnergy", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" }, body: new URLSearchParams({ device: settings.deviceId, value: period }).toString() });
      } else payload = await fetchJson(`/api/energy?period=${encodeURIComponent(period)}`);
      renderEnergy(T.normalizeEnergy(serverPayload(payload), period));
      setText("energySync", "Synced with Raja Fraz");
    } catch (error) { setText("energySync", `Sync failed · ${error.message}`); }
  }

  function renderEnergy(energy) {
    const labels = { T: "Today", Y: "Yesterday", TM: "This month", LM: "Last month" };
    setText("energyPeriodLabel", labels[energy.period] || "Selected period");
    setText("energySolarCaption", labels[energy.period] || "Selected period");
    setText("energySolar", numberText(energy.solarKwh, 2)); setText("energyLoad", numberText(energy.loadKwh, 2));
    setText("energyImport", numberText(energy.importKwh, 2)); setText("energyExport", numberText(energy.exportKwh, 2));
    setText("energySavings", numberText(energy.savings, 0)); setText("energyRate", `PKR ${numberText(energy.rate, 2)}/kWh`);
    setText("energyNetSolar", `${numberText(energy.netSolarKwh, 2)} kWh`); setText("energyExportAfter", `${numberText(energy.exportAfterUseKwh, 2)} kWh`);
    const values = [energy.solarKwh, energy.loadKwh, energy.importKwh, energy.exportKwh];
    const names = ["Solar", "Consumption", "Import", "Export"];
    const maximum = Math.max(...values, 1);
    $("energyBars").replaceChildren(...values.map((value, index) => {
      const bar = document.createElement("div"); bar.className = "energy-bar";
      const amount = document.createElement("b"); amount.textContent = `${numberText(value, 2)} kWh`;
      const column = document.createElement("i"); column.style.height = `${Math.max(1, value / maximum * 82)}%`;
      const label = document.createElement("span"); label.textContent = names[index];
      bar.append(amount, column, label); return bar;
    }));
  }

  async function loadWeather() {
    try {
      let weather;
      if (location.protocol === "file:") {
        const raw = await fetchJson("https://api.open-meteo.com/v1/forecast?latitude=32.5742&longitude=74.0789&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&timezone=Asia%2FKarachi");
        weather = { temperature: raw.current.temperature_2m, humidity: raw.current.relative_humidity_2m, weatherCode: raw.current.weather_code, windSpeed: raw.current.wind_speed_10m };
      } else weather = serverPayload(await fetchJson("/api/weather"));
      setText("weatherTemp", `${Math.round(finite(weather.temperature))}°`);
      setText("weatherCondition", weather.condition || weatherLabel(weather.weatherCode));
    } catch (_error) { setText("weatherCondition", "Gujrat weather"); }
  }

  function weatherLabel(code) {
    const value = Number(code);
    if (value === 0) return "Clear sky"; if ([1,2].includes(value)) return "Partly cloudy"; if (value === 3) return "Overcast";
    if ([45,48].includes(value)) return "Fog"; if (value >= 51 && value <= 67) return "Rain"; if (value >= 80 && value <= 82) return "Rain showers";
    if (value >= 95) return "Thunderstorm"; return "Current weather";
  }

  async function loadServerAlerts() {
    if (location.protocol === "file:") return;
    try {
      const payload = await fetchJson("/api/alerts");
      alertEvents = Array.isArray(serverPayload(payload)) ? serverPayload(payload) : [];
      renderEventLog();
    } catch (_error) { /* Active browser alerts are still displayed. */ }
  }

  function renderEventLog() {
    const rows = $("eventRows");
    if (!alertEvents.length) { rows.innerHTML = '<div class="empty-table">No alert events have been recorded.</div>'; return; }
    rows.replaceChildren(...alertEvents.slice().reverse().slice(0, 100).map((event) => {
      const row = document.createElement("div"); row.className = "event-row";
      [new Date(event.timestamp || event.time).toLocaleString(), event.severity || "Warning", event.condition || event.message || "Alert", event.reading || "—"].forEach((text) => {
        const span = document.createElement("span"); span.textContent = text; row.append(span);
      }); return row;
    }));
  }

  async function testCollector() {
    const status = $("collectorStatus");
    if (location.protocol === "file:") {
      status.textContent = "START REQUIRED";
      status.classList.remove("is-online");
      setText("collectorDetail", "Start the local Node server to activate background history.");
      return;
    }
    try {
      const payload = await fetchJson("/api/status");
      status.textContent = "RUNNING"; status.classList.add("is-online");
      setText("collectorDetail", `Server ${payload.version || "online"} · ${payload.historyCount || 0} saved samples`);
    } catch (_error) {
      status.textContent = "NOT CONNECTED"; status.classList.remove("is-online");
      setText("collectorDetail", "Collector check failed.");
    }
  }

  function color(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  function createChart(canvasId, points, series, options = {}) {
    const canvas = $(canvasId);
    if (!canvas) return null;
    const context = canvas.getContext("2d");
    const state = { canvas, context, points, series, options };
    chartInstances.push(state);
    drawChart(state);
    return state;
  }

  function chartStrokeColor(value) {
    return value.startsWith("--") ? color(value) : value;
  }

  function chartFillGradient(context, stroke, top, bottom) {
    const gradient = context.createLinearGradient(0, top, 0, bottom);
    gradient.addColorStop(0, `${stroke}32`);
    gradient.addColorStop(1, `${stroke}05`);
    return gradient;
  }

  function drawDirectionalGridSeries(context, points, item, x, y, baseline, pad, height) {
    const importStroke = chartStrokeColor(item.importColor || "--grid");
    const exportStroke = chartStrokeColor(item.exportColor || "--green");
    const lineWidth = item.width || 1.7;
    const drawArea = (x1, y1, x2, y2, stroke) => {
      context.beginPath();
      context.moveTo(x1, baseline); context.lineTo(x1, y1); context.lineTo(x2, y2); context.lineTo(x2, baseline); context.closePath();
      context.fillStyle = chartFillGradient(context, stroke, pad.top, height - pad.bottom);
      context.fill();
    };
    const drawLine = (x1, y1, x2, y2, stroke) => {
      context.beginPath(); context.moveTo(x1, y1); context.lineTo(x2, y2);
      context.strokeStyle = stroke; context.lineWidth = lineWidth; context.lineJoin = "round"; context.lineCap = "round"; context.stroke();
    };

    for (let index = 1; index < points.length; index += 1) {
      const previous = finite(points[index - 1][item.key]);
      const current = finite(points[index][item.key]);
      const x1 = x(index - 1), x2 = x(index), y1 = y(previous), y2 = y(current);
      if ((previous >= 0 && current >= 0) || (previous <= 0 && current <= 0)) {
        const stroke = previous < 0 || current < 0 ? exportStroke : importStroke;
        if (item.fill) drawArea(x1, y1, x2, y2, stroke);
        drawLine(x1, y1, x2, y2, stroke);
        continue;
      }

      const fraction = previous / (previous - current);
      const crossingX = x1 + (x2 - x1) * fraction;
      const firstStroke = previous < 0 ? exportStroke : importStroke;
      const secondStroke = current < 0 ? exportStroke : importStroke;
      if (item.fill) {
        drawArea(x1, y1, crossingX, baseline, firstStroke);
        drawArea(crossingX, baseline, x2, y2, secondStroke);
      }
      drawLine(x1, y1, crossingX, baseline, firstStroke);
      drawLine(crossingX, baseline, x2, y2, secondStroke);
    }
  }

  function drawChart(state) {
    const { canvas, context, points, series, options } = state;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 30 || rect.height < 30) return;
    const ratio = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const width = rect.width, height = rect.height;
    context.clearRect(0, 0, width, height);
    const pad = { left: options.compact ? 43 : 50, right: 13, top: 12, bottom: 28 };
    const plotW = width - pad.left - pad.right, plotH = height - pad.top - pad.bottom;
    const visibleSeries = series.filter((item) => item.visible !== false);
    const values = points.flatMap((point) => visibleSeries.map((item) => finite(point[item.key])));
    let min = options.min !== undefined ? options.min : Math.min(0, ...values);
    let max = options.max !== undefined ? options.max : Math.max(...values, 1);
    if (max === min) { max += 1; min -= 1; }
    const padding = (max - min) * .08; max += options.max === undefined ? padding : 0; min -= options.min === undefined ? padding : 0;
    const y = (value) => pad.top + (max - value) / (max - min) * plotH;
    const x = (index) => pad.left + (points.length <= 1 ? plotW / 2 : index / (points.length - 1) * plotW);

    context.lineWidth = 1; context.font = "10px Segoe UI"; context.fillStyle = color("--muted"); context.textAlign = "right";
    for (let step = 0; step <= 5; step += 1) {
      const value = max - (max - min) * step / 5;
      const py = pad.top + plotH * step / 5;
      context.strokeStyle = color("--line"); context.beginPath(); context.moveTo(pad.left, py); context.lineTo(width - pad.right, py); context.stroke();
      context.fillText(formatAxis(value, options.unit), pad.left - 7, py + 3);
    }
    if (min < 0 && max > 0) { context.strokeStyle = color("--line-strong"); context.beginPath(); context.moveTo(pad.left, y(0)); context.lineTo(width - pad.right, y(0)); context.stroke(); }
    context.textAlign = "center";
    const labelSteps = Math.min(6, Math.max(2, points.length));
    for (let step = 0; step < labelSteps; step += 1) {
      const index = points.length ? Math.round((points.length - 1) * step / Math.max(1, labelSteps - 1)) : 0;
      const px = pad.left + plotW * step / Math.max(1, labelSteps - 1);
      const date = points[index] ? new Date(points[index].timestamp) : new Date();
      context.fillText(activeHours > 48 ? date.toLocaleDateString([], { month: "short", day: "numeric" }) : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), px, height - 8);
    }
    if (points.length < 2) return;

    visibleSeries.forEach((item) => {
      const baseline = y(Math.max(min, Math.min(max, 0)));
      if (item.directionalGrid) {
        drawDirectionalGridSeries(context, points, item, x, y, baseline, pad, height);
        return;
      }
      const stroke = chartStrokeColor(item.color);
      context.beginPath(); points.forEach((point, index) => { const px = x(index), py = y(finite(point[item.key])); index ? context.lineTo(px, py) : context.moveTo(px, py); });
      if (item.fill) {
        context.lineTo(x(points.length - 1), baseline); context.lineTo(x(0), baseline); context.closePath();
        context.fillStyle = chartFillGradient(context, stroke, pad.top, height - pad.bottom); context.fill();
        context.beginPath(); points.forEach((point, index) => { const px = x(index), py = y(finite(point[item.key])); index ? context.lineTo(px, py) : context.moveTo(px, py); });
      }
      context.strokeStyle = stroke; context.lineWidth = item.width || 1.7; context.lineJoin = "round"; context.lineCap = "round"; context.stroke();
    });
  }

  function formatAxis(value, unit) {
    if (unit === "W") return Math.abs(value) >= 1000 ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0)}K` : Math.round(value).toString();
    return `${Math.round(value)}${unit ? ` ${unit}` : ""}`;
  }

  function redrawCharts() {
    chartInstances = [];
    const points = history.slice();
    const empty = $("overviewChartEmpty"); if (empty) empty.classList.toggle("is-hidden", points.length >= 2);
    createChart("overviewChart", points, [
      { key: "loadW", color: "--load", fill: true },
      { key: "gridW", directionalGrid: true, importColor: "--grid", exportColor: "--green", fill: true },
      { key: "solarW", color: "--solar", fill: true }
    ], { unit: "W" });
    createChart("gridOverviewChart", points, [{ key: "gridW", directionalGrid: true, importColor: "--grid", exportColor: "--green", fill: true }], { unit: "W", compact: true });
    createChart("pvOverviewChart", points, [{ key: "pv1W", color: "--solar", fill: true }, { key: "pv2W", color: "--purple", fill: false }], { unit: "W", compact: true });
    createChart("historyChart", points, [
      { key: "solarW", color: "--solar", fill: true, visible: activeSeries.has("solar") },
      { key: "loadW", color: "--load", fill: false, visible: activeSeries.has("load") },
      { key: "gridW", directionalGrid: true, importColor: "--grid", exportColor: "--green", fill: false, visible: activeSeries.has("grid") }
    ], { unit: "W" });
    createChart("pvChart", points, [{ key: "pv1W", color: "--solar", fill: true }, { key: "pv2W", color: "--purple", fill: false }], { unit: "W" });
    createChart("thermalChart", points, [{ key: "temperature", color: "--grid", fill: true }, { key: "fan", color: "--load", fill: false }], { unit: "%/°", min: 0, max: 100 });
    createChart("voltageChart", points, [{ key: "gridV", color: "--grid", fill: false }, { key: "outputV", color: "--green", fill: false }], { unit: "V", min: 150, max: 270 });
    renderBalance(points);
  }

  function renderBalance(points) {
    if (!points.length) return;
    const average = (key) => points.reduce((sum, point) => sum + finite(point[key]), 0) / points.length;
    const solar = average("solarW"), load = average("loadW");
    const ratio = load > 0 ? Math.min(999, solar / load * 100) : 0;
    $("balanceSummary").innerHTML = `<strong>${ratio.toFixed(0)}% production ratio</strong><p>Average solar ${numberText(solar)} W versus average load ${numberText(load)} W across this range.</p>`;
  }

  function switchView(view) {
    currentView = view;
    $$(".view").forEach((section) => section.classList.toggle("is-active", section.id === `view-${view}`));
    $$(".nav-item").forEach((button) => button.classList.toggle("is-active", button.dataset.view === view));
    setText("pageEyebrow", TITLES[view][0]); setText("pageTitle", TITLES[view][1]);
    if (view === "energy") loadEnergy(activePeriod);
    if (view === "alerts") loadServerAlerts();
    if (view === "charts" || view === "overview") requestAnimationFrame(redrawCharts);
  }

  async function saveSettings() {
    if (!serverDeviceLocked) settings.deviceId = $("settingDeviceId").value.trim();
    settings.refresh = Number($("settingRefresh").value) || 5000;
    settings.sound = $("settingSound").checked;
    settings.temperature = clamp($("settingTemp").value, 45, 95, 75);
    settings.load = clamp($("settingLoad").value, 50, 100, 90);
    settings.gridLow = clamp($("settingGridLow").value, 140, 230, 180);
    settings.gridHigh = clamp($("settingGridHigh").value, 220, 290, 260);
    writeJson(STORAGE.settings, settings); applySettings(); scheduleLive();
    if (location.protocol !== "file:") {
      try { await fetchJson("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }); }
      catch (_error) { showToast("Saved in dashboard; collector settings will sync when connected."); return; }
    }
    showToast("Configuration saved");
  }

  function scheduleLive() {
    refreshSequence += 1;
    const sequence = refreshSequence;
    clearTimeout(refreshTimer);
    const tick = async () => {
      await refreshLive(false, true);
      if (sequence === refreshSequence) refreshTimer = setTimeout(tick, settings.refresh);
    };
    refreshTimer = setTimeout(tick, settings.refresh);
  }

  function toggleSound() {
    settings.sound = !settings.sound; $("settingSound").checked = settings.sound; writeJson(STORAGE.settings, settings); applySettings();
    if (settings.sound) startSound(); else stopSound();
  }

  function startSound() {
    if (engineOscillator) return;
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) { showToast("Audio is not supported by this browser"); settings.sound = false; return; }
    audioContext = audioContext || new Audio();
    engineOscillator = audioContext.createOscillator(); engineGain = audioContext.createGain(); engineFilter = audioContext.createBiquadFilter();
    engineOscillator.type = "sawtooth"; engineOscillator.frequency.value = 55; engineFilter.type = "lowpass"; engineFilter.frequency.value = 220;
    engineGain.gain.value = .018; engineOscillator.connect(engineFilter).connect(engineGain).connect(audioContext.destination); engineOscillator.start();
    if (audioContext.state === "suspended") audioContext.resume();
    updateSound(latest); showToast("Racing gauge sound enabled");
  }

  function updateSound(reading) {
    if (!settings.sound || !engineOscillator || !reading) return;
    const power = T.clamp((Math.abs(finite(reading.solarWatts)) + Math.abs(finite(reading.loadWatts))) / 120, 0, 100);
    const now = audioContext.currentTime; engineOscillator.frequency.setTargetAtTime(48 + power * 1.65, now, .15); engineFilter.frequency.setTargetAtTime(160 + power * 7, now, .2);
  }

  function stopSound() {
    if (engineOscillator) { try { engineOscillator.stop(); } catch (_error) {} engineOscillator.disconnect(); }
    engineOscillator = null; engineGain = null; engineFilter = null;
  }

  function exportAlerts() {
    const header = "Time,Severity,Condition,Reading\n";
    const body = alertEvents.map((event) => [event.timestamp || event.time, event.severity, event.condition || event.message, event.reading].map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([header + body], { type: "text/csv" })); link.download = "Raja-Fraz-alerts.csv"; link.click(); URL.revokeObjectURL(link.href);
  }

  function wireEvents() {
    $$(".nav-item").forEach((button) => button.addEventListener("click", () => switchView(button.dataset.view)));
    $$('[data-go="settings"]').forEach((button) => button.addEventListener("click", () => switchView("settings")));
    $("refreshButton").addEventListener("click", () => refreshLive(true, true));
    $("fullscreenButton").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
    $("soundButton").addEventListener("click", toggleSound);
    $("settingSound").addEventListener("change", () => { settings.sound = $("settingSound").checked; if (settings.sound) startSound(); else stopSound(); });
    $("saveSettingsButton").addEventListener("click", saveSettings);
    $("testCollectorButton").addEventListener("click", testCollector);
    $("exportAlertsButton").addEventListener("click", exportAlerts);
    $$(".theme-option").forEach((button) => button.addEventListener("click", () => { settings.theme = button.dataset.theme; writeJson(STORAGE.settings, settings); applySettings(); }));
    $$("#historyRange button").forEach((button) => button.addEventListener("click", () => { $$("#historyRange button").forEach((node) => node.classList.toggle("is-active", node === button)); loadHistory(button.dataset.hours); }));
    $$("#energyPeriod button").forEach((button) => button.addEventListener("click", () => { $$("#energyPeriod button").forEach((node) => node.classList.toggle("is-active", node === button)); loadEnergy(button.dataset.period); }));
    $$(".series-toggle").forEach((button) => button.addEventListener("click", () => { activeSeries.has(button.dataset.series) ? activeSeries.delete(button.dataset.series) : activeSeries.add(button.dataset.series); button.classList.toggle("is-active", activeSeries.has(button.dataset.series)); redrawCharts(); }));
    window.addEventListener("resize", () => { clearTimeout(window.__chartResize); window.__chartResize = setTimeout(redrawCharts, 100); });
    window.addEventListener("online", () => refreshLive(false, true));
    document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshLive(false, true); });
  }

  async function init() {
    applySettings(); wireEvents(); clockTick(); setInterval(clockTick, 1000);
    if (latest) { try { renderReading(T.normalize(latest), true); } catch (_error) {} }
    await syncServerSettings();
    await Promise.allSettled([refreshLive(false, true), loadHistory(24), loadWeather(), testCollector()]);
    scheduleLive();
    clearInterval(historyTimer); historyTimer = setInterval(() => loadHistory(activeHours), 60000);
    setInterval(loadWeather, 15 * 60000);
    if (settings.sound) { settings.sound = false; $("settingSound").checked = false; $("soundButton").classList.remove("is-active"); }
  }

  init();
})();
