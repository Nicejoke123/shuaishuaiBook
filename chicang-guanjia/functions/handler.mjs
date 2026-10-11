// Business API for the finance advisor site. All browser calls are same-origin
// /functions/v1/app?action=... . Reads are GET; every mutation is POST with
// server-side validation. Numbers are stored as validated numeric strings.
import {
  fetchRealtimeByCodes, fetchKlineHistory, fetchFundNavHistory, fetchFundName,
  fetchFundIndexBinding, fetchFundTopHoldings,
  lookupSymbol, isExchangeCode, isFundCode, GOLD_CODE,
} from "./quotes.mjs";
import { evaluatePosition, evaluateAllocation, feeConfig, buildBuyLots, sellFeeEstimate } from "./rules.mjs";

const json = (body, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_TYPES = new Set(["stock", "etf", "fund", "gold"]);
const MAX_BODY = 20000;

// ---------- China-time helpers ----------
function cnParts(now = new Date()) {
  const cn = new Date(now.getTime() + 8 * 3600 * 1000);
  const y = cn.getUTCFullYear();
  const m = String(cn.getUTCMonth() + 1).padStart(2, "0");
  const d = String(cn.getUTCDate()).padStart(2, "0");
  const minutes = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return { today: `${y}-${m}-${d}`, minutes, weekday: cn.getUTCDay() };
}
const isTradingDay = ({ weekday }) => weekday >= 1 && weekday <= 5;

// snapshot cutoffs (China minutes): stocks/ETF after 15:05, gold after 20:30, funds after 20:30
const CUTOFF = { exchange: 15 * 60 + 5, gold: 20 * 60 + 30, fund: 20 * 60 + 30 };

// ---------- calendar helpers (YYYY-MM-DD China dates as UTC day keys) ----------
const parseYmd = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (s, n) => new Date(parseYmd(s).getTime() + n * 86400000).toISOString().slice(0, 10);
const weekdayOf = (s) => parseYmd(s).getUTCDay(); // 0=Sun
const nextWeekday = (s) => { let d = s; while (weekdayOf(d) === 0 || weekdayOf(d) === 6) d = addDays(d, 1); return d; };
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- small db helpers ----------
async function rows(supabase, table, build) {
  const r = await build(supabase.from(table));
  if (r.error) throw new Error(`db_${table}`);
  return r.data ?? [];
}
const by = (supabase, table, cols) => (...args) =>
  rows(supabase, table, (q) => applyFilters(q.select(cols), args[0]));

function applyFilters(query, filters) {
  for (const [k, v] of Object.entries(filters ?? {})) {
    if (Array.isArray(v)) query = query.in(k, v);
    else query = query.eq(k, v);
  }
  return query;
}

async function selectWhere(supabase, table, cols, filters, order) {
  let q = applyFilters(supabase.from(table).select(cols), filters);
  if (order) q = q.order(order[0], { ascending: order[1] ?? true });
  const r = await q;
  if (r.error) throw new Error(`db_${table}`);
  return r.data ?? [];
}
async function insertRow(supabase, table, row) {
  const r = await supabase.from(table).insert(row);
  if (r.error) throw new Error(`db_${table}_insert`);
}
async function deleteWhere(supabase, table, filters) {
  const r = await applyFilters(supabase.from(table).delete(), filters);
  if (r.error) throw new Error(`db_${table}_delete`);
}

async function getRunState(supabase, key) {
  const r = await selectWhere(supabase, "run_state", "key,value", { key });
  return r[0]?.value ?? null;
}
async function setRunState(supabase, key, value) {
  const existing = await getRunState(supabase, key);
  if (existing == null) {
    await insertRow(supabase, "run_state", {
      id: crypto.randomUUID(), key, value, updated_at: new Date().toISOString(),
    });
  } else {
    const r = await supabase.from("run_state").update({ value, updated_at: new Date().toISOString() }).eq("key", key);
    if (r.error) throw new Error("db_run_state_update");
  }
}

// ---------- normalization / validation ----------
function normalizeCode(raw, assetType) {
  const code = String(raw ?? "").trim().toLowerCase();
  if (assetType === "gold" && code === "gold") return GOLD_CODE;
  if (isExchangeCode(code)) return code;
  if (isFundCode(code)) return code;
  if (assetType === "fund" && /^\d{6}$/.test(code)) return `f${code}`;
  if (assetType === "stock" || assetType === "etf") {
    const m = code.match(/^(sh|sz|bj)(\d{6})$/);
    if (m) return m[1] + m[2];
  }
  return null;
}
const amountStr = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1e12 ? String(n) : null;
};

// ---------- history for rules ----------
async function loadHistory(supabase, code, limitDays = 65) {
  const data = await selectWhere(
    supabase, "snapshots", "snapshot_date,price", { code }, ["snapshot_date", false],
  );
  return data.slice(0, limitDays).reverse()
    .map((d) => ({ date: d.snapshot_date, close: Number(d.price) }))
    .filter((d) => Number.isFinite(d.close));
}

async function backfillIfNeeded(supabase, code, history) {
  // Populate ~60 daily snapshots once per code from kline / NAV history.
  if (history.length >= 40) return history;
  const stateKey = `backfill:${code}`;
  if (await getRunState(supabase, stateKey)) return history;
  let series = [];
  let scaledFrom = null;
  try {
    if (isExchangeCode(code)) {
      series = await fetchKlineHistory(code, 60);
    } else if (isFundCode(code)) {
      series = (await fetchFundNavHistory(code.slice(1), 60))
        .map((d) => ({ date: d.date, close: d.nav }));
    } else if (code === GOLD_CODE) {
      // Au99.99 has no free daily history; proxy with gold ETF 518880 scaled to current price
      const etf = await fetchKlineHistory("sh518880", 60);
      const rt = await fetchRealtimeByCodes([GOLD_CODE]);
      const cur = rt[GOLD_CODE]?.price;
      const last = etf[etf.length - 1]?.close;
      if (cur && last) {
        const factor = cur / last;
        series = etf.map((d) => ({ date: d.date, close: Number((d.close * factor).toFixed(2)) }));
        scaledFrom = "sh518880";
      }
    }
  } catch { /* upstream failure: retry on next refresh */ }
  if (series.length >= 20 || scaledFrom) {
    const existingDates = new Set(history.map((h) => h.date));
    for (const s of series) {
      if (!existingDates.has(s.date)) {
        await insertRow(supabase, "snapshots", {
          id: crypto.randomUUID(), code, snapshot_date: s.date, price: String(s.close),
          source: code === GOLD_CODE ? `proxy:${scaledFrom}` : "backfill",
          created_at: new Date().toISOString(),
        });
      }
    }
    await setRunState(supabase, stateKey, cnParts().today);
    history = await loadHistory(supabase, code);
  } else if (series.length > 0) {
    // got some data but not enough; store it and mark backfill complete
    const existingDates = new Set(history.map((h) => h.date));
    for (const s of series) {
      if (!existingDates.has(s.date)) {
        await insertRow(supabase, "snapshots", {
          id: crypto.randomUUID(), code, snapshot_date: s.date, price: String(s.close),
          source: "backfill", created_at: new Date().toISOString(),
        });
      }
    }
    await setRunState(supabase, stateKey, cnParts().today);
    history = await loadHistory(supabase, code);
  }
  return history;
}

