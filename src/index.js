// Phase 1: public-market-data diagnostics only. No secrets, orders, or stored state.
import { collectAndSaveDerivatives, derivativesAudit, derivativesLatest } from "./derivatives.js";
import { mergeSpotRows } from "./spot-quality.js";

const COINS=["BTC","ETH","SOL","LINK","PENDLE","ONDO"];
const HOUR=3600000;
const respond=(data,status=200)=>new Response(JSON.stringify(data,null,2),{
 status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}
});
const iso=ms=>new Date(ms).toISOString();

async function api(path,params) {
 const url=new URL("https://api.bitget.com"+path);
 Object.entries(params).forEach(([k,v])=>url.searchParams.set(k,String(v)));
 let err;
 for(let attempt=0;attempt<2;attempt++){
  try {
   const res=await fetch(url.toString(),{headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
   if(!res.ok) throw Error("HTTP_"+res.status);
   const json=await res.json();
   if(String(json.code)!=="00000"||!Array.isArray(json.data)) throw Error("BAD_RESPONSE_"+json.code);
   return json.data;
  }catch(e){err=e;if(attempt===0)await new Promise(r=>setTimeout(r,450));}
 }
 throw Error(String(err));
}
function candles(rows,hours,now){
 const duration=hours*HOUR,found=[];
 if(!Array.isArray(rows))throw Error("NOT_ARRAY");
 for(const raw of rows){
  if(!Array.isArray(raw)||raw.length<7)continue;
  const [t,o,h,l,c,vol,turn]=raw.slice(0,7).map(Number);
  if(![t,o,h,l,c,vol,turn].every(Number.isFinite))continue;
  const offset=hours===24?16*HOUR:0;
  if(t%duration!==offset||t<1500000000000||t>now)continue;
  if(Math.min(o,h,l,c)<=0||l>Math.min(o,c)||h<Math.max(o,c)||h<l||vol<=0||turn<=0)continue;
  if(t+duration+30000>now)continue;
  found.push({open_ms:t,open_utc:iso(t),open:o,high:h,low:l,close:c,base_volume:vol,quote_turnover:turn});
 }
 found.sort((a,b)=>a.open_ms-b.open_ms);
 const unique=found.filter((r,i)=>i===0||r.open_ms!==found[i-1].open_ms);
 const recent=unique.slice(-4);
 if(recent.length<4)throw Error("TOO_FEW_CLOSED_BARS");
 for(let i=1;i<recent.length;i++)if(recent[i].open_ms-recent[i-1].open_ms!==duration)throw Error("RECENT_CANDLE_GAP");
 const age=now-(recent.at(-1).open_ms+duration);
 if(age< -60000||age>duration+15*60000)throw Error("CLOSED_BAR_STALE");
 return {status:"READY",time_basis:hours===24?"Bitget UTC+8 day, opens 16:00 UTC":"UTC four-hour boundary",
  last_close_utc:iso(recent.at(-1).open_ms+duration),minutes_since_last_close:Math.round(age/60000),
  recent_completed:recent};
}
async function coinData(coin,now){
 const symbol=coin+"USDT";
 const calls=[
  api("/api/v3/market/tickers",{category:"SPOT",symbol}),
  api("/api/v3/market/candles",{category:"SPOT",symbol,interval:"4H",limit:"20"}),
  api("/api/v3/market/candles",{category:"SPOT",symbol,interval:"1D",limit:"12"})
 ];
 const results=await Promise.allSettled(calls),item={symbol,venue:"Bitget",status:"UNKNOWN",errors:[]};
 if(results[0].status==="fulfilled"){
  try{
   const row=results[0].value.find(x=>x.symbol===symbol);
   if(!row)throw Error("TICKER_MISSING");
   const ts=Number(row.ts),price=Number(row.lastPrice);
   if(!Number.isFinite(ts)||!Number.isFinite(price)||price<=0)throw Error("INVALID_TICKER");
   if(now-ts>10*60000||ts-now>60000)throw Error("STALE_EXCHANGE_QUOTE_TIMESTAMP");
   item.quote={price_usdt:price,exchange_quote_timestamp_utc:iso(ts),age_seconds:Math.round((now-ts)/1000)};
  }catch(e){item.errors.push("quote:"+e.message);}
 }else item.errors.push("quote:"+String(results[0].reason));
 for(const [i,label,hours] of [[1,"kline_4h",4],[2,"kline_1d",24]]){
  if(results[i].status==="fulfilled"){
   try{item[label]=candles(results[i].value,hours,now);}
   catch(e){item.errors.push(label+":"+e.message);}
  }else item.errors.push(label+":"+String(results[i].reason));
 }
 if(item.quote&&item.kline_4h&&item.kline_1d)item.status="READY";
 return item;
}
async function collect(){
 const now=Date.now(),res=await Promise.allSettled(COINS.map(c=>coinData(c,now)));
 const assets=Object.fromEntries(COINS.map((coin,i)=>[coin,res[i].status==="fulfilled"?res[i].value:
  {symbol:coin+"USDT",status:"UNKNOWN",errors:[String(res[i].reason)]}]));
 const ready=Object.values(assets).filter(x=>x.status==="READY").length;
 return {schema_version:"0.1.0",generated_at_utc:iso(now),source:"Bitget v3 spot",
  dataset_status:ready===COINS.length?"READY":"INCOMPLETE",ready_symbols:ready,total_symbols:6,
  disclaimer:"Diagnostics only; NOT persisted, no derivatives data, no trading signals.",assets};
}

// Connectivity-only probes. Run on demand to locate a public data source accessible from Cloudflare.
// This is NOT market-data validation or a fallback feed yet.
const SOURCE_PROBES=[
 {name:"OKX",ticker:"https://www.okx.com/api/v5/market/ticker?instId=BTC-USDT",
  bars:"https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=4H&limit=3"},
 {name:"Gate Global",ticker:"https://api.gateio.ws/api/v4/spot/tickers?currency_pair=BTC_USDT",
  bars:"https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=4h&limit=3"},
 {name:"Gate US",ticker:"https://api.gate.us/api/v4/spot/tickers?currency_pair=BTC_USDT",
  bars:"https://api.gate.us/api/v4/spot/candlesticks?currency_pair=BTC_USDT&interval=4h&limit=3"},
 {name:"Binance Public Data",ticker:"https://data-api.binance.vision/api/v3/ticker/price?symbol=BTCUSDT",
  bars:"https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=4h&limit=3"}
];
async function sourceRequest(url,venue,kind){
 try {
  const res=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(8000)});
  if(!res.ok)return {http_status:res.status,state:"HTTP_ERROR"};
  let data;
  try{data=await res.json();}catch(e){return {http_status:200,state:"NON_JSON_RESPONSE"};}
  let price=NaN,candles=0,latestTime=NaN;
  if(venue==="OKX"){
   if(data?.code!=="0"||!Array.isArray(data.data))throw Error("OKX_APPLICATION_ERROR_"+String(data?.code));
   if(kind==="ticker")price=Number(data.data[0]?.last);
   else{candles=data.data.length;latestTime=Math.max(...data.data.map(r=>Number(r[0])));}
  }else if(venue.startsWith("Gate")){
   if(!Array.isArray(data))throw Error("GATE_DATA_NOT_ARRAY");
   if(kind==="ticker")price=Number(data[0]?.last);
   else{candles=data.length;latestTime=Math.max(...data.map(r=>Number(r[0])*1000));}
  }else{
   if(kind==="ticker")price=Number(data?.price);
   else if(Array.isArray(data)){candles=data.length;latestTime=Math.max(...data.map(r=>Number(r[0])));}
  }
  if(kind==="ticker"){
   if(!Number.isFinite(price)||price<=0)throw Error("INVALID_PRICE");
   return {http_status:200,state:"VALID_RESPONSE",price_usdt:price,quote_timestamp_verified:false};
  }
  if(candles<2||!Number.isFinite(latestTime)||latestTime<1500000000000)throw Error("INVALID_CANDLES");
  return {http_status:200,state:"VALID_RESPONSE",candles_returned:candles,
   latest_candle_open_utc:iso(latestTime),
   latest_open_age_hours:Math.round((Date.now()-latestTime)/HOUR*10)/10};
 }catch(e){return {state:"ERROR",reason:String(e?.message||e).slice(0,140)};}
}
async function sourceDiagnostics(){
 const checked=await Promise.all(SOURCE_PROBES.map(async p=>{
  const [ticker,bars]=await Promise.all([
   sourceRequest(p.ticker,p.name,"ticker"),sourceRequest(p.bars,p.name,"bars")
  ]);
  return {venue:p.name,
   probe_status:ticker.state==="VALID_RESPONSE"&&bars.state==="VALID_RESPONSE"
    ?"PUBLIC_ENDPOINTS_REACHABLE":"UNAVAILABLE_OR_INCOMPLETE",
   ticker,candles_4h:bars};
 }));
 return {phase:"CONNECTIVITY_ONLY",generated_at_utc:iso(Date.now()),
  why:"Bitget returned HTTP 403 from Cloudflare on 18 requests. Testing independent venues without any credentials.",
  warning:"A reachable BTC test does not establish six-asset availability, quote freshness, history continuity, derivatives or automated failover.",
  results:checked};
}


