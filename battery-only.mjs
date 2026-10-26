// Battery-only, fixed-device projection. Never substitutes receipt time for collection time.
export function batteryOnly(raw, expectedDevice, now = Date.now()) {
  const values = Object.fromEntries((raw?.dataList || []).map(row => [row.key, row.value]));
  const n = key => values[key] == null || values[key] === '' || !Number.isFinite(Number(values[key])) ? null : Number(values[key]);
  const device = String(raw?.deviceSn || values.SN1 || '');
  const timestamp = Number(raw?.collectionTime) > 0 ? Number(raw.collectionTime) * 1000 : null;
  const matched = device === String(expectedDevice);
  const fresh = matched && timestamp !== null && now - timestamp >= -30000 && now - timestamp <= 15 * 60000;
  const power = n('B_Pdcg1');
  const soc = n('B_R_C');
  const temperature = n('B_T1');
  return {
    deviceId: device, expectedDeviceId: String(expectedDevice), timestamp,
    status: !matched ? 'device_mismatch' : fresh ? 'live' : 'stale',
    scope: 'battery_only',
    batterySoc: fresh && soc >= 0 && soc <= 100 ? soc : null,
    batteryVoltage: fresh ? n('B_V1') : null,
    batteryCurrent: fresh ? n('B_C1') : null,
    batteryPower: fresh ? power : null,
    batteryTemperature: fresh && temperature > -50 && temperature < 100 ? temperature : null,
    batteryMode: !fresh || power === null ? 'unknown' : Math.abs(power) < 20 ? 'idle' : power < 0 ? 'charging' : 'discharging',
    todayBatteryCharge: fresh ? n('Etdy_cg1') : null,
    todayBatteryDischarge: fresh ? n('Etdy_dcg1') : null
  };
}