// ---------- DCA plans: lazy auto-billing (design 9.1) ----------
const FREQS = new Set(["daily", "weekly", "monthly"]);
const PLAN_COLS = "id,position_id,amount,freq,wday,mday,status,start_date,last_billed_date";
const dcaFreqLabel = (p) =>
  p.freq === "daily" ? "每日"
    : p.freq === "weekly" ? `每周${"日一二三四五六"[Number(p.wday)] ?? "日"}`
    : `每月${Number(p.mday)}号`;

function isDcaOccurrence(plan, dateStr) {
  const wd = weekdayOf(dateStr);
  if (plan.freq === "daily") return wd >= 1 && wd <= 5; // daily DCA deducts on trading days only
  if (plan.freq === "weekly") return wd === Number(plan.wday);
  if (plan.freq === "monthly") return Number(dateStr.slice(8, 10)) === Number(plan.mday);
  return false;
}
function nextDcaOccurrence(plan, fromDate) {
  let d = fromDate;
  for (let i = 0; i < 400; i++, d = addDays(d, 1)) if (isDcaOccurrence(plan, d)) return d;
  return null;
}

async function billDcaPlans(supabase, userId, today) {
  const plans = await selectWhere(supabase, "dca_plans", PLAN_COLS, { user_id: userId, status: "active" });
  let billed = 0;
  const settingsRows = await selectWhere(supabase, "settings", "data", { user_id: userId });
  const settingsData = settingsRows[0]?.data ?? {};
  for (const plan of plans) {
    const pos = await selectWhere(supabase, "positions", "id,code,quantity,cost_price,overrides",
      { id: plan.position_id, user_id: userId });
    if (!pos.length) continue;
    const feeCfg = feeConfig(settingsData, pos[0].overrides ?? {});
    let cursor = plan.last_billed_date ? addDays(plan.last_billed_date, 1) : plan.start_date;
    if (cursor > today) continue;
    const snaps = await selectWhere(supabase, "snapshots", "snapshot_date,price",
      { code: pos[0].code }, ["snapshot_date", true]);
    let qty = Number(pos[0].quantity), cost = Number(pos[0].cost_price);
    for (let n = 0; n < 40; n++) { // bound work per trigger
      const occ = nextDcaOccurrence(plan, cursor);
      if (!occ || occ > today) break;
      cursor = addDays(occ, 1);
      const stateKey = `dca:${plan.id}:${occ}`;
      if (await getRunState(supabase, stateKey)) continue; // already billed (or manually corrected)
      const billDate = nextWeekday(occ); // weekend debit shifts to Monday
      if (billDate > today) break;       // not debited yet
      const nav = snaps.find((s) => s.snapshot_date >= occ && s.snapshot_date <= addDays(occ, 12)
        && Number(s.price) > 0);
      if (!nav) break; // NAV not published yet (holiday/evening): stop, catch up next trigger
      // debit amount is gross: fee = net*r, shares bought with net = amount/(1+r)
      const amount = Number(plan.amount);
      const netAmt = amount / (1 + feeCfg.subscribePct / 100);
      const addQty = Math.round((netAmt / Number(nav.price)) * 100) / 100;
      const feeAmt = round2(amount - netAmt);
      if (addQty > 0) {
        const newCost = qty + addQty > 0
          ? (qty * cost + amount) / (qty + addQty) : amount / addQty;
        const newQty = qty + addQty;
        await insertRow(supabase, "trades", {
          id: crypto.randomUUID(), user_id: userId, position_id: pos[0].id, side: "buy",
          price: nav.price, quantity: String(addQty), trade_date: billDate, source: "dca",
          fee: String(feeAmt), net_amount: String(round2(addQty * Number(nav.price))),
          created_at: new Date().toISOString(),
        });
        const r = await supabase.from("positions")
          .update({ quantity: String(round(newQty)), cost_price: String(round(newCost, 4)), updated_at: new Date().toISOString() })
          .eq("id", pos[0].id).eq("user_id", userId);
        if (r.error) throw new Error("db_positions_update");
        qty = newQty; cost = newCost;
        await setRunState(supabase, stateKey, billDate);
        const up = await supabase.from("dca_plans")
          .update({ last_billed_date: occ, updated_at: new Date().toISOString() }).eq("id", plan.id);
        if (up.error) throw new Error("db_dca_plans_update");
        plan.last_billed_date = occ;
        billed++;
      }
    }
  }
  return billed;
}

async function rebuildPositionFromTrades(supabase, userId, positionId) {
  // deterministic replay of remaining trades (used after a manual trade deletion)
  const trades = await selectWhere(supabase, "trades", "side,price,quantity,fee",
    { user_id: userId, position_id: positionId }, ["trade_date", true]);
  let qty = 0, cost = 0;
  for (const t of trades) {
    const q = Number(t.quantity), p = Number(t.price);
    if (t.side === "buy") {
      // buy-side fee (null for legacy rows and non-funds) is part of the true cost
      const paid = q * p + (Number(t.fee) || 0);
      cost = qty + q > 0 ? (qty * cost + paid) / (qty + q) : p;
      qty += q;
    } else qty = Math.max(0, qty - q);
  }
  const r = await supabase.from("positions")
    .update({ quantity: String(round(qty)), cost_price: String(round(cost, 4)), updated_at: new Date().toISOString() })
    .eq("id", positionId).eq("user_id", userId);
  if (r.error) throw new Error("db_positions_update");
  return { quantity: String(round(qty)), cost_price: String(round(cost, 4)) };
}

