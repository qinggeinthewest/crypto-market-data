import test from "node:test";
import assert from "node:assert/strict";
import { calculateDerivativeMetrics, collectAndSaveDerivatives } from "../src/derivatives.js";

function buildRows(count, at, { gaps=[] }={}) {
  return Array.from({length:count},(_,i)=>({
    coin:"BTC", sample_ms:at-(count-1-i)*300000,
    oi_usd:1000+i*2, long_liq_usd:100, short_liq_usd:50
  })).filter((_,i)=>!gaps.includes(i));
}

test("empty series never produces a trading signal",()=>{
  assert.equal(calculateDerivativeMetrics([]).state,"NO_HISTORY");
});
test("1h and 4h OI need sufficient continuous historical observations",()=>{
  const at=Date.parse("2026-11-20T09:20:00Z");
  const small=calculateDerivativeMetrics(buildRows(10,at));
  assert.equal(small.oi_change_1h.state,"INSUFFICIENT_HISTORY");
  const full=calculateDerivativeMetrics(buildRows(290,at));
  assert.equal(full.oi_change_1h.state,"VALID");
  assert.equal(full.oi_change_4h.state,"VALID");
  assert.equal(full.oi_change_24h.state,"VALID");
  assert.equal(full.liquidation_trend_30m.state,"DESCRIPTIVE_ONLY");
  assert.ok(!JSON.stringify(full).includes("BUY"));
});
test("missing samples invalidate OI window instead of producing false confidence",()=>{
  const at=Date.parse("2026-11-20T09:20:00Z");
  const history=buildRows(30,at,{gaps:[20,21,22,23,24,25,26]});
  assert.equal(calculateDerivativeMetrics(history).oi_change_1h.state,"INCOMPLETE_HISTORY");
});

class FakeDB {
  constructor(){this.batches=[];}
  prepare(sql){
    return {sql,params:[],bind(...params){return {sql,params};}};
  }
  async batch(statements){
    this.batches.push(statements);
    return statements.map(()=>({success:true}));
  }
}

test("collector persists all six independently and reports public liquidation zeros honestly",async()=>{
  const originalFetch=globalThis.fetch;
  const at=Date.parse("2026-11-20T09:30:30Z");
  const calls=[];
  globalThis.fetch=async url=>{
    const u=new URL(url),coin=u.searchParams.get("contract")?.split("_")[0];
    calls.push(u.pathname);
    let rows=[];
    if(u.pathname.endsWith("/contract_stats")){
      rows=[1,2,3].map(n=>({time:Math.floor((at-n*300000)/1000),
        open_interest:"1000",open_interest_usd:100000,
        long_liq_usd_new:0,short_liq_usd_new:0}));
    }else if(u.pathname.endsWith("/funding_rate")){
      rows=[{t:Math.floor((at-3600000)/1000),r:0.00001}];
    }else if(u.pathname.endsWith("/liq_orders")){
      rows=coin==="BTC"?[{time:Math.floor(at/1000)-100,contract:"BTC_USDT",
        size:"5",order_size:"-5",order_price:"100",fill_price:"101"}]:[];
    }else throw new Error("Unexpected API");
    return {ok:true,json:async()=>rows};
  };
  try {
    const db=new FakeDB();
    const result=await collectAndSaveDerivatives({MARKET_DB:db},at);
    assert.equal(result.saved,6);
    assert.equal(result.status,"ALL_COLLECTED");
    assert.equal(result.outcomes.find(x=>x.coin==="BTC").liquidations,"EVENTS_REPORTED");
    assert.equal(result.outcomes.find(x=>x.coin==="ONDO").liquidations,"ZERO_REPORTED_BY_GATE");
    const sql=db.batches.flat().map(x=>x.sql);
    assert.equal(sql.filter(x=>x.startsWith("INSERT INTO derivative_slots")).length,6);
    assert.ok(sql.some(x=>x.includes("INSERT OR IGNORE INTO derivative_liq_events")));
    assert.equal(calls.length,18);
  }finally {globalThis.fetch=originalFetch;}
});