// Phase 1B: candidate Gate spot source. This probe is NOT eligible for production signals.
const GATE_HOSTS=[
 {id:"Gate Global",host:"https://api.gateio.ws"},
 {id:"Gate US",host:"https://api.gate.us"}
];
async function gateRequest(host,path,params){
 const url=new URL(host+"/api/v4"+path);
 for(const [k,v]of Object.entries(params))url.searchParams.set(k,String(v));
 const res=await fetch(url.toString(),{
  headers:{accept:"application/json"},signal:AbortSignal.timeout(9000)});
 if(!res.ok)throw Error("HTTP_"+res.status);
 const data=await res.json();
 if(!Array.isArray(data))throw Error("NON_ARRAY_GATE_RESPONSE");
 return data;
}
function gateBars(rows,hours,now){
 const span=hours*HOUR,valid=[];
 for(const raw of rows){
  // Gate API v4: [epoch_seconds, quote_volume, close, high, low, open, base_volume?, is_closed?]
  if(!Array.isArray(raw)||raw.length<6)continue;
  const t=Number(raw[0])*1000,q=Number(raw[1]),c=Number(raw[2]),
   h=Number(raw[3]),l=Number(raw[4]),o=Number(raw[5]);
  if(![t,q,c,h,l,o].every(Number.isFinite))continue;
  if(t<1500000000000||t>now||t%span!==0||t+span+30000>now)continue;
  if(q<=0||Math.min(o,h,l,c)<=0||l>Math.min(o,c)||h<Math.max(o,c)||h<l)continue;
  // If API explicitly marks an interval not closed, never treat it as complete.
  if(raw.length>=8 && String(raw[7]).toLowerCase()==="false")continue;
  const b=raw.length>=7 && typeof raw[6]!=="boolean"?Number(raw[6]):NaN;
  valid.push({open_ms:t,open_utc:iso(t),open:o,high:h,low:l,close:c,
   quote_volume:q,base_volume:Number.isFinite(b)&&b>0?b:null});
 }
 valid.sort((a,b)=>a.open_ms-b.open_ms);
 const u=valid.filter((v,i)=>i===0||v.open_ms!==valid[i-1].open_ms),last=u.slice(-4);
 if(last.length<4)throw Error("INSUFFICIENT_COMPLETED_4_CANDLES");
 for(let i=1;i<last.length;i++)if(last[i].open_ms-last[i-1].open_ms!==span)
  throw Error("RECENT_CANDLE_GAP");
 const age=now-(last.at(-1).open_ms+span);
 if(age< -60000||age>span+15*60000)throw Error("CANDLE_STALE");
 return {status:"KLINE_VALID",time_basis:"UTC",last_completed_close_utc:iso(last.at(-1).open_ms+span),
  minutes_since_last_close:Math.round(age/60000),recent_completed:last};
}
async function gateCoin(coin,venue,now){
 const pair=coin+"_USDT",out={pair,venue:venue.id,status:"INCOMPLETE",errors:[]};
 const endpoints=[
  gateRequest(venue.host,"/spot/tickers",{currency_pair:pair}),
  gateRequest(venue.host,"/spot/candlesticks",{currency_pair:pair,interval:"4h",limit:"18"}),
  gateRequest(venue.host,"/spot/candlesticks",{currency_pair:pair,interval:"1d",limit:"12"})
 ];
 const all=await Promise.allSettled(endpoints);
 if(all[0].status==="fulfilled"){
  try{
   const row=all[0].value.find(r=>r.currency_pair===pair);
   const price=Number(row?.last);
   if(!Number.isFinite(price)||price<=0)throw Error("INVALID_TICKER");
   out.quote={price_usdt:price,exchange_trade_time_verified:false,
    note:"Gate ticker does not attest its latest trade timestamp; not yet a live signal."};
  }catch(e){out.errors.push("quote:"+e.message);}
 }else out.errors.push("quote:"+String(all[0].reason));
 for(const [i,name,hours]of [[1,"kline_4h",4],[2,"kline_1d",24]]){
  if(all[i].status==="fulfilled"){
   try{out[name]=gateBars(all[i].value,hours,now);}
   catch(e){out.errors.push(name+":"+e.message);}
  }else out.errors.push(name+":"+String(all[i].reason));
 }
 if(out.quote&&out.kline_4h&&out.kline_1d)
  out.status="KLINES_VALID_QUOTE_TIME_UNVERIFIED";
 return out;
}
async function gateSnapshot(){
 const now=Date.now();
 const venues=await Promise.all(GATE_HOSTS.map(async v=>{
  const settled=await Promise.allSettled(COINS.map(coin=>gateCoin(coin,v,now)));
  const assets=Object.fromEntries(COINS.map((coin,i)=>[coin,settled[i].status==="fulfilled"?
   settled[i].value:{pair:coin+"_USDT",status:"INCOMPLETE",
   errors:[String(settled[i].reason)]}]));
  return {venue:v.id,valid_coin_count:Object.values(assets).filter(x=>
   x.status==="KLINES_VALID_QUOTE_TIME_UNVERIFIED").length,assets};
 }));
 return {phase:"SIX_COIN_GATE_SOURCE_QUALIFICATION",generated_at_utc:iso(now),
  dataset_status:"NOT_PRODUCTION_READY",notes:[
   "Actual Cloudflare-to-Gate spot calls; checks six USDT pairs at two hostnames.",
   "Validation excludes open/zero-volume/malformed candles and requires 4 recent contiguous finished bars.",
   "Gate last-price ticker timestamp remains UNVERIFIED. Additional trade-time validation is mandatory.",
   "Gate Global and Gate US may share market infrastructure; do not count them as independent market corroboration.",
   "No R2/GitHub persistence or derivatives history in this version."
  ],venues};
}


