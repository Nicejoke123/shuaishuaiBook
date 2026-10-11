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

// ---- Bank 积存金 realtime quotes (JD Finance aggregator; verified 2026-10-12) ----
// Bank price ≈ SGE realtime + per-bank spread; 浙商 quotes run 24h. 招行 has NO public
// feed (probed all CMB-* codes: empty), so it stays on the SGE basis.
export const GOLD_BANKS = {
  CZB: { jd: "CZB-JCJ", label: "浙商积存金" },
  ICBC: { jd: "ICBC-JCJ", label: "工商积存金" },
  CMBC: { jd: "CMBC-JCJ", label: "民生积存金" },
  CNCB: { jd: "CNCB-JCJ", label: "中信积存金" },
  CGB: { jd: "CGB-JCJ0", label: "广发积存金" },
  CIB: { jd: "CIB-JCJ0", label: "兴业积存金" },
};

export async function fetchBankGoldRealtime(bank) {
  const g = GOLD_BANKS[bank];
  if (!g) throw new Error("unknown_gold_bank");
  const res = await get(
    `https://api.jdjygold.com/gw2/generic/produTools/h5/m/getGoldPrice?goldCode=${g.jd}`,
  );
  const json = await res.json();
  const d = json?.resultData?.data;
  const price = num(d?.lastPrice);
  if (price == null || price <= 0) throw new Error("bank_gold_unavailable");
  const prev = num(d?.preClose);
  const rp = num(d?.raisePercent); // fraction, e.g. 0.0018699 = +0.187%
  const t = d?.tradeDateTime; // serialized Java object
  const p2 = (x) => String(x ?? 0).padStart(2, "0");
  const quoteTime = t?.year
    ? `${t.year}-${p2(t.monthValue)}-${p2(t.dayOfMonth)} ${p2(t.hour)}:${p2(t.minute)}:${p2(t.second)}`
    : null;
  return {
    name: String(d?.name ?? g.label),
    price,
    prevClose: prev ?? price,
    pct: rp != null ? Number((rp * 100).toFixed(2))
      : prev ? Number((((price - prev) / prev) * 100).toFixed(2)) : 0,
    quoteTime,
    bankLabel: g.label,
  };
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

// ---- Intraday estimation sources (verified 2026-10-11) ----
// Official fund intraday valuation feeds were taken offline by regulation; we build
// our own estimate: index funds via their tracked index, active funds via the latest
// quarterly top-10 holdings. Display only — never for advice or billing.

export async function fetchFundIndexBinding(fundCode) {
  // -> { indexCode: "sh000300"|"usNDX"|null, indexName, ftype } | null
  const res = await get(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation?FCODE=${fundCode}&${FUND_QS}`,
  );
  const json = await res.json();
  const d = json?.Datas;
  if (!d) return null;
  const ftype = d.FTYPE ?? null;
  const disclosureDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.FEGMRQ ?? "")) ? d.FEGMRQ : null;
  const idx = String(d.INDEXCODE ?? "").trim();
  const exch = String(d.NEWINDEXTEXCH ?? d.INDEXTEXCH ?? "");
  if (/^\d{6}$/.test(idx)) {
    const prefix = exch === "1" ? "sh" : exch === "0" ? "sz" : null;
    if (prefix) return { indexCode: prefix + idx, indexName: d.INDEXNAME ?? null, ftype, disclosureDate };
  }
  const ov = OVERSEAS_INDEX_MAP[idx.toUpperCase()];
  if (ov) return { indexCode: ov, indexName: d.INDEXNAME ?? null, ftype, disclosureDate, overseas: true };
  return { indexCode: null, indexName: null, ftype, disclosureDate };
}

// ---- Overseas index quotes (Tencent; verified 2026-10-12) — QDII overnight estimate ----
// Only codes whose layout we parsed & cross-checked are whitelisted (usSPX doesn't exist,
// HKCEI/HSTECH field order differs from A-share layout → excluded until verified).
export const OVERSEAS_INDEX_MAP = { NDX100: "usNDX", HSI: "hkHSI" };
export const OVERSEAS_CODE_RE = /^(us|hk)[A-Z][A-Z0-9]{1,9}$/;

export async function fetchOverseasIndex(code) {
  const res = await get(`https://qt.gtimg.cn/q=${code}`);
  const text = decodeGbk(await res.arrayBuffer());
  const m = text.match(/v_[A-Za-z0-9]+="([^"]*)"/);
  if (!m) throw new Error("overseas_index_unavailable");
  const f = m[1].split("~");
  const price = num(f[3]);
  const prev = num(f[4]);
  if (price == null) throw new Error("overseas_index_unavailable");
  const quoteTime = f.slice(28, 33).find((x) => /20\d\d[-/]\d{2}[-/]\d{2}/.test(String(x))) ?? null;
  return {
    name: null,
    price,
    prevClose: prev,
    pct: prev ? Number((((price - prev) / prev) * 100).toFixed(2)) : num(f[32]),
    quoteTime,
  };
}

// ---- Full top-10 holdings for display (持仓大头): A + HK + US, all markets ----
export async function fetchFundHoldingsDetail(fundCode) {
  const qs = FUND_QS;
  const [posRes, basicRes] = await Promise.all([
    get(`https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${fundCode}&${qs}`),
    get(`https://fundmobapi.eastmoney.com/FundMNewApi/FundMNNBasicInformation?FCODE=${fundCode}&${qs}`)
      .catch(() => null),
  ]);
  const posJson = await posRes.json();
  const stocks = posJson?.Datas?.fundStocks ?? [];
  const marketOf = (t) => (t === "1" || t === "0" ? "A" : t === "116" ? "港"
    : t === "105" || t === "106" || t === "107" ? "美" : "—");
  const rows = stocks.slice(0, 10)
    .map((s) => ({
      code: String(s.GPDM ?? "").trim(),
      name: s.GPJC ?? null,
      market: marketOf(String(s.NEWTEXCH ?? "")),
      weight_pct: num(s.JZBL),
      change: ["增持", "减持", "不变", "新进"].includes(s.PCTNVCHGTYPE) ? s.PCTNVCHGTYPE : null,
    }))
    .filter((r) => r.code && r.weight_pct != null)
    .sort((a, b) => b.weight_pct - a.weight_pct);
  let disclosure_date = null;
  try {
    const d = (await basicRes?.json())?.Datas;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(d?.FEGMRQ ?? ""))) disclosure_date = d.FEGMRQ;
  } catch { /* optional */ }
  return { rows, disclosure_date };
}