// ---------- intraday fund estimates (design 9.3): display-only ----------
const SESSION = { start: 9 * 60 + 30, end: 15 * 60 };
const META_TTL_MS = 7 * 86400000, META_RETRY_MS = 86400000;

async function fundMeta(supabase, code) {
  const key = `fundmeta:${code}`;
  const cached = await getRunState(supabase, key);
  const age = cached?.cached_at ? Date.now() - Date.parse(cached.cached_at) : Infinity;
  const useful = cached && (cached.indexCode || (cached.holdings ?? []).length);
  if (cached && age < (useful ? META_TTL_MS : META_RETRY_MS)) return cached;
  let indexCode = null, holdings = [];
  try {
    const b = await fetchFundIndexBinding(code.slice(1));
    if (b) indexCode = b.indexCode;
  } catch { /* upstream failure */ }
  if (!indexCode) {
    try { holdings = await fetchFundTopHoldings(code.slice(1)); } catch { /* ignore */ }
  }
  const meta = { indexCode, holdings, cached_at: new Date().toISOString() };
  await setRunState(supabase, key, meta);
  return meta;
}

async function buildEstimates(supabase, fundCodes, latestNav) {
  const metas = {};
  for (const code of fundCodes) metas[code] = await fundMeta(supabase, code);
  const need = [...new Set(Object.values(metas)
    .flatMap((m) => (m.indexCode ? [m.indexCode] : m.holdings.map((h) => h.code))))];
  let rt = {};
  try { rt = await fetchRealtimeByCodes(need); } catch { return {}; }
  const out = {};
  for (const [code, m] of Object.entries(metas)) {
    const base = latestNav[code]?.price;
    if (!base) continue;
    if (m.indexCode && rt[m.indexCode]?.pct != null) {
      const pct = rt[m.indexCode].pct;
      out[code] = { pct: round2(pct), est_nav: round2(base * (1 + pct / 100) * 1e2) / 1e2, basis: "index", label: "估" };
    } else if (m.holdings.length) {
      let acc = 0, cov = 0;
      for (const h of m.holdings) {
        const q = rt[h.code];
        if (q?.pct != null) { acc += (h.weightPct / 100) * q.pct; cov += h.weightPct; }
      }
      if (cov >= 20) { // too little A-share coverage -> no meaningful estimate
        out[code] = {
          pct: Math.round(acc * 100) / 100,
          est_nav: Math.round(base * (1 + acc / 100) * 1e4) / 1e4,
          basis: "holdings", coverage: Math.round(cov), label: "粗估",
        };
      }
    }
  }
  return out;
}

// ---------- advice generation ----------
async function regenerateAdvices(supabase, userId, realtime, { today, minutes }) {
  const [positions, settingsRows, tradesAll, dcaRows] = await Promise.all([
    selectWhere(supabase, "positions",
      "id,code,name,asset_type,quantity,cost_price,opened_date,overrides", { user_id: userId }),
    selectWhere(supabase, "settings", "data", { user_id: userId }),
    selectWhere(supabase, "trades", "position_id,side,trade_date,quantity", { user_id: userId }),
    selectWhere(supabase, "dca_plans", PLAN_COLS, { user_id: userId, status: "active" }),
  ]);
  const dcaByPos = Object.fromEntries(dcaRows.map((r) => [r.position_id, r]));
  const settings = settingsRows[0]?.data ?? {};
  const codes = [...new Set(positions.map((p) => p.code))];
  const histories = {};
  for (const code of codes) {
    let h = await loadHistory(supabase, code);
    h = await backfillIfNeeded(supabase, code, h);
    histories[code] = h;
  }
  let indexCloses = null;
  if (positions.some((p) => p.asset_type === "fund")) {
    try {
      indexCloses = (await fetchKlineHistory("sh000300", 61)).map((d) => d.close);
    } catch { /* F5 silently skipped */ }
  }

  const enriched = positions.map((p) => {
    const price = realtime[p.code]?.price ?? lastSnapshotPrice(histories[p.code]);
    const mv = price != null ? price * Number(p.quantity) : 0;
    return { p, mv, price };
  }).filter((e) => e.mv > 0);
  const totalValue = enriched.reduce((s, e) => s + e.mv, 0);

  const out = [];
  for (const e of enriched) {
    const posTrades = tradesAll
      .filter((t) => t.position_id === e.p.id)
      .sort((a, b) => (a.trade_date < b.trade_date ? -1 : 1));
    const lastBuys = posTrades.filter((t) => t.side === "buy").map((t) => t.trade_date);
    const isFund = e.p.asset_type === "fund";
    const advices = evaluatePosition({
      position: {
        code: e.p.code, name: e.p.name, asset_type: e.p.asset_type,
        quantity: Number(e.p.quantity), costPrice: Number(e.p.cost_price),
        openedDate: e.p.opened_date, overrides: e.p.overrides ?? {},
        dca: dcaByPos[e.p.id]
          ? { amount: Number(dcaByPos[e.p.id].amount), freqLabel: dcaFreqLabel(dcaByPos[e.p.id]) }
          : null,
      },
      quote: realtime[e.p.code] ?? { price: e.price },
      history: histories[e.p.code] ?? [],
      totalValue, settings, today,
      lastBuyDate: lastBuys[lastBuys.length - 1] ?? null,
      indexCloses,
      feeCfg: isFund ? feeConfig(settings, e.p.overrides ?? {}) : undefined,
      buyLots: isFund ? buildBuyLots(posTrades) : undefined,
    });
    out.push(...advices);
  }
  out.push(...evaluateAllocation(
    enriched.map((e) => ({ asset_type: e.p.asset_type, mv: e.mv })), settings,
    { fundHasDca: dcaRows.length > 0 },
  ));

  await deleteWhere(supabase, "advices", { user_id: userId, advice_date: today });
  for (const a of out) {
    await insertRow(supabase, "advices", {
      id: crypto.randomUUID(), user_id: userId, code: a.code, name: a.name,
      asset_type: a.asset_type, action: a.action, rule_id: a.rule_id,
      severity: a.severity, reason: a.reason, detail: a.detail ?? {},
      advice_date: today, created_at: new Date().toISOString(),
    });
  }
  await setRunState(supabase, `advices:${userId}`, today);
  return { advices: out, totalValue };
}

const lastSnapshotPrice = (history) => (history.length ? history[history.length - 1].close : null);

