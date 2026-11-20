// Phase 3A: Gate-only, public, read-only derivatives collector.
// This module NEVER places orders or turns descriptive indicators into buy/sell signals.
const COINS = ["BTC","ETH","SOL","LINK","PENDLE","ONDO"];
const FIVE_MIN = 300000;
const SLOT_MS = 900000;
const DAY_MS = 86400000;
const RETAIN_MS = 30 * DAY_MS;
const LIQ_LIMIT = 100;
const LIQ_CALL_BUDGET = 4;
const COIN_EVENT_WRITE_CAP = 80;
const iso = value => new Date(value).toISOString();
const validNum = value => value !== null && value !== undefined && value !== "" &&
  Number.isFinite(Number(value)) ? Number(value) : null;
const stateError = e => String(e && e.message || e).slice(0,140);

async function gateArray(path, params) {
  const url = new URL("https://api.gateio.ws/api/v4" + path);
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key,String(value));
  const response = await fetch(url.toString(),{
    headers:{Accept:"application/json"},signal:AbortSignal.timeout(8000)
  });
  if (!response.ok) throw Error("GATE_HTTP_" + response.status);
  const data = await response.json();
  if (!Array.isArray(data)) throw Error("GATE_NON_ARRAY_RESPONSE");
  return data;
}

function parseStats(coin, rows, at) {
  const valid = [];
  const seen = new Set();
  for (const row of rows) {
    const stamp = validNum(row && row.time);
    const oi = validNum(row && row.open_interest);
    const usd = validNum(row && row.open_interest_usd);
    if (stamp === null || oi === null || usd === null || oi < 0 || usd < 0) continue;
    const ms = stamp * 1000;
    // Only closed 5m records; exclude partial and implausibly old/future samples.
    if (ms > at - FIVE_MIN || ms < at - 2 * 60 * 60 * 1000 || seen.has(ms)) continue;
    seen.add(ms);
    const longLiq = validNum(row.long_liq_usd_new ?? row.long_liq_usd);
    const shortLiq = validNum(row.short_liq_usd_new ?? row.short_liq_usd);
    valid.push({coin,sample_ms:ms,oi_contracts:oi,oi_usd:usd,
      long_liq_usd:longLiq !== null && longLiq >= 0 ? longLiq : null,
      short_liq_usd:shortLiq !== null && shortLiq >= 0 ? shortLiq : null});
  }
  valid.sort((a,b)=>a.sample_ms-b.sample_ms);
  const latest=valid[valid.length-1];
  return {state:latest && at-latest.sample_ms <= 20*60000 ? "FRESH" : "NO_FRESH_SAMPLE",
    records:valid,latest_at:latest ? iso(latest.sample_ms) : null};
}

function parseFunding(coin,rows,at) {
  const list = [], seen=new Set();
  for(const row of rows) {
    const stamp=validNum(row && row.t),rate=validNum(row && row.r);
    if(stamp === null || rate === null || Math.abs(rate)>1)continue;
    const ms=stamp*1000;
    if(ms>at+60000 || ms<at-30*DAY_MS || seen.has(ms))continue;
    seen.add(ms);list.push({coin,settlement_ms:ms,rate});
  }
  list.sort((a,b)=>a.settlement_ms-b.settlement_ms);
  const latest=list[list.length-1];
  return {state:latest && at-latest.settlement_ms<=24*60*60000 ?
    "HISTORY_AVAILABLE":"HISTORY_MISSING_OR_STALE",records:list,
    latest_at:latest?iso(latest.settlement_ms):null};
}

