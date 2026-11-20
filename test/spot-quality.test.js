import test from "node:test";
import assert from "node:assert/strict";
import {mergeSpotRows} from "../src/spot-quality.js";
const COINS=["BTC","ETH","SOL","LINK","PENDLE","ONDO"];
const at=Date.parse("2026-11-20T10:02:00Z");

function asset(coin,tradeAgo=1){
 return {status:"READY",errors:[],quote:{price_usdt:coin==="PENDLE"?1.35:100},
  latest_trade:{exchange_time_utc:new Date(at-tradeAgo*60000).toISOString(),price_usdt:100},
  kline_4h:{recent_completed:[{open_ms:1}]},
  kline_1d:{recent_completed:[{open_ms:1}]}};
}
const row=(minutesAgo,assets)=>({
 collected_at_ms:at-minutesAgo*60000,
 payload:JSON.stringify({assets,generated_at_utc:new Date(at-minutesAgo*60000).toISOString()})
});
test("five fresh coins remain independently available when PENDLE last trade is stale",()=>{
 const assets=Object.fromEntries(COINS.map(c=>[c,asset(c)]));
 assets.PENDLE={status:"UNKNOWN",errors:["trades:LATEST_TRADE_STALE_OVER_5_MIN"],
  quote:{price_usdt:1.35},kline_4h:{},kline_1d:{}};
 const out=mergeSpotRows([row(2,assets)],at);
 assert.equal(out.status,"RECENT_PARTIAL");
 assert.equal(out.verified_coins,5);
 assert.deepEqual(out.missing_or_unverified_symbols,["PENDLE"]);
 assert.equal(out.assets.BTC.status,"RECENT_VERIFIED");
 assert.equal(out.assets.PENDLE.status,"NO_RECENT_VERIFIED_SPOT");
 assert.equal(out.assets.PENDLE.last_attempt.original_status,"UNKNOWN");
});
test("older per-coin verified row can fill recent gap but not stale data",()=>{
 const first=Object.fromEntries(COINS.map(c=>[c,asset(c)]));
 first.PENDLE={status:"UNKNOWN",errors:["STALE_TRADE"]};
 const second=Object.fromEntries(COINS.map(c=>[c,asset(c)]));
 second.BTC={status:"UNKNOWN",errors:["TEMP_FAIL"]};
 const out=mergeSpotRows([row(2,first),row(8,second)],at);
 assert.equal(out.status,"RECENT_ALL_SIX");
 assert.equal(out.assets.PENDLE.snapshot_age_minutes,8);
 assert.equal(out.assets.BTC.snapshot_age_minutes,2);
});
test("strict trade age and snapshot age must both pass",()=>{
 const snapshot=Object.fromEntries(COINS.map(c=>[c,asset(c,16)]));
 const expired=mergeSpotRows([row(1,snapshot)],at);
 assert.equal(expired.verified_coins,0);
 const fresh=Object.fromEntries(COINS.map(c=>[c,asset(c,1)]));
 assert.equal(mergeSpotRows([row(25,fresh)],at).verified_coins,0);
});
test("damaged stored rows do not fabricate fresh prices",()=>{
 const bad=[{collected_at_ms:at-1000,payload:"not-json"}];
 const out=mergeSpotRows(bad,at);
 assert.equal(out.status,"NO_RECENT_VERIFIED_ASSETS");
 assert.ok(out.issues.includes("MALFORMED_STORED_SNAPSHOT"));
});