export async function fetchFundTopHoldings(fundCode) {
  // latest disclosed top-10 A-share holdings: [{code:"sz002821", name, weightPct}]
  const res = await get(
    `https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition?FCODE=${fundCode}&${FUND_QS}`,
  );
  const json = await res.json();
  const stocks = json?.Datas?.fundStocks ?? [];
  const out = [];
  for (const s of stocks.slice(0, 10)) {
    const code = String(s.GPDM ?? "").trim();
    const t = String(s.NEWTEXCH ?? "");
    const prefix = t === "1" ? "sh" : t === "0" ? "sz" : null; // HK-connect / BJ skipped
    const w = Number(s.JZBL);
    if (code.length === 6 && prefix && Number.isFinite(w) && w > 0) {
      out.push({ code: prefix + code, name: s.GPJC ?? null, weightPct: w });
    }
  }
  return out;
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
  // codes: normalized list (+ optional overseas index codes like usNDX).
  // Returns { [code]: {name, price, prevClose, pct, quoteTime} }
  const out = {};
  const exch = codes.filter(isExchangeCode);
  const funds = codes.filter(isFundCode);
  const overseas = codes.filter((c) => OVERSEAS_CODE_RE.test(c));
  const gold = codes.includes(GOLD_CODE);
  const jobs = [];
  if (overseas.length) {
    jobs.push(
      Promise.all(
        overseas.map(async (code) => {
          try { out[code] = await fetchOverseasIndex(code); } catch { /* per-code failure tolerated */ }
        }),
      ),
    );
  }
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