// Phase 1C: verify actual public trade timestamps for six Gate Global spot pairs.
// Nothing here persists data or promotes signals to production.
async function gateTradeFreshness(){
 const venue=GATE_HOSTS[0],now=Date.now();
 const all=await Promise.allSettled(COINS.map(async coin=>{
  const pair=coin+"_USDT";
  const r=await Promise.allSettled([
   gateRequest(venue.host,"/spot/trades",{currency_pair:pair,limit:"3"}),
   gateRequest(venue.host,"/spot/tickers",{currency_pair:pair})
  ]);
  const o={pair,status:"UNKNOWN",errors:[]};
  if(r[0].status==="fulfilled"){
   try{
    const candidates=r[0].value.map(t=>{
     const ts=Number(t.create_time_ms??Number(t.create_time)*1000);
     const price=Number(t.price);
     return {ts,price,id:String(t.id??"")};
    }).filter(x=>Number.isFinite(x.ts)&&x.ts>1500000000000&&
        Number.isFinite(x.price)&&x.price>0).sort((a,b)=>b.ts-a.ts);
    if(!candidates.length)throw Error("NO_VALID_TRADE_WITH_TIMESTAMP");
    const trade=candidates[0],age=now-trade.ts;
    o.latest_trade={id:trade.id,price_usdt:trade.price,
     exchange_trade_time_utc:iso(trade.ts),
     age_seconds:Math.round(age/1000)};
    if(age< -60*1000)throw Error("TRADE_TIMESTAMP_IN_FUTURE");
    if(age>5*60*1000)throw Error("TRADE_STALE_GT_5_MIN");
   }catch(e){o.errors.push("trades:"+e.message);}
  }else o.errors.push("trades:"+String(r[0].reason));
  if(r[1].status==="fulfilled"){
   try{
    const ticker=r[1].value.find(x=>x.currency_pair===pair);
    const p=Number(ticker?.last);
    if(!Number.isFinite(p)||p<=0)throw Error("INVALID_TICKER");
    o.ticker={price_usdt:p,trade_time_not_in_ticker:true};
    if(o.latest_trade){
     const pct=Math.abs(p-o.latest_trade.price_usdt)/o.latest_trade.price_usdt*100;
     o.ticker_vs_last_trade_diff_pct=Math.round(pct*10000)/10000;
     if(pct>1)throw Error("TRADE_TICKER_DIVERGENCE_GT_1_PCT");
    }
   }catch(e){o.errors.push("ticker:"+e.message);}
  }else o.errors.push("ticker:"+String(r[1].reason));
  if(o.errors.length===0&&o.latest_trade&&o.ticker)o.status="FRESH_VALIDATED";
  return o;
 }));
 const assets=Object.fromEntries(COINS.map((c,i)=>[c,all[i].status==="fulfilled"?
  all[i].value:{pair:c+"_USDT",status:"UNKNOWN",errors:[String(all[i].reason)]}]));
 const ready=Object.values(assets).filter(x=>x.status==="FRESH_VALIDATED").length;
 return {phase:"GATE_PUBLIC_LAST_TRADE_TIME_VERIFICATION",venue:"Gate Global",
  generated_at_utc:iso(now),fresh_trade_pairs:ready,total_pairs:6,
  qualification:ready===6?"SIX_TRADES_FRESH":"INCOMPLETE",
  note:"Public trades timestamps, positive prices, and ticker/trade divergence <=1%. Still NOT production-ready without persistence and end-to-end Cron verification.",
  assets};
}


