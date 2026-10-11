// Upstream market data fetchers (server-side only; browser never calls these).
// Sources verified working 2026-10-11: qt.gtimg.cn, hq.sinajs.cn, fundmobapi.eastmoney.com,
// web.ifzq.gtimg.cn kline, smartbox.gtimg.cn search, fund.eastmoney.com/pingzhongdata.

const TIMEOUT_MS = 8000;

const decodeGbk = (buf) => new TextDecoder("gbk").decode(buf);

async function get(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  return res;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---- A-share stocks & exchange-traded funds (Tencent realtime) ----
// code format: prefixed exchange, e.g. sh600519 / sz000001 / sh518880
export async function fetchTencentRealtime(codes) {
  if (!codes.length) return {};
  const res = await get(`https://qt.gtimg.cn/q=${codes.join(",")}`);
  const text = decodeGbk(await res.arrayBuffer());
  const out = {};
  for (const m of text.matchAll(/v_([a-z]{2}\d{6})="([^"]*)"/g)) {
    const [, code, body] = m;
    const f = body.split("~");
    if (f.length < 33) continue;
    out[code] = {
      name: f[1],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      high: num(f[33] ?? f[41]),
      low: num(f[34] ?? f[42]),
      pct: num(f[32]),
      quoteTime: f[30],
    };
  }
  return out;
}

// ---- Shanghai Gold Au99.99 (Sina, CNY per gram) — basis for 积存金 ----
export async function fetchGoldRealtime() {
  const res = await get("https://hq.sinajs.cn/list=gds_AUTD", {
    Referer: "https://finance.sina.com.cn",
  });
  const text = decodeGbk(await res.arrayBuffer());
  const m = text.match(/hq_str_gds_AUTD="([^"]*)"/);
  if (!m) throw new Error("gold_parse_failed");
  const f = m[1].split(",");
  const price = num(f[0]);
  const prev = num(f[7]);
  return {
    name: "上金所Au99.99",
    price,
    prevClose: prev ?? price,
    pct: prev ? Number((((price - prev) / prev) * 100).toFixed(2)) : 0,
    quoteDate: f[12],
  };
}

// ---- Daily kline history for stocks / ETFs / index (Tencent ifzq) ----
export async function fetchKlineHistory(code, days = 60) {
  const res = await get(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},day,,,${days},qfq`,
  );
  const json = await res.json();
  const node = json?.data?.[code];
  const rows = node?.qfqday ?? node?.day ?? [];
  // row: [date, open, close, high, low, volume]
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 3)
    .map((r) => ({ date: String(r[0]), close: num(r[2]) }))
    .filter((r) => r.close != null);
}

// ---- OTC fund NAV history (Eastmoney mobile API) ----
const FUND_QS = "deviceid=1&plat=Iphone&product=EFund&version=6.2.8";

export async function fetchFundNavHistory(fundCode, days = 60) {
  const res = await get(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNHisNetList?FCODE=${fundCode}&pageIndex=1&pageSize=${days}&${FUND_QS}`,
  );
  const json = await res.json();
  if (!json?.Success) throw new Error("fund_nav_unavailable");
  const rows = (json.Datas ?? [])
    .map((d) => ({ date: String(d.FSRQ), nav: num(d.DWJZ), pct: num(d.JZZZL) }))
    .filter((d) => d.nav != null);
  return rows.reverse(); // oldest first
}

// ---- Fund name (Eastmoney pingzhongdata, UTF-8) ----
export async function fetchFundName(fundCode) {
  const res = await get(`https://fund.eastmoney.com/pingzhongdata/${fundCode}.js`);
  const text = await res.text();
  const m = text.match(/var fS_name\s*=\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// ---- Code lookup for the position form ----
const unescapeUnicode = (s) => s.replace(/\\u([\da-f]{4})/gi, (_, h) =>
  String.fromCharCode(parseInt(h, 16)));

export async function lookupSymbol(query) {
  const q = query.trim();
  if (!/^[0-9A-Za-z]{1,10}$/.test(q)) return [];
  const results = [];
  try {
    const res = await get(`https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`);
    const text = decodeGbk(await res.arrayBuffer());
    const body = text.match(/v_hint="([^"]*)"/)?.[1] ?? "";
    if (body && body !== "N;") {
      for (const item of body.split("^")) {
        const p = item.split("~");
        if (p.length < 3) continue;
        const market = p[0]; // sh/sz/hk/us/mk...
        if (!["sh", "sz", "bj"].includes(market)) continue;
        const kind = (p[4] ?? "").toLowerCase();
        if (kind === "zs") continue; // skip plain indexes
        results.push({
          code: market + p[1],
          pureCode: p[1],
          name: unescapeUnicode(decodeURIComponent(p[2])),
          kind,
        });
      }
    }
  } catch { /* smartbox optional */ }
  // OTC fund: six digits without an exchange hit -> probe Eastmoney by code
  if (/^\d{6}$/.test(q) && !results.length) {
    try {
      const name = await fetchFundName(q);
      if (name) results.push({ code: `f${q}`, pureCode: q, name, kind: "otc" });
    } catch { /* ignore */ }
  }
  return results.slice(0, 10);
}

// ---- normalize user-entered codes to fetch keys ----
export const GOLD_CODE = "SGE_AU9999";

export function isFundCode(code) {
  return code.startsWith("f") && /^\d{6}$/.test(code.slice(1));
}

export function isExchangeCode(code) {
  return /^(sh|sz|bj)\d{6}$/.test(code);
}

export async function fetchRealtimeByCodes(codes) {
  // codes: normalized list. Returns { [code]: {name, price, prevClose, pct, quoteTime} }
  const out = {};
  const exch = codes.filter(isExchangeCode);
  const funds = codes.filter(isFundCode);
  const gold = codes.includes(GOLD_CODE);
  const jobs = [];
  if (exch.length) {
    jobs.push(
      fetchTencentRealtime(exch).then((m) => {
        for (const [k, v] of Object.entries(m)) out[k] = v;
      }).catch(() => {}),
    );
  }
  if (funds.length) {
    jobs.push(
      Promise.all(
        funds.map(async (code) => {
          try {
            const hist = await fetchFundNavHistory(code.slice(1), 3);
            const last = hist[hist.length - 1];
            if (last) {
              out[code] = {
                name: null,
                price: last.nav,
                prevClose: hist.length > 1 ? hist[hist.length - 2].nav : last.nav,
                pct: last.pct ?? 0,
                quoteTime: last.date,
              };
            }
          } catch { /* per-fund failure tolerated */ }
        }),
      ),
    );
  }
  if (gold) {
    jobs.push(
      fetchGoldRealtime().then((v) => { out[GOLD_CODE] = v; }).catch(() => {}),
    );
  }
  await Promise.all(jobs);
  return out;
}
