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
export default {
 async fetch(request){
  const url=new URL(request.url);
  if(request.method!=="GET")return respond({error:"METHOD_NOT_ALLOWED"},405);
  if(url.pathname==="/health")return respond({service:"crypto-market-data",version:"0.1.0",
   worker_running:true,data_verified:false,persistence_enabled:false,at_utc:iso(Date.now())});
  if(url.pathname==="/snapshot"){
   try{const data=await collect();return respond(data,data.dataset_status==="READY"?200:503);}
   catch(e){return respond({dataset_status:"INCOMPLETE",error:String(e)},503);}
  }
  if(url.pathname==="/")return respond({service:"crypto-market-data",endpoints:["/health","/snapshot"],
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