// Phase 2: Gate-only live market snapshot and optional R2 durable archive.
// NOTE: Not yet a trading-signal feed until recurring collection & R2 retention are verified.
async function gateVerifiedCoin(coin,now){
 const venue=GATE_HOSTS[0],pair=coin+"_USDT";
 const [candlesResult,tradesResult]=await Promise.allSettled([
  gateCoin(coin,venue,now),
  gateRequest(venue.host,"/spot/trades",{currency_pair:pair,limit:"3"})
 ]);
 const asset=candlesResult.status==="fulfilled"?candlesResult.value:
  {pair,status:"INCOMPLETE",errors:["candles:"+String(candlesResult.reason)]};
 asset.errors=asset.errors||[];
 if(tradesResult.status==="fulfilled"){
  try {
   const trades=tradesResult.value.map(t=>({
    ts:Number(t.create_time_ms??Number(t.create_time)*1000),
    price:Number(t.price),id:String(t.id??"")
   })).filter(x=>Number.isFinite(x.ts)&&x.ts>1500000000000&&
    Number.isFinite(x.price)&&x.price>0).sort((a,b)=>b.ts-a.ts);
   if(!trades.length)throw Error("NO_VALID_TRADE_WITH_TIMESTAMP");
   const last=trades[0],age=now-last.ts;
   if(age< -60000)throw Error("TRADE_TIMESTAMP_FUTURE");
   if(age>5*60000)throw Error("LATEST_TRADE_STALE_OVER_5_MIN");
   asset.latest_trade={price_usdt:last.price,id:last.id,exchange_time_utc:iso(last.ts),age_seconds:Math.round(age/1000)};
   if(!asset.quote)throw Error("CANDLE_OR_TICKER_INCOMPLETE");
   const diff=Math.abs(asset.quote.price_usdt-last.price)/last.price*100;
   asset.ticker_vs_trade_diff_pct=Math.round(diff*10000)/10000;
   if(diff>1)throw Error("TICKER_LAST_TRADE_DIVERGENCE_OVER_1_PCT");
  }catch(e){asset.errors.push("trades:"+e.message);}
 }else asset.errors.push("trades:"+String(tradesResult.reason));
 asset.status=asset.errors.length===0&&asset.kline_4h&&asset.kline_1d&&asset.latest_trade?
  "READY":"UNKNOWN";
 return asset;
}
async function gateValidatedSnapshot(){
 const now=Date.now(),res=await Promise.allSettled(COINS.map(c=>gateVerifiedCoin(c,now)));
 const assets=Object.fromEntries(COINS.map((c,i)=>[c,res[i].status==="fulfilled"?res[i].value:
  {pair:c+"_USDT",status:"UNKNOWN",errors:[String(res[i].reason)]}]));
 const ready=Object.values(assets).filter(v=>v.status==="READY").length;
 return {schema_version:"0.3.0",generated_at_utc:iso(now),source:"Gate Global SPOT public REST",
  dataset_status:ready===6?"READY":"INCOMPLETE",ready_symbols:ready,total_symbols:6,
  data_scope:"Latest verified quotes and last four completed 4H/1D candles; not long-term history.",
  limitations:"No OI, liquidation, funding, full multi-venue redundancy or trade execution.",
  assets};
}
// Phase 2B: Workers Free D1 storage (no paid R2 required).
// The Worker has exactly one scheduled write opportunity per 15-minute UTC slot.
// Endpoint /snapshot remains read-only; /latest reads saved D1 snapshots.
const D1_SLOT_MS=15*60*1000;
const D1_KEEP_DAYS=30;
const D1_MAX_BYTES=160000;
const D1_SQL_CREATE="CREATE TABLE IF NOT EXISTS crypto_snapshots ("+
 "slot INTEGER PRIMARY KEY, collected_at_ms INTEGER NOT NULL, "+
 "status TEXT NOT NULL, ready_count INTEGER NOT NULL, payload TEXT NOT NULL)";