// ---------- dashboard payload ----------
function buildPositionsView(positions, realtime, snapshotsLatest, today) {
  return positions.map((p) => {
    const rt = realtime[p.code];
    const price = rt?.price ?? snapshotsLatest[p.code] ?? null;
    const cost = Number(p.cost_price);
    const qty = Number(p.quantity);
    const mv = price != null ? price * qty : 0;
    const pnlPct = price != null && cost ? (price / cost - 1) * 100 : null;
    let daysHeld = null;
    if (p.opened_date) {
      daysHeld = Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${p.opened_date}T00:00:00Z`)) / 86400000));
    }
    return {
      id: p.id, code: p.code, name: p.name, asset_type: p.asset_type,
      quantity: p.quantity, cost_price: p.cost_price, opened_date: p.opened_date,
      overrides: p.overrides ?? null,
      price, prev_close: rt?.prevClose ?? null, day_pct: rt?.pct ?? null,
      market_value: Math.round(mv * 100) / 100,
      pnl_pct: pnlPct == null ? null : Math.round(pnlPct * 100) / 100,
      pnl_amount: price != null ? Math.round((price - cost) * qty * 100) / 100 : null,
      days_held: daysHeld,
      fee_warning: p.asset_type === "fund" && daysHeld != null && daysHeld < 7,
      source: rt ? "realtime" : "snapshot",
    };
  });
}

// ---------- main handler ----------
export async function handleApp({ request, supabase }) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const method = request.method;
  try {
    return await route(action, method, request, supabase, url);
  } catch (err) {
    const code = String(err?.message ?? "").startsWith("db_") ? err.message : "internal";
    return json({ error: code === "internal" ? "internal_error" : code, ok: false },
      code === "internal" ? 500 : 503);
  }
}

async function readBody(request) {
  const len = Number(request.headers.get("content-length") ?? 0);
  if (!Number.isFinite(len) || len <= 0 || len > MAX_BODY) throw new Error("invalid_body");
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("invalid_content_type");
  return await request.json();
}

async function route(action, method, request, supabase, url) {
  // ---------- GET ----------
  if (method === "GET") {
    if (action === "users") {
      const data = await selectWhere(supabase, "users", "id,name,created_at", {}, ["created_at", true]);
      return json({ ok: true, users: data });
    }
    if (action === "lookup") {
      const q = url.searchParams.get("q") ?? "";
      if (!/^[0-9A-Za-z]{1,10}$/.test(q.trim())) return json({ ok: true, results: [] });
      return json({ ok: true, results: await lookupSymbol(q) });
    }
    const uid = url.searchParams.get("user_id");
    if (!UUID_RE.test(uid ?? "")) return json({ error: "invalid_user_id", ok: false }, 400);
    if (action === "dashboard") {
      const parts0 = cnParts();
      try { await billDcaPlans(supabase, uid, parts0.today); } catch { /* billing must never break viewing */ }
      const [positions, advToday, dcaRows, settingsRows] = await Promise.all([
        selectWhere(supabase, "positions",
          "id,code,name,asset_type,quantity,cost_price,opened_date,overrides", { user_id: uid }),
        selectWhere(supabase, "advices",
          "id,code,name,asset_type,action,rule_id,severity,reason,detail,advice_date",
          { user_id: uid }, ["advice_date", false]),
        selectWhere(supabase, "dca_plans", PLAN_COLS, { user_id: uid }),
        selectWhere(supabase, "settings", "data", { user_id: uid }),
      ]);
      const codes = [...new Set(positions.map((p) => p.code))];
      const snaps = await selectWhere(supabase, "snapshots", "code,snapshot_date,price", { code: codes.length ? codes : "__none__" });
      const latest = {};
      for (const s of snaps) {
        if (!latest[s.code] || s.snapshot_date > latest[s.code].date) {
          latest[s.code] = { date: s.snapshot_date, price: Number(s.price) };
        }
      }
      // light realtime touch for exchange codes + gold during trading display
      const rtTargets = codes.filter((c) => isExchangeCode(c) || c === GOLD_CODE);
      let realtime = {};
      try { realtime = await fetchRealtimeByCodes(rtTargets); } catch { /* snapshot fallback */ }
      const view = buildPositionsView(positions, realtime,
        Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.price])), parts0.today);
      const total = view.reduce((s, v) => s + (v.market_value || 0), 0);
      const dayPnl = view.reduce((s, v) => {
        if (v.price == null || v.prev_close == null) return s;
        return s + (v.price - v.prev_close) * Number(v.quantity);
      }, 0);
      // intraday estimates for OTC funds, trading session only (design 9.3)
      let estimates = {};
      const fundCodes = codes.filter(isFundCode);
      if (fundCodes.length && isTradingDay(parts0)
        && parts0.minutes >= SESSION.start && parts0.minutes < SESSION.end) {
        try { estimates = await buildEstimates(supabase, fundCodes, latest); } catch { /* optional */ }
      }
      const latestAdviceDate = advToday[0]?.advice_date ?? null;
      const advices = advToday.filter((a) => a.advice_date === latestAdviceDate);
      const dashSettings = settingsRows[0]?.data ?? {};
      const feeCfgByPos = {};
      for (const p of positions) {
        if (p.asset_type === "fund") feeCfgByPos[p.id] = feeConfig(dashSettings, p.overrides ?? {});
      }
      return json({
        ok: true, positions: view, total_value: Math.round(total * 100) / 100,
        day_pnl: Math.round(dayPnl * 100) / 100, advices, advice_date: latestAdviceDate,
        snapshot_dates: latest, estimates,
        fee_defaults: dashSettings.fee ?? {}, fee_cfg_by_pos: feeCfgByPos,
        dca_plans: dcaRows.map((r) => ({ ...r, freq_label: dcaFreqLabel(r) })),
      });
    }
    if (action === "today") {
      // M6 今日收益（design 11）：只读展示，不落库、不重算建议、不扣定投
      const parts = cnParts();
      const tradingToday = isTradingDay(parts);
      let anchor = parts.today;
      if (!tradingToday) {
        let d = parts.today;
        do { d = addDays(d, -1); } while (weekdayOf(d) === 0 || weekdayOf(d) === 6);
        anchor = d;
      }
      const exchSession = tradingToday && parts.minutes >= SESSION.start && parts.minutes < SESSION.end;
      const goldSession = tradingToday && parts.minutes >= 9 * 60 && parts.minutes < CUTOFF.gold;
      const positions = await selectWhere(supabase, "positions",
        "code,name,asset_type,quantity", { user_id: uid });
      const codes = [...new Set(positions.map((p) => p.code))];
      let realtime = {};
      try { realtime = await fetchRealtimeByCodes(codes); } catch { /* rows fall back to status none */ }
      // OTC estimates: from session start until that day's NAV is published; skip already-confirmed funds
      let estimates = {};
      const estTargets = codes.filter((c) => isFundCode(c) && realtime[c]?.quoteTime !== anchor);
      if (estTargets.length && tradingToday && parts.minutes >= SESSION.start) {
        const base = {};
        for (const c of estTargets) {
          const r = realtime[c];
          if (r?.price != null) base[c] = { date: r.quoteTime, price: Number(r.price) };
        }
        try { estimates = await buildEstimates(supabase, estTargets, base); } catch { /* optional */ }
      }
      const byType = { fund: [], etf: [], gold: [], stock: [] };
      for (const p of positions) {
        const qty = Number(p.quantity);
        const r = realtime[p.code];
        const row = { code: p.code, name: p.name, status: "none",
          day_pct: null, day_amount: null, market_value: null, ref_date: null, basis: null };
        if (r && r.price != null) {
          const nav = Number(r.price);
          const prev = r.prevClose != null ? Number(r.prevClose) : null;
          const pctv = r.pct != null ? round2(Number(r.pct))
            : prev && prev ? round2((nav / prev - 1) * 100) : null;
          if (p.asset_type === "fund") {
            const navDate = DATE_RE.test(String(r.quoteTime ?? "")) ? r.quoteTime : null;
            if (navDate === anchor) {
              row.status = "confirmed"; row.day_pct = pctv;
              row.day_amount = prev != null ? round2((nav - prev) * qty) : null;
              row.ref_date = navDate;
              row.market_value = round2(nav * qty);
            } else {
              const est = estimates[p.code];
              if (est && est.pct != null) {
                row.status = "estimate"; row.basis = est.basis ?? null; row.ref_date = anchor;
                row.day_pct = round2(est.pct);
                row.day_amount = round2(nav * est.pct / 100 * qty);
                row.market_value = round2(nav * (1 + est.pct / 100) * qty);
              } else {
                // last published day's move, shown greyed and excluded from totals
                row.status = "pending"; row.day_pct = pctv;
                row.day_amount = prev != null ? round2((nav - prev) * qty) : null;
                row.ref_date = navDate;
                row.market_value = round2(nav * qty);
              }
            }
          } else {
            row.status = (p.asset_type === "gold" ? goldSession : exchSession) ? "realtime" : "closed";
            row.ref_date = tradingToday ? parts.today : anchor;
            row.day_pct = pctv;
            row.day_amount = prev != null ? round2((nav - prev) * qty) : null;
            row.market_value = round2(nav * qty);
          }
        }
        (byType[p.asset_type] ?? byType.stock).push(row);
      }
      const TODAY_LABELS = { fund: "场外基金", etf: "场内ETF", gold: "积存金", stock: "股票" };
      const groups = [];
      for (const t of ["fund", "etf", "gold", "stock"]) {
        const rs = byType[t];
        if (!rs.length) continue;
        const bucket = (st) => round2(rs.filter((x) => x.status === st)
          .reduce((s, x) => s + (x.day_amount ?? 0), 0));
        const counted = rs.filter((x) => x.status !== "pending" && x.status !== "none");
        const amount = round2(counted.reduce((s, x) => s + (x.day_amount ?? 0), 0));
        const mv = counted.reduce((s, x) => s + (x.market_value ?? 0), 0);
        groups.push({
          type: t, label: TODAY_LABELS[t],
          subtotal: {
            amount, pct: mv ? round2(amount / mv * 100) : null,
            live_amt: bucket("realtime"),
            confirmed_amt: round2(bucket("closed") + bucket("confirmed")),
            estimate_amt: bucket("estimate"),
          },
          pending_count: rs.filter((x) => x.status === "pending").length,
          none_count: rs.filter((x) => x.status === "none").length,
          rows: rs,
        });
      }
      const totalAmount = round2(groups.reduce((s, g) => s + g.subtotal.amount, 0));
      const totalMv = round2(groups.reduce((s, g) =>
        s + g.rows.filter((x) => x.status !== "pending" && x.status !== "none")
          .reduce((a, x) => a + (x.market_value ?? 0), 0), 0));
      return json({
        ok: true, anchor_date: anchor, anchor_is_today: tradingToday,
        in_session: exchSession,
        total: { amount: totalAmount, pct: totalMv ? round2(totalAmount / totalMv * 100) : null },
        groups,
      });
    }
    if (action === "history") {
      const code = url.searchParams.get("code") ?? "";
      const days = Math.min(120, Number(url.searchParams.get("days") ?? 60) || 60);
      const data = await selectWhere(supabase, "snapshots", "snapshot_date,price", { code }, ["snapshot_date", false]);
      return json({ ok: true, points: data.slice(0, days).reverse() });
    }
    if (action === "trades") {
      const data = await selectWhere(supabase, "trades",
        "id,position_id,side,price,quantity,trade_date,source,fee,net_amount", { user_id: uid }, ["trade_date", false]);
      const positions = await selectWhere(supabase, "positions", "id,name,code", { user_id: uid });
      const names = Object.fromEntries(positions.map((p) => [p.id, p.name]));
      return json({ ok: true, trades: data.map((t) => ({ ...t, position_name: names[t.position_id] ?? t.position_id })) });
    }
    if (action === "dcas") {
      const [plans, positions] = await Promise.all([
        selectWhere(supabase, "dca_plans", PLAN_COLS, { user_id: uid }),
        selectWhere(supabase, "positions", "id,name,code", { user_id: uid }),
      ]);
      const posById = Object.fromEntries(positions.map((p) => [p.id, p]));
      return json({
        ok: true,
        plans: plans.map((r) => ({
          ...r, freq_label: dcaFreqLabel(r),
          position_name: posById[r.position_id]?.name ?? null,
          code: posById[r.position_id]?.code ?? null,
        })),
      });
    }
    if (action === "settings") {
      const data = await selectWhere(supabase, "settings", "data", { user_id: uid });
      return json({ ok: true, settings: data[0]?.data ?? {} });
    }
    if (action === "advice_history") {
      const data = await selectWhere(supabase, "advices",
        "code,name,asset_type,action,rule_id,severity,reason,advice_date", { user_id: uid }, ["advice_date", false]);
      return json({ ok: true, advices: data.slice(0, 200) });
    }
    return json({ error: "not_found", ok: false }, 404);
  }

  // ---------- POST ----------
  if (method !== "POST") return json({ error: "method_not_allowed", ok: false }, 405);
  const body = await readBody(request);

  if (action === "create_user") {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 20) return json({ error: "invalid_name", ok: false }, 400);
    const existing = await selectWhere(supabase, "users", "id,name", { name });
    if (existing.length) return json({ ok: true, user: existing[0], existed: true });
    const user = { id: crypto.randomUUID(), name, created_at: new Date().toISOString() };
    await insertRow(supabase, "users", user);
    return json({ ok: true, user });
  }

  const uid = body.user_id;
  if (!UUID_RE.test(uid ?? "")) return json({ error: "invalid_user_id", ok: false }, 400);
  const parts = cnParts();

  if (action === "refresh") {
    const positions = await selectWhere(supabase, "positions", "code", { user_id: uid });
    const codes = [...new Set(positions.map((p) => p.code))];
    let realtime = {};
    try { realtime = await fetchRealtimeByCodes(codes); } catch { /* fall back to snapshots */ }
    // record post-close daily snapshots once per code per day
    if (isTradingDay(parts)) {
      for (const [code, q] of Object.entries(realtime)) {
        if (q.price == null) continue;
        const cutoff = isFundCode(code) ? CUTOFF.fund : code === GOLD_CODE ? CUTOFF.gold : CUTOFF.exchange;
        if (parts.minutes < cutoff) continue;
        const snapDate = isFundCode(code) ? (q.quoteTime && DATE_RE.test(q.quoteTime) ? q.quoteTime : parts.today) : parts.today;
        const key = `snap:${code}:${snapDate}`;
        if (await getRunState(supabase, key)) continue;
        await insertRow(supabase, "snapshots", {
          id: crypto.randomUUID(), code, snapshot_date: snapDate, price: String(q.price),
          source: "close", created_at: new Date().toISOString(),
        });
        await setRunState(supabase, key, "done");
      }
    }
    const billed = await billDcaPlans(supabase, uid, parts.today);
    const { totalValue } = await regenerateAdvices(supabase, uid, realtime, parts);
    return json({ ok: true, realtime, regenerated_at: parts.today, total_value: totalValue, dca_billed: billed });
  }

  if (action === "add_position") {
    const assetType = String(body.asset_type ?? "");
    if (!ASSET_TYPES.has(assetType)) return json({ error: "invalid_asset_type", ok: false }, 400);
    const code = normalizeCode(body.code, assetType);
    if (!code) return json({ error: "invalid_code", ok: false }, 400);
    const quantity = amountStr(body.quantity);
    const cost = amountStr(body.cost_price);
    const openedDate = String(body.opened_date ?? "");
    if (!quantity || !cost) return json({ error: "invalid_amount", ok: false }, 400);
    if (!DATE_RE.test(openedDate)) return json({ error: "invalid_date", ok: false }, 400);
    let name = String(body.name ?? "").trim().slice(0, 40);
    if (!name) {
      try {
        const rt = await fetchRealtimeByCodes([code]);
        name = rt[code]?.name ?? (isFundCode(code) ? await fetchFundName(code.slice(1)) : null);
      } catch { /* fall through */ }
    }
    if (!name) return json({ error: "name_unresolved", ok: false }, 400);
    const dup = await selectWhere(supabase, "positions", "id", { user_id: uid, code });
    if (dup.length) return json({ error: "duplicate_code", ok: false }, 409);
    // first fund purchase lot also pays subscription fee; cost basis becomes fee-inclusive (design 10.2)
    let costStored = cost, feeInit = null, netInit = null;
    if (assetType === "fund") {
      const settingsRows = await selectWhere(supabase, "settings", "data", { user_id: uid });
      const r = (settingsRows[0]?.data?.fee?.subscribePct ?? 0.15) / 100;
      netInit = round2(Number(quantity) * Number(cost));
      feeInit = round2(netInit * r);
      costStored = String(round(Number(cost) * (1 + r), 4));
    }
    const position = {
      id: crypto.randomUUID(), user_id: uid, code, name, asset_type: assetType,
      quantity, cost_price: costStored, opened_date: openedDate, overrides: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await insertRow(supabase, "positions", position);
    await insertRow(supabase, "trades", {
      id: crypto.randomUUID(), user_id: uid, position_id: position.id, side: "buy",
      price: cost, quantity, trade_date: openedDate, source: "manual",
      fee: feeInit == null ? null : String(feeInit),
      net_amount: netInit == null ? null : String(netInit),
      created_at: new Date().toISOString(),
    });
    return json({ ok: true, position });
  }

  if (action === "update_position") {
    const pid = body.id;
    if (!UUID_RE.test(pid ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const patch = {};
    if (body.asset_type != null) {
      // allow only stock↔etf corrections (codes stay exchange-format; fund/gold feeds differ)
      const at = String(body.asset_type);
      if (!ASSET_TYPES.has(at)) return json({ error: "invalid_asset_type", ok: false }, 400);
      const cur = await selectWhere(supabase, "positions", "asset_type", { id: pid, user_id: uid });
      if (!cur.length) return json({ error: "not_found", ok: false }, 404);
      if (at !== cur[0].asset_type) {
        if (!["stock", "etf"].includes(cur[0].asset_type) || !["stock", "etf"].includes(at)) {
          return json({ error: "asset_type_locked", ok: false }, 400);
        }
        patch.asset_type = at;
      }
    }
    if (body.name != null) {
      const n = String(body.name).trim().slice(0, 40);
      if (!n) return json({ error: "invalid_name", ok: false }, 400);
      patch.name = n;
    }
    if (body.opened_date != null) {
      if (!DATE_RE.test(body.opened_date)) return json({ error: "invalid_date", ok: false }, 400);
      patch.opened_date = body.opened_date;
    }
    if (body.overrides !== undefined) {
      patch.overrides = body.overrides === null ? null : sanitizeOverrides(body.overrides);
    }
    patch.updated_at = new Date().toISOString();
    if (Object.keys(patch).length <= 1) return json({ error: "empty_patch", ok: false }, 400);
    const r = await supabase.from("positions").update(patch)
      .eq("id", pid).eq("user_id", uid).select("id").maybeSingle();
    if (r.error) throw new Error("db_positions_update");
    if (!r.data) return json({ error: "not_found", ok: false }, 404);
    return json({ ok: true, id: pid });
  }

  if (action === "delete_position") {
    const pid = body.id;
    if (!UUID_RE.test(pid ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const r = await supabase.from("positions").delete().eq("id", pid).eq("user_id", uid).select("id").maybeSingle();
    if (r.error) throw new Error("db_positions_delete");
    if (!r.data) return json({ error: "not_found", ok: false }, 404);
    await deleteWhere(supabase, "trades", { user_id: uid, position_id: pid });
    return json({ ok: true });
  }

  if (action === "add_trade") {
    const pid = body.position_id;
    const side = String(body.side ?? "");
    if (!UUID_RE.test(pid ?? "") || !["buy", "sell"].includes(side)) {
      return json({ error: "invalid_trade", ok: false }, 400);
    }
    const price = amountStr(body.price);
    const quantity = amountStr(body.quantity);
    const tradeDate = String(body.trade_date ?? "");
    if (!price || !quantity || !DATE_RE.test(tradeDate)) {
      return json({ error: "invalid_trade", ok: false }, 400);
    }
    if (side === "sell" && tradeDate > parts.today) return json({ error: "invalid_date", ok: false }, 400);
    const pos = await selectWhere(supabase, "positions",
      "id,asset_type,quantity,cost_price,overrides", { id: pid, user_id: uid });
    if (!pos.length) return json({ error: "not_found", ok: false }, 404);
    const qty = Number(pos[0].quantity), cost = Number(pos[0].cost_price);
    const qtyN = Number(quantity), priceN = Number(price);
    if (side === "sell" && quantity > qty + 1e-9) {
      return json({ error: "sell_exceeds_position", ok: false }, 400);
    }
    let fee = null, net = null, newQty, newCost;
    if (pos[0].asset_type === "fund") {
      // OTC fund subscription/redemption fees (design 10.2); FIFO lots from trade history
      const [settingsRows, tradeRows] = await Promise.all([
        selectWhere(supabase, "settings", "data", { user_id: uid }),
        selectWhere(supabase, "trades", "side,quantity,trade_date", { user_id: uid, position_id: pid },
          ["trade_date", true]),
      ]);
      const cfg = feeConfig(settingsRows[0]?.data ?? {}, pos[0].overrides ?? {});
      const lots = buildBuyLots(tradeRows);
      if (side === "buy") {
        net = round2(qtyN * priceN);
        fee = round2(net * cfg.subscribePct / 100);
        newCost = (qty * cost + net + fee) / (qty + qtyN);
        newQty = qty + qtyN;
      } else {
        const est = sellFeeEstimate(lots, qtyN, priceN, cfg, tradeDate);
        fee = est.fee; net = est.net; // net = 到账金额
        newQty = Math.max(0, qty - qtyN);
        newCost = cost;
      }
    } else if (side === "buy") {
      newCost = (qty * cost + qtyN * priceN) / (qty + qtyN);
      newQty = qty + qtyN;
    } else {
      newQty = Math.max(0, qty - qtyN);
      newCost = cost;
    }
    await insertRow(supabase, "trades", {
      id: crypto.randomUUID(), user_id: uid, position_id: pid, side, price: String(price),
      quantity: String(quantity), trade_date: tradeDate, source: "manual",
      fee: fee == null ? null : String(fee), net_amount: net == null ? null : String(net),
      created_at: new Date().toISOString(),
    });
    const r = await supabase.from("positions")
      .update({ quantity: String(round(newQty)), cost_price: String(round(newCost, 4)), updated_at: new Date().toISOString() })
      .eq("id", pid).eq("user_id", uid);
    if (r.error) throw new Error("db_positions_update");
    return json({
      ok: true, quantity: String(round(newQty)), cost_price: String(round(newCost, 4)),
      fee: fee == null ? null : String(fee), net_amount: net == null ? null : String(net),
    });
  }

  if (action === "add_dca") {
    const pid = body.position_id;
    if (!UUID_RE.test(pid ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const pos = await selectWhere(supabase, "positions", "id,asset_type", { id: pid, user_id: uid });
    if (!pos.length) return json({ error: "not_found", ok: false }, 404);
    if (pos[0].asset_type !== "fund") return json({ error: "fund_only", ok: false }, 400);
    const dup = await selectWhere(supabase, "dca_plans", "id", { position_id: pid });
    if (dup.length) return json({ error: "duplicate_plan", ok: false }, 409);
    const amount = amountStr(body.amount);
    if (!amount) return json({ error: "invalid_amount", ok: false }, 400);
    const sched = planSchedule(body);
    if (sched.error) return json({ error: sched.error, ok: false }, 400);
    const startDate = String(body.start_date ?? "");
    if (!DATE_RE.test(startDate) || startDate > parts.today) return json({ error: "invalid_start_date", ok: false }, 400);
    const iso = new Date().toISOString();
    const row = {
      id: crypto.randomUUID(), user_id: uid, position_id: pid, amount,
      freq: sched.freq, wday: sched.wday, mday: sched.mday,
      status: "active", start_date: startDate, last_billed_date: null,
      created_at: iso, updated_at: iso,
    };
    await insertRow(supabase, "dca_plans", row);
    let billed = 0;
    try { billed = await billDcaPlans(supabase, uid, parts.today); } catch { /* next refresh catches up */ }
    return json({ ok: true, plan: { ...row, freq_label: dcaFreqLabel(row) }, billed });
  }

  if (action === "update_dca") {
    const planId = body.id;
    if (!UUID_RE.test(planId ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const existing = await selectWhere(supabase, "dca_plans", PLAN_COLS, { id: planId, user_id: uid });
    if (!existing.length) return json({ error: "not_found", ok: false }, 404);
    const base = existing[0];
    const patch = { updated_at: new Date().toISOString() };
    if (body.amount != null) {
      const a = amountStr(body.amount);
      if (!a) return json({ error: "invalid_amount", ok: false }, 400);
      patch.amount = a;
    }
    if (body.freq != null || body.wday != null || body.mday != null) {
      const sched = planSchedule(body, base);
      if (sched.error) return json({ error: sched.error, ok: false }, 400);
      Object.assign(patch, { freq: sched.freq, wday: sched.wday, mday: sched.mday });
    }
    if (body.status != null) {
      if (!["active", "paused"].includes(body.status)) return json({ error: "invalid_status", ok: false }, 400);
      patch.status = body.status;
    }
    if (body.start_date != null) {
      if (!DATE_RE.test(body.start_date) || body.start_date > addDays(parts.today, 30)) {
        return json({ error: "invalid_start_date", ok: false }, 400);
      }
      patch.start_date = body.start_date;
    }
    const r = await supabase.from("dca_plans").update(patch)
      .eq("id", planId).eq("user_id", uid).select("id").maybeSingle();
    if (r.error) throw new Error("db_dca_plans_update");
    if (!r.data) return json({ error: "not_found", ok: false }, 404);
    let billed = 0;
    if ((patch.status ?? base.status) === "active") {
      try { billed = await billDcaPlans(supabase, uid, parts.today); } catch { /* next refresh catches up */ }
    }
    return json({ ok: true, billed });
  }

  if (action === "delete_dca") {
    const planId = body.id;
    if (!UUID_RE.test(planId ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const r = await supabase.from("dca_plans").delete()
      .eq("id", planId).eq("user_id", uid).select("id").maybeSingle();
    if (r.error) throw new Error("db_dca_plans_delete");
    if (!r.data) return json({ error: "not_found", ok: false }, 404);
    return json({ ok: true }); // generated trades stay; delete individual trades to correct history
  }

  if (action === "delete_trade") {
    const tid = body.id;
    if (!UUID_RE.test(tid ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const t = await supabase.from("trades").delete()
      .eq("id", tid).eq("user_id", uid).select("position_id").maybeSingle();
    if (t.error) throw new Error("db_trades_delete");
    if (!t.data) return json({ error: "not_found", ok: false }, 404);
    const rebuilt = await rebuildPositionFromTrades(supabase, uid, t.data.position_id);
    return json({ ok: true, ...rebuilt });
  }

  if (action === "set_settings") {
    const data = sanitizeSettings(body.data);
    const existing = await selectWhere(supabase, "settings", "id", { user_id: uid });
    if (existing.length) {
      const r = await supabase.from("settings").update({ data, updated_at: new Date().toISOString() }).eq("id", existing[0].id);
      if (r.error) throw new Error("db_settings_update");
    } else {
      await insertRow(supabase, "settings", {
        id: crypto.randomUUID(), user_id: uid, data, updated_at: new Date().toISOString(),
      });
    }
    return json({ ok: true });
  }

  return json({ error: "not_found", ok: false }, 404);
}

const round = (n, d = 4) => Number(n.toFixed(d));

// frequency fields must stay consistent (weekly -> wday, monthly -> mday 1..28)
function planSchedule(body, base = {}) {
  const freq = body.freq != null ? String(body.freq) : base.freq;
  if (!FREQS.has(freq)) return { error: "invalid_freq" };
  let wday = base.wday ?? null;
  let mday = base.mday ?? null;
  if (body.wday != null) wday = String(body.wday);
  if (body.mday != null) mday = String(body.mday);
  if (freq === "weekly") {
    if (!/^[0-6]$/.test(String(wday ?? ""))) return { error: "invalid_wday" };
    mday = null;
  } else if (freq === "monthly") {
    const m = Number(mday);
    if (!Number.isInteger(m) || m < 1 || m > 28) return { error: "invalid_mday" };
    wday = null;
    mday = String(m);
  } else {
    wday = null;
    mday = null;
  }
  return { freq, wday, mday };
}

// only whitelisted numeric rule keys survive ("FEE" carries the fund fee override, see sanitizeFeeCfg)
function sanitizeRuleMap(obj, max = 10) {
  if (typeof obj !== "object" || obj === null) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, max)) {
    if (k === "FEE") continue;
    if (!/^(G|S|F|E|GD)\d$|^G\d+$/.test(k) || typeof v !== "object" || v === null) continue;
    const inner = {};
    for (const [ik, iv] of Object.entries(v).slice(0, 8)) {
      if (ik === "ladder" && Array.isArray(iv) && iv.length <= 6 && iv.every((x) => Number.isFinite(x))) inner[ik] = iv;
      else if (typeof iv === "number" && Number.isFinite(iv)) inner[ik] = iv;
    }
    out[k] = inner;
  }
  return out;
}
// { subscribePct: 0-2, tiers: [{maxDays int|null, pct 0-5}] max 6 }
function sanitizeFeeCfg(f) {
  if (typeof f !== "object" || f === null) return undefined;
  const out = {};
  if (Number.isFinite(f.subscribePct) && f.subscribePct >= 0 && f.subscribePct <= 2) out.subscribePct = f.subscribePct;
  if (Array.isArray(f.tiers) && f.tiers.length && f.tiers.length <= 6) {
    const tiers = f.tiers.map((tr) => {
      if (typeof tr !== "object" || tr === null || !Number.isFinite(tr.pct) || tr.pct < 0 || tr.pct > 5) return null;
      const maxDays = tr.maxDays == null ? null
        : Number.isInteger(tr.maxDays) && tr.maxDays > 0 ? tr.maxDays : undefined;
      return maxDays === undefined ? null : { maxDays, pct: tr.pct };
    });
    if (tiers.every((x) => x !== null)) out.tiers = tiers;
  }
  return Object.keys(out).length ? out : undefined;
}
function sanitizeOverrides(o) {
  if (typeof o !== "object" || o === null) return {};
  const out = sanitizeRuleMap(o);
  const fee = sanitizeFeeCfg(o.FEE);
  if (fee) out.FEE = fee;
  return out;
}
function sanitizeSettings(s) {
  if (typeof s !== "object" || s === null) return {};
  const out = {};
  if (typeof s.targetAllocation === "object" && s.targetAllocation) {
    const ta = {};
    for (const [k, v] of Object.entries(s.targetAllocation)) {
      if (["stock", "fund", "etf", "gold"].includes(k) && Number.isFinite(v)) ta[k] = v;
    }
    out.targetAllocation = ta;
  }
  if (Number.isFinite(s.targetGoldPct)) out.targetGoldPct = s.targetGoldPct;
  if (typeof s.global === "object" && s.global) out.global = sanitizeRuleMap(s.global);
  const fee = sanitizeFeeCfg(s.fee);
  if (fee) out.fee = fee;
  return out;
}
