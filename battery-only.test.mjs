import test from 'node:test';
import assert from 'node:assert/strict';
import { batteryOnly } from './battery-only.mjs';
const now = Date.now();
const input = {deviceSn:'221101401',collectionTime:Math.floor(now/1000),dataList:[{key:'B_R_C',value:'77'},{key:'B_Pdcg1',value:'-200'},{key:'B_V1',value:'52.8'},{key:'B_T1',value:'25'},{key:'DP1',value:'4000'}]};
test('exposes battery only with verified charge direction',()=>{const b=batteryOnly(input,'221101401',now);assert.equal(b.batterySoc,77);assert.equal(b.batteryMode,'charging');assert.equal(b.batteryVoltage,52.8);assert.equal(b.scope,'battery_only');assert.equal(b.solarW,undefined);});
test('rejects old or mismatched devices and unknown timestamps',()=>{for(const patch of [{deviceSn:'0230306052'},{collectionTime:now/1000-86400},{collectionTime:undefined}]){const b=batteryOnly({...input,...patch},'221101401',now);assert.equal(b.batterySoc,null);assert.notEqual(b.status,'live');}});
test('keeps unknown readings null',()=>{const b=batteryOnly({...input,dataList:[]},'221101401',now);assert.equal(b.batterySoc,null);assert.equal(b.batteryMode,'unknown');});