const D1_SQL_UPSERT="INSERT INTO crypto_snapshots (slot,collected_at_ms,status,ready_count,payload) "+
 "VALUES (?1,?2,?3,?4,?5) ON CONFLICT(slot) DO UPDATE SET "+
 "collected_at_ms=excluded.collected_at_ms,status=excluded.status,"+
 "ready_count=excluded.ready_count,payload=excluded.payload "+
 "WHERE excluded.ready_count>crypto_snapshots.ready_count";
async function saveGateSnapshot(env,snapshot,trigger){
 const db=env?.MARKET_DB;
 if(!db)return {storage:"NOT_CONFIGURED",persisted:false,
  next_step:"Create D1 crypto-market-db and bind as MARKET_DB"};
 const now=Date.parse(snapshot.generated_at_utc);
 if(!Number.isFinite(now))throw Error("SNAPSHOT_TIME_INVALID");
 const slot=Math.floor(now/D1_SLOT_MS),payload=JSON.stringify(snapshot);
 const bytes=new TextEncoder().encode(payload).length;
 if(bytes>D1_MAX_BYTES)throw Error("D1_SNAPSHOT_SIZE_CAP_EXCEEDED_"+bytes);
 await db.prepare(D1_SQL_CREATE).run();
 const write=await db.prepare(D1_SQL_UPSERT).bind(slot,now,snapshot.dataset_status,
  snapshot.ready_symbols,payload).run();
 // Retention maintenance once daily; no unbounded data growth.
 if(slot%96===0){
  const cutoff=slot-D1_KEEP_DAYS*96;
  await db.prepare("DELETE FROM crypto_snapshots WHERE slot < ?1").bind(cutoff).run();
 }
 return {storage:"D1",persisted:write.success!==false,slot,
  bytes,write_count:write.meta?.rows_written??null,trigger,
  retention_days:D1_KEEP_DAYS};
}
// Independent latest per-coin D1 snapshots. A thin PENDLE spot market must
// not invalidate a recent verified BTC/ETH/SOL/LINK/ONDO record.
async function gateLatestSpotAssets(env){
 if(!env?.MARKET_DB)return {status:"STORAGE_NOT_CONFIGURED",storage:"D1"};
 try{
  const q=await env.MARKET_DB.prepare(
   "SELECT collected_at_ms,payload FROM crypto_snapshots ORDER BY slot DESC LIMIT 12"
  ).all();
  return mergeSpotRows(q.results||[],Date.now());
 }catch(e){
  return {status:"D1_QUERY_FAILED",storage:"D1",
   error:String(e?.message||e).slice(0,180)};
 }
}
async function gateLastSaved(env){
 const db=env?.MARKET_DB;
 if(!db)return {status:"STORAGE_NOT_CONFIGURED",storage:"D1",persistence_enabled:false};
 try{
  const [last,good]=await Promise.all([
   db.prepare("SELECT slot,collected_at_ms,status,ready_count FROM crypto_snapshots ORDER BY slot DESC LIMIT 1").first(),
   db.prepare("SELECT payload,collected_at_ms FROM crypto_snapshots WHERE status='READY' ORDER BY slot DESC LIMIT 1").first()
  ]);
  if(!good)return {status:"NO_SAVED_GOOD_SNAPSHOT",storage:"D1",last_attempt:last||null};
  const content=JSON.parse(good.payload);
  const age=Date.now()-Number(good.collected_at_ms);
  const fresh=age>=-60000&&age<=30*60000;
  return {status:fresh?"FRESH":"STALE",storage:"D1",age_minutes:Math.round(age/60000),
   last_attempt:last||null,snapshot:content};
 }catch(e){return {status:"STORAGE_QUERY_FAILED",storage:"D1",
  error:String(e?.message||e).slice(0,200)};}
}



