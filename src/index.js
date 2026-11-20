// Phase 1: public-market-data diagnostics only. No secrets, orders, or stored state.
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

export default {
 async fetch(request){
  const url=new URL(request.url);
  if(request.method!=="GET")return respond({error:"METHOD_NOT_ALLOWED"},405);
  if(url.pathname==="/health")return respond({service:"crypto-market-data",version:"0.1.0",
   worker_running:true,data_verified:false,persistence_enabled:false,at_utc:iso(Date.now())});
  if(url.pathname==="/gate-snapshot"){
   try{return respond(await gateSnapshot());}
   catch(e){return respond({dataset_status:"NOT_PRODUCTION_READY",error:String(e)},503);}
  }
  if(url.pathname==="/sources"){
   try{return respond(await sourceDiagnostics());}
   catch(e){return respond({error:String(e)},503);}
  }
  if(url.pathname==="/snapshot"){
   try{const data=await collect();return respond(data,data.dataset_status==="READY"?200:503);}
   catch(e){return respond({dataset_status:"INCOMPLETE",error:String(e)},503);}
  }
  if(url.pathname==="/")return respond({service:"crypto-market-data",endpoints:["/health","/snapshot","/sources","/gate-snapshot"],
   phase:"1: read-only probes"});
  return respond({error:"NOT_FOUND"},404);
 },
 async scheduled(controller){
  const data=await collect();
  console.log(JSON.stringify({event:"crypto-market-data-check",scheduled_at_utc:iso(controller.scheduledTime),
   status:data.dataset_status,ready:data.ready_symbols,
   failures:Object.fromEntries(Object.entries(data.assets).filter(([,x])=>x.status!=="READY").map(([c,x])=>[c,x.errors]))}));
  if(data.dataset_status!=="READY")throw Error("DATA_INCOMPLETE_"+data.ready_symbols+"_OF_6");
 }
};