// Gate's public liq_orders endpoint has a 3600-second range ceiling but NO
// documented offset/cursor pagination. On a full page we split time windows;
// if even split windows remain capped, mark partial and do not assert completeness.
async function getLiquidations(coin,at) {
  const contract=coin+"_USDT";
  const from=Math.floor(at/1000)-1800,to=Math.floor(at/1000);
  const events=new Map();
  let requests=0,truncated=false,invalid_rows=0;
  async function query(a,b) {
    if(requests>=LIQ_CALL_BUDGET) {truncated=true;return;}
    requests++;
    const items=await gateArray("/futures/usdt/liq_orders",
      {contract,from:a,to:b,limit:LIQ_LIMIT});
    if(items.length>=LIQ_LIMIT) {
      if(b<=a || requests>=LIQ_CALL_BUDGET){truncated=true;return;}
      const mid=Math.floor((a+b)/2);
      await query(a,mid);
      await query(mid+1,b);
      return;
    }
    for(const row of items) {
      const t=validNum(row && row.time);
      if(row?.contract!==contract || t===null || t<a || t>b){invalid_rows++;continue;}
      // No public event ID. This deterministic fingerprint may merge distinct
      // but byte-for-byte-identical orders: event counts are lower bounds.
      const fields=[coin,t,String(row.size??""),String(row.order_size??""),
        String(row.order_price??""),String(row.fill_price??"")];
      const key=JSON.stringify(fields);
      events.set(key,{event_key:key,coin,event_ms:t*1000,
        position_size:fields[2],order_size:fields[3],
        order_price:fields[4],fill_price:fields[5]});
    }
  }
  try {
    await query(from,to);
    const records=[...events.values()];
    const capped=records.length>COIN_EVENT_WRITE_CAP;
    return {state:truncated || capped || invalid_rows>0 ? "INCOMPLETE" :
      records.length ? "EVENTS_REPORTED":"ZERO_REPORTED_BY_GATE",
      records: capped ? records.slice(0,COIN_EVENT_WRITE_CAP):records,
      reported_unique:records.length,requests,invalid_rows,
      truncated:truncated||capped||invalid_rows>0,window_seconds:1800};
  } catch(e) {
    return {state:"REQUEST_FAILED",records:[],reported_unique:0,
      requests,truncated:true,error:stateError(e),window_seconds:1800};
  }
}

async function collectCoin(coin,at) {
  const contract=coin+"_USDT";
  const [statsRes,fundingRes,liqRes] = await Promise.allSettled([
    gateArray("/futures/usdt/contract_stats",{contract,interval:"5m",limit:24}),
    gateArray("/futures/usdt/funding_rate",{contract,limit:4}),
    getLiquidations(coin,at)
  ]);
  const stats=statsRes.status==="fulfilled" ?
    parseStats(coin,statsRes.value,at):
    {state:"REQUEST_FAILED",records:[],error:stateError(statsRes.reason)};
  const funding=fundingRes.status==="fulfilled" ?
    parseFunding(coin,fundingRes.value,at):
    {state:"REQUEST_FAILED",records:[],error:stateError(fundingRes.reason)};
  const liq=liqRes.status==="fulfilled"?liqRes.value:
    {state:"REQUEST_FAILED",records:[],truncated:true,error:stateError(liqRes.reason)};
  return {coin,stats,funding,liq,quality:stats.state==="FRESH" &&
    funding.state==="HISTORY_AVAILABLE" &&
    ["EVENTS_REPORTED","ZERO_REPORTED_BY_GATE"].includes(liq.state) ?
    "DATA_COLLECTED":"INCOMPLETE"};
}

const SCHEMA=[
  "CREATE TABLE IF NOT EXISTS derivative_slots (slot INTEGER NOT NULL, coin TEXT NOT NULL, collected_at_ms INTEGER NOT NULL, quality TEXT NOT NULL, oi_state TEXT NOT NULL, funding_state TEXT NOT NULL, liq_state TEXT NOT NULL, oi_records INTEGER NOT NULL, liq_records INTEGER NOT NULL, errors TEXT NOT NULL, PRIMARY KEY(slot,coin))",
  "CREATE TABLE IF NOT EXISTS derivative_stats (coin TEXT NOT NULL, sample_ms INTEGER NOT NULL, oi_contracts REAL NOT NULL, oi_usd REAL NOT NULL, long_liq_usd REAL, short_liq_usd REAL, PRIMARY KEY(coin,sample_ms))",
  "CREATE TABLE IF NOT EXISTS derivative_funding (coin TEXT NOT NULL, settlement_ms INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY(coin,settlement_ms))",
  "CREATE TABLE IF NOT EXISTS derivative_liq_events (event_key TEXT PRIMARY KEY, coin TEXT NOT NULL, event_ms INTEGER NOT NULL, position_size TEXT, order_size TEXT, order_price TEXT, fill_price TEXT, observed_ms INTEGER NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_derivative_liq_time ON derivative_liq_events(coin,event_ms)"
];
async function ensureTables(db) {
  await db.batch(SCHEMA.map(sql=>db.prepare(sql)));
}

