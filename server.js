import express from "express";
import path from "path";
import { fileURLToPath } from "url";
const app=express();
const __filename=fileURLToPath(import.meta.url);
const __dirname=path.dirname(__filename);
const PORT=Number(process.env.PORT||10000);
const BASE_URL=process.env.SOLARMAN_BASE_URL||"https://globalapi.solarmanpv.com";
const APP_ID=process.env.SOLARMAN_APP_ID||"";
const APP_SECRET=process.env.SOLARMAN_APP_SECRET||"";
const EMAIL=process.env.SOLARMAN_EMAIL||"";
const PASSWORD_HASH=process.env.SOLARMAN_PASSWORD_HASH||"";
const ORG_ID=Number(process.env.SOLARMAN_ORG_ID||195093);
const DEVICE_SN=process.env.SOLARMAN_DEVICE_SN||"0230306052";
const STATION_ID=Number(process.env.SOLARMAN_STATION_ID||3332398);
app.use(express.static(path.join(__dirname,"public")));
app.get("/",(req,res)=>{res.sendFile(path.join(__dirname,"public","index.html"));});
let tokenCache={token:"",expiresAt:0};
async function getToken(){
 const now=Date.now();
 if(tokenCache.token&&now<tokenCache.expiresAt-300000)return tokenCache.token;
 if(!APP_ID||!APP_SECRET||!EMAIL||!PASSWORD_HASH)throw new Error("Missing SOLARMAN environment variables");
 const url=`${BASE_URL}/account/v1.0/token?appId=${encodeURIComponent(APP_ID)}&language=en`;
 const r=await fetch(url,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({appSecret:APP_SECRET,email:EMAIL,password:PASSWORD_HASH,orgId:ORG_ID})});
 const d=await r.json();
 if(!d.success||!d.access_token)throw new Error(d.msg||"SOLARMAN token request failed");
 tokenCache={token:d.access_token,expiresAt:now+Number(d.expires_in||3600)*1000};
 return tokenCache.token;
}
async function solarmanPost(path,body){
 const token=await getToken();
 const r=await fetch(`${BASE_URL}${path}`,{method:"POST",headers:{"content-type":"application/json",Authorization:`bearer ${token}`},body:JSON.stringify(body)});
 return r.json();
}
function mapDataList(list=[]){const m={};for(const x of list)m[x.key]={value:x.value,unit:x.unit,name:x.name};return m}
function n(m,k){const v=m[k]?.value;if(v===""||v==null)return null;const x=Number(v);return Number.isFinite(x)?x:null}
function s(m,k){const v=m[k]?.value;return v==null?null:String(v)}
function normalize(raw){
 const m=mapDataList(raw.dataList||[]),smartRaw=n(m,"GEN_P_T"),batRaw=n(m,"B_Pdcg1"),ct=n(m,"CT_P_T");
 return {success:true,deviceSn:raw.deviceSn,deviceId:raw.deviceId,deviceType:raw.deviceType,online:Number(raw.deviceState)===1,collectionTime:Number(raw.collectionTime||0)*1000,
  inverter:{ratedW:n(m,"Pr1"),outputW:n(m,"I_O_P_LN"),voltageV:n(m,"I_V_LN"),frequencyHz:n(m,"I_O_F1"),runningStatusRaw:n(m,"RS_D"),gridRelayRaw:n(m,"GRID_RELAY_ST1")},
  solar:{pv1V:n(m,"DV1"),pv1A:n(m,"DC1"),pv1W:n(m,"DP1"),pv2V:n(m,"DV2"),pv2A:n(m,"DC2"),pv2W:n(m,"DP2"),totalW:[n(m,"DP1"),n(m,"DP2"),n(m,"DP3"),n(m,"DP4")].filter(v=>v!=null).reduce((a,b)=>a+b,0),todayKwh:n(m,"PVDE")??n(m,"Etdy_ge1"),totalKwh:n(m,"E_PVhis_ge1")},
  load:{powerW:n(m,"E_Puse_t1"),voltageV:n(m,"C_V_L1"),todayKwh:n(m,"Etdy_use1"),totalKwh:n(m,"Et_use1")},
  grid:{voltageV:n(m,"G_V_L1")??n(m,"G_V_LN"),currentA:n(m,"G_C_L1"),frequencyHz:n(m,"PG_F1"),reportedPowerW:n(m,"PG_Pt1"),ctPowerRawW:ct,todayImportKwh:n(m,"Etdy_pu1")??n(m,"E_B_D"),totalImportKwh:n(m,"Et_pu1")??n(m,"E_B_TO"),todayExportKwh:n(m,"t_gc_tdy1"),totalExportKwh:n(m,"t_gc1")},
  battery:{socPct:n(m,"B_R_C"),voltageV:n(m,"B_V1"),currentA:n(m,"B_C1"),powerRawW:batRaw,powerW:batRaw==null?null:Math.abs(batRaw),todayChargeKwh:n(m,"Etdy_cg1"),todayDischargeKwh:n(m,"Etdy_dcg1"),totalChargeKwh:n(m,"t_cg_n1"),totalDischargeKwh:n(m,"t_dcg_n1"),temperatureC:n(m,"B_T1")},
  smartLoad:{rawPowerW:smartRaw,powerW:smartRaw==null?null:Math.abs(smartRaw),active:smartRaw!=null?Math.abs(smartRaw)>=50:false,relayRaw:n(m,"ST_EG_RELAY1"),frequencyHz:n(m,"EG_F1"),voltageV:n(m,"PVGP_A"),todayKwh:n(m,"GEN_P_D"),totalKwh:n(m,"EG_t_ge1"),dailyHours:n(m,"GDOH")},
  temperature:{batteryC:n(m,"B_T1"),transformerC:n(m,"T_TFM1"),radiatorC:n(m,"T_RDT1")},
  alarms:{fault1:s(m,"Fault_Code1"),fault2:s(m,"Fault_Code2"),fault3:s(m,"Fault_Code3"),fault4:s(m,"Fault_Code4"),alarm1:n(m,"INV_ERR_STin1"),alarm2:n(m,"INV_ERR_STin2")},raw:m};
}
let cache={at:0,data:null};
app.get('/api/matrix',async(req,res)=>{try{if(cache.data&&Date.now()-cache.at<4000)return res.json(cache.data);const raw=await solarmanPost('/device/v1.0/currentData?language=en',{deviceSn:DEVICE_SN});if(!raw.success)throw new Error(raw.msg||'SOLARMAN currentData failed');const data=normalize(raw);cache={at:Date.now(),data};res.json(data)}catch(e){res.status(500).json({success:false,msg:e.message})}});
app.get('/api/station',async(req,res)=>{try{res.json(await solarmanPost('/station/v1.0/list?language=en',{page:1,size:20}))}catch(e){res.status(500).json({success:false,msg:e.message})}});
let wc={at:0,data:null};
app.get('/api/weather',async(req,res)=>{try{if(wc.data&&Date.now()-wc.at<600000)return res.json(wc.data);const q=new URLSearchParams({latitude:'32.568498',longitude:'74.044652',timezone:'Asia/Karachi',current:'temperature_2m,weather_code,cloud_cover,relative_humidity_2m,wind_speed_10m',forecast_days:'1'});const r=await fetch(`https://api.open-meteo.com/v1/forecast?${q}`);const d=await r.json();const out={success:true,current:d.current||null,timezone:d.timezone};wc={at:Date.now(),data:out};res.json(out)}catch(e){res.status(500).json({success:false,msg:e.message})}});
app.get('/api/health',(req,res)=>res.json({success:true,service:'Fronus Matrix 6K Dashboard',deviceSn:DEVICE_SN,stationId:STATION_ID}));
app.listen(PORT,()=>console.log(`Fronus Matrix dashboard listening on ${PORT}`));
