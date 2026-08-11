(function attachTelemetry(root) {
  "use strict";

  const CAPACITY = Object.freeze({
    installedPvWatts: 4360,
    pv1Watts: 4360,
    pv2Watts: 0,
    inverterInputWatts: 6000,
    inverterOutputWatts: 6000,
    gridScaleWatts: 6000
  });

  const ALIASES = Object.freeze({
    deviceId: ["deviceId", "device_id", "device"],
    name: ["name", "deviceName", "device_name"],
    signal: ["signal", "wifiSignal", "wifi_signal"],
    localIp: ["localIp", "local_ip"],
    firmware: ["currentVersion", "firmwareVersion", "firmware"],
    inverterSoftware: ["inverterSoftware", "Inverter_SW"],
    protocol: ["protocol", "protocolId", "Protocol_ID"],
    model: ["model", "Device_Model", "deviceModel"],
    solarWatts: ["solarW", "solarWatts", "solar_watts", "pvWatts", "pvPower", "pv_power", "PV_Total_Power"],
    solarVoltage: ["solarV", "solarVoltage", "solar_voltage", "pvVoltage", "pv_voltage", "PV_Total_Voltage"],
    solarAmpere: ["solarA", "solarAmpere", "solar_ampere", "pvAmpere", "pvCurrent", "pv_current", "PV_Total_Current"],
    pv1Watts: ["solarW1", "pv1Watts", "pv1_power"],
    pv1Voltage: ["solarV1", "pv1Voltage", "pv1_voltage"],
    pv1Ampere: ["solarA1", "pv1Ampere", "pv1_current"],
    pv2Watts: ["solarW2", "pv2Watts", "pv2_power"],
    pv2Voltage: ["solarV2", "pv2Voltage", "pv2_voltage"],
    pv2Ampere: ["solarA2", "pv2Ampere", "pv2_current"],
    pv3Watts: ["solarW3", "pv3Watts", "pv3_power"],
    loadWatts: ["acOutW", "loadWatts", "load_watts", "loadPower", "load_power", "AC_out_Watt"],
    loadVa: ["acOutVa", "acOutVA", "loadVa", "loadVA", "AC_out_VA"],
    loadVoltage: ["acOutV", "loadVoltage", "load_voltage", "AC_out_Voltage"],
    loadHz: ["acOutHz", "loadHz", "outputFrequency", "AC_out_Frequenz"],
    loadAmpere: ["loadAmpere", "load_ampere", "loadCurrent", "load_current"],
    loadPercentage: ["acOutPercent", "loadPercentage", "load_percentage", "loadPercent", "load_percent", "AC_out_percent"],
    gridWatts: ["gridW", "gridWatts", "grid_watts", "gridPower", "grid_power", "Grid_Watt"],
    gridVoltage: ["gridV", "gridVoltage", "grid_voltage", "AC_in_Voltage"],
    gridAmpere: ["gridAmpere", "grid_ampere", "gridCurrent", "grid_current"],
    gridHz: ["gridHz", "grid_hz", "gridFrequency", "grid_frequency", "frequency", "AC_in_Frequenz"],
    busVoltage: ["busV", "busVoltage", "Inverter_Bus_Voltage"],
    heatSinkTemperature: ["heatSinkDegC", "heatSinkTemperature", "mpptTemperature", "mppt_temperature", "mpptTemp", "mppt_temp", "Inverter_Bus_Temperature"],
    inverterTemperature: ["inverterTemp", "inverterTemperature", "Inverter_temperature"],
    fanSpeed: ["fanSpeed", "fan_speed", "fan"],
    batteryVoltage: ["battV", "batteryVoltage", "Battery_Voltage"],
    batteryPercentage: ["battPercent", "batteryPercent", "batteryPercentage", "Battery_Percent"],
    batteryChargeAmpere: ["battChargeA", "batteryChargeCurrent", "Battery_Charge_Current"],
    batteryDischargeAmpere: ["battDischargeA", "batteryDischargeCurrent", "Battery_Discharge_Current"],
    pvInstalledReported: ["pvInstalled", "pv_installed"],
    peakSolar: ["peakSolar", "peak_solar"],
    peakLoad: ["peakLoad", "peak_load"],
    netMetering: ["netMetering", "net_metering"],
    realTime: ["realTime", "real_time"],
    serverTime: ["serverTime", "server_time"],
    inverterMode: ["iv_mode", "inverterMode", "Inverter_Operation_Mode"],
    chargingStatus: ["chargingStatus", "chargingType", "Inverter_charge_state"],
    fault: ["fault", "fault_code"],
    outputRatingWatts: ["acOutRatingW", "outputCapacity"],
    outputRatingVoltage: ["acOutRatingV", "outputVoltage"],
    outputRatingHz: ["acOutRatingHz", "outputFrequencyRating"],
    inputVoltageType: ["inputVoltType", "inputVoltageRange"],
    outputSource: ["outputSource", "outputPriority"],
    chargeSource: ["chargeSource", "chargePriority"],
    gridFeed: ["gridFeed", "Grid_Feed"],
    batteryPowerWatts: ["batteryPowerWatts", "batteryPowerW"],
    batteryCurrent: ["batteryCurrent", "batteryAmpere"],
    batteryMode: ["batteryMode"],
    batteryTemperature: ["batteryTemperature", "batteryTemp"],
    transformerTemperature: ["transformerTemperature", "transformerTemp"],
    radiatorTemperature: ["radiatorTemperature", "radiatorTemp"],
    smartLoadWatts: ["smartLoadWatts", "smartLoadW"],
    smartLoadActive: ["smartLoadActive"],
    smartLoadRelay: ["smartLoadRelay"],
    inverterOutputWatts: ["inverterOutputWatts"],
    inverterVoltage: ["inverterVoltage"],
    inverterFrequency: ["inverterFrequency"]
  });

  const TEXT_FIELDS = new Set([
    "deviceId", "name", "localIp", "firmware", "inverterSoftware", "protocol", "model", "netMetering",
    "realTime", "serverTime", "inverterMode", "chargingStatus", "fault", "inputVoltageType", "outputSource", "chargeSource", "batteryMode"
  ]);

  function number(value) {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number.parseFloat(String(value).replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function unwrap(payload) {
    let value = typeof payload === "string" ? JSON.parse(payload) : payload;
    for (let depth = 0; depth < 5; depth += 1) {
      if (Array.isArray(value) && value.length) { value = value[0]; continue; }
      if (!value || typeof value !== "object") break;
      const key = ["dataDTO", "data", "result", "reading", "telemetry"].find((candidate) => value[candidate] && typeof value[candidate] === "object");
      if (!key) break;
      value = value[key];
    }
    if (!value || typeof value !== "object") throw new Error("Unsupported telemetry response");
    return value;
  }

  function pick(source, aliases, numeric = true) {
    for (const key of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, key)) return numeric ? number(source[key]) : source[key];
    }
    return numeric ? null : undefined;
  }

  function finite(value, fallback = 0) { return Number.isFinite(Number(value)) ? Number(value) : fallback; }
  function clamp(value, minimum = 0, maximum = 100) { return Math.min(maximum, Math.max(minimum, finite(value))); }
  function percent(value, limit) { return limit > 0 ? clamp(Math.abs(finite(value)) / limit * 100) : 0; }
  function current(watts, voltage) { return Math.abs(finite(voltage)) > .1 ? finite(watts) / finite(voltage) : 0; }
  function gridDirection(watts, deadband = 5) { return finite(watts) > deadband ? "import" : finite(watts) < -deadband ? "export" : "idle"; }

  function normalize(payload) {
    const source = unwrap(payload);
    const reading = { receivedAt: Date.now() };
    Object.entries(ALIASES).forEach(([field, aliases]) => { reading[field] = pick(source, aliases, !TEXT_FIELDS.has(field)); });
    if (![reading.solarWatts, reading.loadWatts, reading.gridWatts].some(Number.isFinite)) throw new Error("No power values in API response");
    reading.solarWatts = finite(reading.solarWatts);
    reading.pv1Watts = finite(reading.pv1Watts);
    reading.pv2Watts = finite(reading.pv2Watts);
    if (!reading.solarWatts && (reading.pv1Watts || reading.pv2Watts)) reading.solarWatts = reading.pv1Watts + reading.pv2Watts;
    reading.loadWatts = finite(reading.loadWatts);
    reading.gridWatts = finite(reading.gridWatts);
    reading.loadVa = finite(reading.loadVa, reading.loadWatts);
    reading.solarAmpere = Number.isFinite(reading.solarAmpere) ? reading.solarAmpere : current(reading.solarWatts, reading.solarVoltage);
    reading.pv1Ampere = Number.isFinite(reading.pv1Ampere) ? reading.pv1Ampere : current(reading.pv1Watts, reading.pv1Voltage);
    reading.pv2Ampere = Number.isFinite(reading.pv2Ampere) ? reading.pv2Ampere : current(reading.pv2Watts, reading.pv2Voltage);
    reading.loadAmpere = Number.isFinite(reading.loadAmpere) ? reading.loadAmpere : current(reading.loadVa, reading.loadVoltage);
    reading.gridAmpere = Number.isFinite(reading.gridAmpere) ? reading.gridAmpere : current(reading.gridWatts, reading.gridVoltage);
    reading.loadPercentage = Number.isFinite(reading.loadPercentage) ? reading.loadPercentage : percent(reading.loadWatts, CAPACITY.inverterOutputWatts);
    reading.batteryActive = finite(reading.batteryPercentage) > 0 || finite(reading.batteryVoltage) > 5;
    reading.gridDirection = gridDirection(reading.gridWatts);
    const code = String(reading.inverterMode || "").toUpperCase();
    reading.modeLabel = reading.solarWatts > 30 ? (code === "B" ? "Solar Mode" : "Hybrid Mode") : reading.gridWatts > 5 || code ? "Bypass Mode" : "Standby Mode";
    reading.flowHeadline = reading.solarWatts > 30 && reading.gridDirection === "export" ? "Solar powers the home and exports the surplus"
      : reading.solarWatts > 30 && reading.gridDirection === "import" ? "Solar and grid are sharing the home load"
      : reading.solarWatts > 30 ? "Solar is powering your home"
      : reading.gridDirection === "import" ? "The grid is powering your home"
      : reading.gridDirection === "export" ? "Power is being exported to the grid"
      : reading.loadWatts > 20 ? "Your home load is active" : "The inverter is online and standing by";
    reading.smartLoadActive = Boolean(source.smartLoadActive) || finite(reading.smartLoadWatts) >= 50;
    reading.raw = source;
    return reading;
  }

  function normalizeEnergy(payload, period = "T") {
    const source = payload && typeof payload === "object" && payload.data && typeof payload.data === "object" ? payload.data : payload;
    const n = (key) => finite(source && source[key]);
    const solarKwh = n("todaySolar");
    const importKwh = n("todayGrid");
    const exportKwh = n("todayNetGrid");
    const rate = n("rate");
    return {
      period,
      solarKwh,
      importKwh,
      exportKwh,
      loadKwh: n("todayLoad"),
      netSolarKwh: n("todayNetSolar"),
      totalEnergyKwh: n("todayTotal"),
      rate,
      savings: solarKwh * rate,
      exportAfterUseKwh: Math.max(0, exportKwh - importKwh),
      raw: source || {}
    };
  }

  function historyPoint(reading) {
    return {
      timestamp: Number(reading.receivedAt) || Date.now(),
      solarW: finite(reading.solarWatts), pv1W: finite(reading.pv1Watts), pv2W: finite(reading.pv2Watts),
      loadW: finite(reading.loadWatts), gridW: finite(reading.gridWatts), gridV: finite(reading.gridVoltage),
      outputV: finite(reading.loadVoltage), temperature: finite(reading.heatSinkTemperature || reading.inverterTemperature), fan: finite(reading.fanSpeed)
    };
  }

  root.PCTelemetry = { CAPACITY, ALIASES, number, unwrap, finite, clamp, percent, current, gridDirection, normalize, normalizeEnergy, historyPoint };
})(typeof globalThis !== "undefined" ? globalThis : window);