// Read-only D1 operations audit: measures actual persisted 15-min slots, not claimed uptime.
async function gateStorageAudit(env){
 if(!env?.MARKET_DB)return {status:"STORAGE_NOT_CONFIGURED",storage:"D1"};
 const now=Date.now(),currentSlot=Math.floor(now/D1_SLOT_MS),startSlot=currentSlot-95;
 const cronGraceMs=7*60000; // allow 7 minutes after each 15m Cron slot
 const latestDueSlot=Math.floor((now-cronGraceMs)/D1_SLOT_MS);
 try{
  const q=await env.MARKET_DB.prepare(
   "SELECT slot,collected_at_ms,status,ready_count FROM crypto_snapshots "+
   "WHERE slot >= ?1 ORDER BY slot DESC LIMIT 96").bind(startSlot).all();
  const rows=q.results||[];
  if(!rows.length)return {status:"NO_PERSISTED_RUNS",storage:"D1",
   period:"last_24h",checked_at_utc:iso(now),
   note:"No rows in last 24 hours. Check Cloudflare Cron Invocations."};
  const slots=new Map(rows.map(r=>[Number(r.slot),r]));
  const first=Math.min(...slots.keys()),last=Math.max(...slots.keys());
  // Count slots through the latest due Cron, not just through the latest stored row.
  // Do not penalize the current slot until the 7-minute grace period has elapsed.
  const expectedEnd=Math.max(last,latestDueSlot),missingBetween=[],missingAfter=[];
  for(let slot=first;slot<=expectedEnd;slot++){
   if(slots.has(slot))continue;
   (slot>last?missingAfter:missingBetween).push(iso(slot*D1_SLOT_MS));
  }
  const ready=rows.filter(r=>r.status==="READY"&&Number(r.ready_count)===6).length;
  const incomplete=rows.length-ready;
  const latest=slots.get(last),ageMinutes=Math.round(
   (now-Number(latest.collected_at_ms))/60000);
  const expected=expectedEnd-first+1;
  const missingTotal=missingBetween.length+missingAfter.length;
  return {
   status:incomplete>0||missingTotal>0?"ISSUES_DETECTED":
    rows.length<4?"INSUFFICIENT_OBSERVATIONS":"NO_ISSUES_IN_OBSERVED_INTERVAL",
   storage:"D1",period:"rolling_24h",
   checked_at_utc:iso(now),first_observed_utc:iso(first*D1_SLOT_MS),
   last_observed_utc:iso(Number(latest.collected_at_ms)),
   latest_age_minutes:ageMinutes,cron_schedule:"every 15 minutes UTC",
   cron_grace_minutes:7,
   expected_slots_since_first_observation:expected,
   recorded_slots:rows.length,ready_slots:ready,incomplete_slots:incomplete,
   missing_slots_between_first_and_last:missingBetween.length,
   overdue_slots_after_last_record:missingAfter.length,
   missing_slots_since_first_observation:missingTotal,
   first_missing_slot_utc:[...missingBetween,...missingAfter].slice(0,10),
   ready_percent_among_recorded:Math.round(10000*ready/rows.length)/100,
   ready_percent_among_expected:Math.round(10000*ready/expected)/100,
   disclaimer:"Counts start with the earliest stored row in the rolling 24h window; they cannot prove uptime before recording began. The 7-minute delay avoids flagging a recently scheduled run prematurely. No derivatives coverage yet."
  };
 }catch(e){return {status:"D1_QUERY_FAILED",storage:"D1",
  error:String(e?.message||e).slice(0,220)};}
}