async function saveCoin(db,entry,at,slot) {
  const statements=[];
  for(const r of entry.stats.records) {
    statements.push(db.prepare("INSERT INTO derivative_stats (coin,sample_ms,oi_contracts,oi_usd,long_liq_usd,short_liq_usd) VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(coin,sample_ms) DO UPDATE SET oi_contracts=excluded.oi_contracts,oi_usd=excluded.oi_usd,long_liq_usd=excluded.long_liq_usd,short_liq_usd=excluded.short_liq_usd")
      .bind(r.coin,r.sample_ms,r.oi_contracts,r.oi_usd,r.long_liq_usd,r.short_liq_usd));
  }
  for(const r of entry.funding.records) {
    statements.push(db.prepare("INSERT OR IGNORE INTO derivative_funding (coin,settlement_ms,rate) VALUES (?1,?2,?3)")
      .bind(r.coin,r.settlement_ms,r.rate));
  }
  for(const r of entry.liq.records) {
    statements.push(db.prepare("INSERT OR IGNORE INTO derivative_liq_events (event_key,coin,event_ms,position_size,order_size,order_price,fill_price,observed_ms) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")
      .bind(r.event_key,r.coin,r.event_ms,r.position_size,r.order_size,
        r.order_price,r.fill_price,at));
  }
  const errors=[entry.stats.error,entry.funding.error,entry.liq.error].filter(Boolean);
  statements.push(db.prepare("INSERT INTO derivative_slots (slot,coin,collected_at_ms,quality,oi_state,funding_state,liq_state,oi_records,liq_records,errors) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10) ON CONFLICT(slot,coin) DO UPDATE SET collected_at_ms=excluded.collected_at_ms,quality=excluded.quality,oi_state=excluded.oi_state,funding_state=excluded.funding_state,liq_state=excluded.liq_state,oi_records=excluded.oi_records,liq_records=excluded.liq_records,errors=excluded.errors WHERE excluded.quality='DATA_COLLECTED' AND derivative_slots.quality!='DATA_COLLECTED'")
    .bind(slot,entry.coin,at,entry.quality,entry.stats.state,
      entry.funding.state,entry.liq.state,entry.stats.records.length,
      entry.liq.reported_unique,errors.join(";")));
  // One atomic D1 batch per coin: slot is recorded only if its rows commit.
  await db.batch(statements);
}

export async function collectAndSaveDerivatives(env,at=Date.now()) {
  if(!env?.MARKET_DB) return {phase:"3A",status:"STORAGE_NOT_CONFIGURED",saved:0};
  const db=env.MARKET_DB,slot=Math.floor(at/SLOT_MS);
  const settled=await Promise.allSettled(COINS.map(coin=>collectCoin(coin,at)));
  await ensureTables(db);
  const outcomes=[],errors=[];
  for(let i=0;i<COINS.length;i++) {
    const entry=settled[i].status==="fulfilled" ? settled[i].value:
      {coin:COINS[i],stats:{state:"REQUEST_FAILED",records:[],error:stateError(settled[i].reason)},
        funding:{state:"REQUEST_FAILED",records:[]},
        liq:{state:"REQUEST_FAILED",records:[],reported_unique:0},quality:"INCOMPLETE"};
    try {
      await saveCoin(db,entry,at,slot);
      outcomes.push({coin:entry.coin,quality:entry.quality,oi:entry.stats.state,
        funding:entry.funding.state,liquidations:entry.liq.state,
        oi_rows:entry.stats.records.length,liquidation_events:entry.liq.reported_unique});
    } catch(e) {
      errors.push({coin:entry.coin,error:stateError(e)});
    }
  }
  if(slot%96===0) {
    try {
      const cutoff=at-RETAIN_MS;
      await db.batch([
        db.prepare("DELETE FROM derivative_slots WHERE slot < ?1").bind(Math.floor(cutoff/SLOT_MS)),
        db.prepare("DELETE FROM derivative_stats WHERE sample_ms < ?1").bind(cutoff),
        db.prepare("DELETE FROM derivative_funding WHERE settlement_ms < ?1").bind(cutoff),
        db.prepare("DELETE FROM derivative_liq_events WHERE event_ms < ?1").bind(cutoff)
      ]);
    } catch(e) {errors.push({coin:"RETENTION",error:stateError(e)});}
  }
  return {phase:"3A",status:!errors.length&&outcomes.length===6 &&
    outcomes.every(x=>x.quality==="DATA_COLLECTED") ? "ALL_COLLECTED":"PARTIAL",
    collected_at_utc:iso(at),slot,saved:outcomes.length,outcomes,errors,
    note:"Gate single-venue public observations; never market-wide liquidation totals or trading signals"};
}

