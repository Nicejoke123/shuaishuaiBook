// Business API for the finance advisor site. All browser calls are same-origin
// /functions/v1/app?action=... . Reads are GET; every mutation is POST with
// server-side validation. Numbers are stored as validated numeric strings.
import {
  fetchRealtimeByCodes, fetchKlineHistory, fetchFundNavHistory, fetchFundName,
  lookupSymbol, isExchangeCode, isFundCode, GOLD_CODE,
} from "./quotes.mjs";
import { evaluatePosition, evaluateAllocation } from "./rules.mjs";

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

// ---------- advice generation ----------
async function regenerateAdvices(supabase, userId, realtime, { today, minutes }) {
  const [positions, settingsRows, tradesAll] = await Promise.all([
    selectWhere(supabase, "positions",
      "id,code,name,asset_type,quantity,cost_price,opened_date,overrides", { user_id: userId }),
    selectWhere(supabase, "settings", "data", { user_id: userId }),
    selectWhere(supabase, "trades", "position_id,side,trade_date", { user_id: userId }),
  ]);
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
    const lastBuys = tradesAll
      .filter((t) => t.position_id === e.p.id && t.side === "buy")
      .map((t) => t.trade_date).sort();
    const advices = evaluatePosition({
      position: {
        code: e.p.code, name: e.p.name, asset_type: e.p.asset_type,
        quantity: Number(e.p.quantity), costPrice: Number(e.p.cost_price),
        openedDate: e.p.opened_date, overrides: e.p.overrides ?? {},
      },
      quote: realtime[e.p.code] ?? { price: e.price },
      history: histories[e.p.code] ?? [],
      totalValue, settings, today,
      lastBuyDate: lastBuys[lastBuys.length - 1] ?? null,
      indexCloses,
    });
    out.push(...advices);
  }
  out.push(...evaluateAllocation(
    enriched.map((e) => ({ asset_type: e.p.asset_type, mv: e.mv })), settings,
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
      const [positions, advToday] = await Promise.all([
        selectWhere(supabase, "positions",
          "id,code,name,asset_type,quantity,cost_price,opened_date,overrides", { user_id: uid }),
        selectWhere(supabase, "advices",
          "id,code,name,asset_type,action,rule_id,severity,reason,detail,advice_date",
          { user_id: uid }, ["advice_date", false]),
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
        Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, v.price])), cnParts().today);
      const total = view.reduce((s, v) => s + (v.market_value || 0), 0);
      const dayPnl = view.reduce((s, v) => {
        if (v.price == null || v.prev_close == null) return s;
        return s + (v.price - v.prev_close) * Number(v.quantity);
      }, 0);
      const latestAdviceDate = advToday[0]?.advice_date ?? null;
      const advices = advToday.filter((a) => a.advice_date === latestAdviceDate);
      return json({
        ok: true, positions: view, total_value: Math.round(total * 100) / 100,
        day_pnl: Math.round(dayPnl * 100) / 100, advices, advice_date: latestAdviceDate,
        snapshot_dates: latest,
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
        "id,position_id,side,price,quantity,trade_date", { user_id: uid }, ["trade_date", false]);
      const positions = await selectWhere(supabase, "positions", "id,name,code", { user_id: uid });
      const names = Object.fromEntries(positions.map((p) => [p.id, p.name]));
      return json({ ok: true, trades: data.map((t) => ({ ...t, position_name: names[t.position_id] ?? t.position_id })) });
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
    const { totalValue } = await regenerateAdvices(supabase, uid, realtime, parts);
    return json({ ok: true, realtime, regenerated_at: parts.today, total_value: totalValue });
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
    const position = {
      id: crypto.randomUUID(), user_id: uid, code, name, asset_type: assetType,
      quantity, cost_price: cost, opened_date: openedDate, overrides: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    await insertRow(supabase, "positions", position);
    await insertRow(supabase, "trades", {
      id: crypto.randomUUID(), user_id: uid, position_id: position.id, side: "buy",
      price: cost, quantity, trade_date: openedDate,
      created_at: new Date().toISOString(),
    });
    return json({ ok: true, position });
  }

  if (action === "update_position") {
    const pid = body.id;
    if (!UUID_RE.test(pid ?? "")) return json({ error: "invalid_id", ok: false }, 400);
    const patch = {};
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
    const pos = await selectWhere(supabase, "positions", "id,quantity,cost_price", { id: pid, user_id: uid });
    if (!pos.length) return json({ error: "not_found", ok: false }, 404);
    const qty = Number(pos[0].quantity), cost = Number(pos[0].cost_price);
    let newQty, newCost;
    if (side === "buy") {
      newCost = (qty * cost + quantity * price) / (qty + quantity);
      newQty = qty + quantity;
    } else {
      if (quantity > qty + 1e-9) return json({ error: "sell_exceeds_position", ok: false }, 400);
      newQty = Math.max(0, qty - quantity);
      newCost = cost;
    }
    await insertRow(supabase, "trades", {
      id: crypto.randomUUID(), user_id: uid, position_id: pid, side, price: String(price),
      quantity: String(quantity), trade_date: tradeDate, created_at: new Date().toISOString(),
    });
    const r = await supabase.from("positions")
      .update({ quantity: String(round(newQty)), cost_price: String(round(newCost, 4)), updated_at: new Date().toISOString() })
      .eq("id", pid).eq("user_id", uid);
    if (r.error) throw new Error("db_positions_update");
    return json({ ok: true, quantity: String(round(newQty)), cost_price: String(round(newCost, 4)) });
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

// only whitelisted numeric rule keys survive
function sanitizeRuleMap(obj, max = 10) {
  if (typeof obj !== "object" || obj === null) return {};
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, max)) {
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
function sanitizeOverrides(o) { return sanitizeRuleMap(o); }
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
  return out;
}