// Phase 3 exploratory futures probe. No persistence, no trade alerts, no auth.
async function gateFuturesArray(path,params){
 const url=new URL("https://api.gateio.ws/api/v4"+path);
 for(const [k,v] of Object.entries(params))url.searchParams.set(k,String(v));
 const res=await fetch(url.toString(),{
  headers:{accept:"application/json"},signal:AbortSignal.timeout(8500)
 });
 if(!res.ok)throw Error("HTTP_"+res.status);
 const data=await res.json();
 if(!Array.isArray(data))throw Error("NON_ARRAY_FUTURES_RESPONSE");
 return data;
}
async function gateDerivativesCoin(coin,atMs){
 const contract=coin+"_USDT",nowSeconds=Math.floor(atMs/1000);
 const requests=[
  gateFuturesArray("/futures/usdt/contract_stats",{contract,interval:"5m",limit:3}),
  gateFuturesArray("/futures/usdt/funding_rate",{contract,limit:2}),
  gateFuturesArray("/futures/usdt/liq_orders",{contract,from:nowSeconds-1800,to:nowSeconds,limit:100})
 ];
 const settled=await Promise.allSettled(requests);
 const out={contract,venue:"Gate Global USDT Perpetual",
  market:"FUTURES",oi:{state:"UNKNOWN"},funding:{state:"UNKNOWN"},
  liq_orders:{state:"UNKNOWN"},errors:[]};
 if(settled[0].status==="fulfilled"){
  const items=settled[0].value.filter(r=>Number.isFinite(Number(r?.time))&&
   Number.isFinite(Number(r?.open_interest))&&Number(r.open_interest)>=0).sort((a,b)=>Number(b.time)-Number(a.time));
  const rec=items[0],ts=Number(rec?.time)*1000;
  if(rec&&ts<=atMs+60000&&atMs-ts<=30*60000){
   out.oi={state:"VALID_GATED_STATS",sample_time_utc:iso(ts),
    age_minutes:Math.round((atMs-ts)/60000),
    open_interest_contracts:Number(rec.open_interest),
    open_interest_usd:Number.isFinite(Number(rec.open_interest_usd))?
     Number(rec.open_interest_usd):null,
    aggregated_long_liq_usd:Number.isFinite(Number(rec.long_liq_usd_new??rec.long_liq_usd))?
     Number(rec.long_liq_usd_new??rec.long_liq_usd):null,
    aggregated_short_liq_usd:Number.isFinite(Number(rec.short_liq_usd_new??rec.short_liq_usd))?
     Number(rec.short_liq_usd_new??rec.short_liq_usd):null,
    note:"Exchange contract_stats aggregates; interval and coverage need further validation"};
  }else out.oi={state:"NO_FRESH_OI_SAMPLE",rows_returned:settled[0].value.length};
 }else{
  out.oi={state:"REQUEST_FAILED",error:String(settled[0].reason).slice(0,130)};
  out.errors.push("oi");
 }
 if(settled[1].status==="fulfilled"){
  const items=settled[1].value.filter(r=>Number.isFinite(Number(r?.t))&&
    Number.isFinite(Number(r?.r))).sort((a,b)=>Number(b.t)-Number(a.t));
  if(items.length){
   const newest=items[0];out.funding={state:"HISTORY_AVAILABLE",
    latest_settlement_time_utc:iso(Number(newest.t)*1000),
    rate:Number(newest.r),records_returned:items.length,
    note:"Historical settlement rate, NOT current forecast"};
  }else out.funding={state:"NO_VALID_HISTORY",rows_returned:settled[1].value.length};
 }else{
  out.funding={state:"REQUEST_FAILED",error:String(settled[1].reason).slice(0,130)};
  out.errors.push("funding");
 }
 if(settled[2].status==="fulfilled"){
  const arr=settled[2].value;
  const filtered=arr.filter(r=>r?.contract===contract&&Number.isFinite(Number(r.time))&&
   Number(r.time)>=nowSeconds-1800&&Number(r.time)<=nowSeconds+60);
  const times=filtered.map(r=>Number(r.time));
  out.liq_orders={state:arr.length>=100?"PAGINATION_REQUIRED":
     filtered.length?"EVENTS_REPORTED":"ZERO_REPORTED_BY_GATE_NOT_MARKET_WIDE",
   query_window_seconds:1800,raw_count:arr.length,valid_count:filtered.length,
   earliest_reported_utc:times.length?iso(Math.min(...times)*1000):null,
   latest_reported_utc:times.length?iso(Math.max(...times)*1000):null,
   note:"Public exchange liquidation orders may be incomplete. Zero reported is not proof of no liquidations."};
 }else{
  out.liq_orders={state:"REQUEST_FAILED",error:String(settled[2].reason).slice(0,130)};
  out.errors.push("liquidations");
 }
 return out;
}
async function gateDerivativeProbe(){
 const at=Date.now();
 const results=await Promise.allSettled(COINS.map(c=>gateDerivativesCoin(c,at)));
 const assets=Object.fromEntries(COINS.map((coin,i)=>[coin,results[i].status==="fulfilled"?
  results[i].value:{contract:coin+"_USDT",oi:{state:"UNKNOWN"},
  funding:{state:"UNKNOWN"},liq_orders:{state:"UNKNOWN"},
  errors:[String(results[i].reason).slice(0,180)]}]));
 const coverage=Object.values(assets);
 return {phase:"PUBLIC_DERIVATIVES_READ_ONLY_PROBE",
  generated_at_utc:iso(at),venue:"Gate Global USDT perpetual",
  oi_available:coverage.filter(x=>x.oi?.state==="VALID_GATED_STATS").length,
  funding_available:coverage.filter(x=>x.funding?.state==="HISTORY_AVAILABLE").length,
  liquidation_requests_responded:coverage.filter(x=>!["UNKNOWN","REQUEST_FAILED"].includes(x.liq_orders?.state)).length,
  total_coins:6,
  production_ready:false,
  note:"One-time API reachability and field validation only; independent freshness audits, pagination, persistent event storage, cross-venue corroboration and continuous monitoring are still required.",
  assets};
}