function metricForHorizon(rows,horizon) {
  if(rows.length<2)return {state:"INSUFFICIENT_HISTORY"};
  const last=rows[rows.length-1],target=last.sample_ms-horizon;
  let baseline=null,delta=Infinity;
  for(const r of rows) {
    const d=Math.abs(r.sample_ms-target);
    if(d<delta){baseline=r;delta=d;}
  }
  if(!baseline || delta>7.5*60000 || baseline.oi_usd<=0)
    return {state:"INSUFFICIENT_HISTORY"};
  const window=rows.filter(r=>r.sample_ms>=baseline.sample_ms&&r.sample_ms<=last.sample_ms);
  let gap=0;
  for(let i=1;i<window.length;i++)gap=Math.max(gap,window[i].sample_ms-window[i-1].sample_ms);
  const expected=Math.floor((last.sample_ms-baseline.sample_ms)/FIVE_MIN)+1;
  if(window.length<Math.ceil(expected*.8)||gap>2*FIVE_MIN)
    return {state:"INCOMPLETE_HISTORY",observed:window.length,expected};
  return {state:"VALID",percent:Math.round(10000*(last.oi_usd/baseline.oi_usd-1))/100,
    from_utc:iso(baseline.sample_ms),to_utc:iso(last.sample_ms)};
}
function liquidationTrend(rows) {
  if(rows.length<12)return {state:"INSUFFICIENT_HISTORY"};
  const last=rows[rows.length-1].sample_ms;
  const recent=rows.filter(r=>r.sample_ms>last-30*60000);
  const prior=rows.filter(r=>r.sample_ms>last-60*60000&&r.sample_ms<=last-30*60000);
  if(recent.length<5||prior.length<5 ||
    [...recent,...prior].some(r=>r.long_liq_usd===null||r.short_liq_usd===null))
    return {state:"INCOMPLETE_HISTORY"};
  const sum=x=>x.reduce((a,r)=>a+r.long_liq_usd+r.short_liq_usd,0);
  const a=sum(recent),b=sum(prior);
  return {state:"DESCRIPTIVE_ONLY",recent_30m_usd:Math.round(a),
    previous_30m_usd:Math.round(b),
    ratio_previous:b>0?Math.round(1000*a/b)/1000:null,
    note:"No liquidation-exhaustion signal; 5m exchange aggregates, not public order-event totals"};
}
export function calculateDerivativeMetrics(rows) {
  const records=rows.slice().sort((a,b)=>a.sample_ms-b.sample_ms);
  const latest=records[records.length-1];
  if(!latest)return {state:"NO_HISTORY"};
  return {state:"HISTORICAL_OBSERVATIONS_ONLY",latest_oi_usd:latest.oi_usd,
    latest_sample_utc:iso(latest.sample_ms),
    oi_change_1h:metricForHorizon(records,60*60000),
    oi_change_4h:metricForHorizon(records,4*60*60000),
    oi_change_24h:metricForHorizon(records,24*60*60000),
    liquidation_trend_30m:liquidationTrend(records)};
}

