// Phase 3A.1: per-coin saved spot state. Pure reducer: no network, no orders.
const COINS=["BTC","ETH","SOL","LINK","PENDLE","ONDO"];
const MAX_SNAPSHOT_AGE_MS=20*60*1000;
const MAX_EXCHANGE_TRADE_AGE_MS=15*60*1000;
export function mergeSpotRows(rows,at=Date.now()) {
  const ordered=rows.slice().sort((a,b)=>Number(b.collected_at_ms)-Number(a.collected_at_ms));
  const verified={},latestAttempt={},issues=[];
  for(const row of ordered) {
    const ms=Number(row.collected_at_ms);
    if(!Number.isFinite(ms)||ms>at+60000)continue;
    let payload;
    try {payload=JSON.parse(row.payload);}
    catch(e){issues.push("MALFORMED_STORED_SNAPSHOT");continue;}
    const assets=payload?.assets||{};
    for(const coin of COINS) {
      const a=assets[coin];if(!a)continue;
      if(!latestAttempt[coin]) {
        latestAttempt[coin]={collected_at_utc:new Date(ms).toISOString(),
          original_status:a.status||"UNKNOWN",errors:a.errors||[],
          quote:a.quote||null};
      }
      if(verified[coin] || at-ms>MAX_SNAPSHOT_AGE_MS || a.status!=="READY")continue;
      const tradeTime=Date.parse(a.latest_trade?.exchange_time_utc);
      const tradeAge=at-tradeTime;
      const snapshotAge=at-ms;
      if(!Number.isFinite(tradeTime)||tradeAge < -60000 ||
        tradeAge > MAX_EXCHANGE_TRADE_AGE_MS || tradeTime>ms+60000)continue;
      if(!a.quote || !Number.isFinite(Number(a.quote.price_usdt)) ||
        Number(a.quote.price_usdt)<=0 || !a.kline_4h || !a.kline_1d)continue;
      verified[coin]={status:"RECENT_VERIFIED",source:"Gate Global SPOT",
        collected_at_utc:new Date(ms).toISOString(),
        exchange_trade_at_utc:a.latest_trade.exchange_time_utc,
        snapshot_age_minutes:Math.round(snapshotAge/60000),
        trade_age_minutes:Math.round(tradeAge/60000),
        data:a};
    }
  }
  const assets={};
  for(const coin of COINS) {
    assets[coin]=verified[coin] ||
      {status:"NO_RECENT_VERIFIED_SPOT",last_attempt:latestAttempt[coin]||null,
       note:"No spot quote is marked verified without fresh exchange trade evidence"};
  }
  const count=Object.keys(verified).length;
  return {status:count===6?"RECENT_ALL_SIX":count?"RECENT_PARTIAL":"NO_RECENT_VERIFIED_ASSETS",
    checked_at_utc:new Date(at).toISOString(),storage:"D1",verified_coins:count,
    total_coins:6,verified_symbols:Object.keys(verified),
    missing_or_unverified_symbols:COINS.filter(c=>!verified[c]),
    freshness_rules:{max_saved_snapshot_age_minutes:20,max_exchange_trade_age_minutes:15},
    record_count:ordered.length,issues,
    note:"Per-coin historical observations, not live quotes, all-six completeness, or trading signals",
    assets};
}