export default {
 async fetch(request,env){
  const url=new URL(request.url);
  if(request.method!=="GET")return respond({error:"METHOD_NOT_ALLOWED"},405);
  if(url.pathname==="/health")return respond({service:"crypto-market-data",version:"0.4.1-phase3a",
   worker_running:true,data_verified:false,persistence_enabled:Boolean(env?.MARKET_DB),at_utc:iso(Date.now())});
  if(url.pathname==="/gate-trades"){
   try{return respond(await gateTradeFreshness());}
   catch(e){return respond({qualification:"INCOMPLETE",error:String(e)},503);}
  }
  if(url.pathname==="/gate-snapshot"){
   try{return respond(await gateSnapshot());}
   catch(e){return respond({dataset_status:"NOT_PRODUCTION_READY",error:String(e)},503);}
  }
  if(url.pathname==="/sources"){
   try{return respond(await sourceDiagnostics());}
   catch(e){return respond({error:String(e)},503);}
  }
  if(url.pathname==="/derivatives-probe"){
   try{return respond(await gateDerivativeProbe());}
   catch(e){return respond({phase:"PUBLIC_DERIVATIVES_READ_ONLY_PROBE",error:String(e)},503);}
  }
  if(url.pathname==="/derivatives-audit"){
   const report=await derivativesAudit(env);
   return respond(report,["D1_QUERY_FAILED","STORAGE_NOT_CONFIGURED"].includes(report.status)?503:200);
  }
  if(url.pathname==="/derivatives-latest"){
   const report=await derivativesLatest(env);
   return respond(report,["D1_QUERY_FAILED","STORAGE_NOT_CONFIGURED"].includes(report.status)?503:200);
  }
  if(url.pathname==="/audit"){
   const report=await gateStorageAudit(env);
   return respond(report,report.status==="D1_QUERY_FAILED"||report.status==="STORAGE_NOT_CONFIGURED"?503:200);
  }
  if(url.pathname==="/latest-assets"){
   const result=await gateLatestSpotAssets(env);
   return respond(result,["D1_QUERY_FAILED","STORAGE_NOT_CONFIGURED"].includes(result.status)?503:200);
  }
  if(url.pathname==="/latest"){
   const data=await gateLastSaved(env);
   return respond(data,data.status==="FRESH"?200:503);
  }
  if(url.pathname==="/snapshot"){
   try{const data=await gateValidatedSnapshot();return respond(data,data.dataset_status==="READY"?200:503);}
   catch(e){return respond({dataset_status:"INCOMPLETE",error:String(e)},503);}
  }
  if(url.pathname==="/")return respond({service:"crypto-market-data",endpoints:["/health","/snapshot","/latest","/latest-assets","/audit","/derivatives-probe","/derivatives-latest","/derivatives-audit","/sources","/gate-snapshot","/gate-trades"],
   phase:"3A: independent spot and derivatives D1 collectors; read-only historical metrics"});
  return respond({error:"NOT_FOUND"},404);
 },
 async scheduled(controller,env){
  // Both collectors run independently; a failure in one cannot skip the other.
  const [spot,derivatives]=await Promise.allSettled([
   (async()=>{
    const snapshot=await gateValidatedSnapshot();
    const saved=await saveGateSnapshot(env,snapshot,"cron");
    console.log(JSON.stringify({event:"gate-spot-collector",
     scheduled_at_utc:iso(controller.scheduledTime),status:snapshot.dataset_status,
     ready:snapshot.ready_symbols,persistence:saved}));
    if(snapshot.dataset_status!=="READY")
     throw Error("GATE_DATA_INCOMPLETE_"+snapshot.ready_symbols+"_OF_6");
    if(!saved.persisted)throw Error("GATE_SPOT_NOT_PERSISTED");
    return {status:"READY",saved};
   })(),
   collectAndSaveDerivatives(env,controller.scheduledTime)
  ]);
  if(derivatives.status==="fulfilled"){
   const summary=derivatives.value;
   console.log(JSON.stringify({event:"gate-derivatives-collector",
    scheduled_at_utc:iso(controller.scheduledTime),...summary}));
   if(summary.status==="PARTIAL")console.warn("GATE_DERIVATIVES_PARTIAL");
  }else{
   console.error("GATE_DERIVATIVES_FAILURE",String(derivatives.reason));
  }
  if(spot.status==="rejected")throw spot.reason;
  if(derivatives.status==="rejected")throw derivatives.reason;
  if(derivatives.value.errors?.length)
   throw Error("GATE_DERIVATIVES_STORAGE_PARTIAL");
 }
};