export async function derivativesLatest(env) {
  if(!env?.MARKET_DB)return {status:"STORAGE_NOT_CONFIGURED"};
  const at=Date.now();
  try{
    const db=env.MARKET_DB;
    const [statRows,rateRows]=await Promise.all([
      db.prepare("SELECT coin,sample_ms,oi_usd,long_liq_usd,short_liq_usd FROM derivative_stats WHERE sample_ms>=?1 ORDER BY sample_ms DESC LIMIT 2400").bind(at-26*60*60000).all(),
      db.prepare("SELECT coin,settlement_ms,rate FROM derivative_funding WHERE settlement_ms>=?1 ORDER BY settlement_ms DESC LIMIT 100").bind(at-30*DAY_MS).all()
    ]);
    const assets={};
    for(const coin of COINS) {
      const rows=(statRows.results||[]).filter(x=>x.coin===coin);
      const metrics=calculateDerivativeMetrics(rows);
      const funding=(rateRows.results||[]).find(r=>r.coin===coin);
      const age=metrics.latest_sample_utc ? (at-Date.parse(metrics.latest_sample_utc))/60000:null;
      assets[coin]={...metrics,fresh:age!==null&&age>=-1&&age<=20,
        sample_age_minutes:age===null?null:Math.round(age),
        funding:funding?{last_settlement_utc:iso(funding.settlement_ms),
          rate:funding.rate,historical_only:true}:null};
    }
    return {status:"READ_ONLY_HISTORICAL",checked_at_utc:iso(at),venue:"Gate Global USDT perpetual",
      production_ready:false,trade_signal:"NOT_EVALUATED",
      note:"Single venue; 24h metrics require 24h of continuous saved data",assets};
  }catch(e){return {status:String(e).includes("no such table")?"NO_PERSISTED_RUNS":"D1_QUERY_FAILED",error:stateError(e)};}
}

export async function derivativesAudit(env) {
  if(!env?.MARKET_DB)return {status:"STORAGE_NOT_CONFIGURED"};
  const at=Date.now(),dueSlot=Math.floor((at-7*60000)/SLOT_MS);
  try{
    const q=await env.MARKET_DB.prepare(
      "SELECT slot,coin,collected_at_ms,quality,oi_state,funding_state,liq_state,oi_records,liq_records,errors FROM derivative_slots WHERE slot>=?1 ORDER BY slot DESC LIMIT 600")
      .bind(Math.floor(at/SLOT_MS)-96).all();
    const rows=q.results||[];
    if(!rows.length)return {status:"NO_PERSISTED_RUNS",checked_at_utc:iso(at)};
    const first=Math.min(...rows.map(r=>r.slot));
    const expected=Math.max(1,dueSlot-first+1);
    const assets={};
    for(const coin of COINS) {
      const mine=rows.filter(r=>r.coin===coin);
      const seen=new Set(mine.map(r=>r.slot));
      const missed=[];
      for(let s=first;s<=dueSlot;s++)if(!seen.has(s))missed.push(iso(s*SLOT_MS));
      const good=mine.filter(r=>r.quality==="DATA_COLLECTED").length;
      assets[coin]={recorded_slots:mine.length,complete_slots:good,
        incomplete_slots:mine.length-good,missing_due_slots:missed.length,
        first_missing_slot_utc:missed.slice(0,3),
        latest:mine[0]?{collected_at_utc:iso(mine[0].collected_at_ms),
          quality:mine[0].quality,oi:mine[0].oi_state,
          funding:mine[0].funding_state,liquidations:mine[0].liq_state,
          event_count:mine[0].liq_records}:null};
    }
    const issue=Object.values(assets).some(x=>x.incomplete_slots>0||x.missing_due_slots>0);
    return {status:issue?"ISSUES_DETECTED":expected<4?
      "INSUFFICIENT_OBSERVATIONS":"NO_ISSUES_IN_OBSERVED_INTERVAL",
      checked_at_utc:iso(at),storage:"D1",expected_slots_since_first_record:expected,
      cron:"every 15m UTC; 7m grace",assets,
      limitations:"Cannot establish uptime before first saved row; Gate-only public liquidations may be incomplete; not a trading signal"};
  }catch(e){return {status:String(e).includes("no such table")?"NO_PERSISTED_RUNS":"D1_QUERY_FAILED",error:stateError(e)};}
}
