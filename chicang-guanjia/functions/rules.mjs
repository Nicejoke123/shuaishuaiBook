// Rule engine: five rule groups (G global / S stock / F OTC fund / E exchange ETF / GD gold).
// Pure functions; the handler supplies data. Every advice carries rule id + numbers so the
// UI can show exactly why it fired. Amounts in CNY, percentages as plain numbers.

export const DEFAULT_THRESHOLDS = {
  G1: { devPP: 5 },
  G2: { maxSinglePct: 25 },
  S1: { stopLossPct: -10 },
  S2: { takeProfitPct: 20, sellFraction: 1 / 3 },
  S3: { ladder: [20, 40, 60], sellFraction: 1 / 3 },
  S4: { drawdownPct: 8 },
  S5: { maDays: 20 },
  F1: { ladder: [-10, -20, -30] },
  F2: { takeProfitPct: 15, sellFraction: 1 / 3 },
  F3: { drawdownPct: 8 },
  F5: { underperfPP: 5, days: 60 },
  E1: { bands: 5 },
  E2: { takeProfitPct: 20, sellFraction: 1 / 3 },
  E3: { drawdownPct: 10 },
  GD1: { devPP: 5 },
  GD2: { aboveMaPct: 5, maDays: 20 },
  GD3: { belowMaPct: -5, maDays: 20, tranches: 3 },
  GD4: { dayMovePct: 3 },
  GD5: { quietDays: 20, maDays: 20, belowMaPct: -5 },
};

const fmt = (n, d = 2) => String(Number(Number(n).toFixed(d)));
const round2 = (n) => Math.round(n * 100) / 100;

function movingAverage(closes, days) {
  if (closes.length < days) return null;
  const win = closes.slice(-days);
  return win.reduce((a, b) => a + b, 0) / days;
}

function maSlopeDown(closes, days) {
  if (closes.length < days + 5) return null;
  const now = movingAverage(closes, days);
  const before = movingAverage(closes.slice(0, -5), days);
  return now != null && before != null ? now < before : null;
}

// thresholds: DEFAULTS <- settings.global[rule] <- position.overrides[rule]
export function thresholdsFor(ruleId, settings = {}, overrides = {}) {
  return {
    ...DEFAULT_THRESHOLDS[ruleId],
    ...(settings.global?.[ruleId] ?? {}),
    ...(overrides[ruleId] ?? {}),
  };
}

/**
 * evaluatePosition(ctx) -> advice[]
 * ctx: { position, quote, history (ascending [{date, close}], snapshots+kline merged),
 *        totalValue, settings, today, indexCloses (60d, oldest first, may be null) }
 * position.quantity / costPrice are numbers; history closes filtered to >= opened window handled inside.
 */
export function evaluatePosition(ctx) {
  const { position, quote, history = [], totalValue, settings, indexCloses } = ctx;
  const advices = [];
  if (!quote || !quote.price || !position.costPrice) return advices;

  const price = quote.price;
  const mv = price * position.quantity;
  if (mv <= 0 || totalValue <= 0) return advices;

  const cost = position.costPrice;
  const pnlPct = (price / cost - 1) * 100;
  const sharePct = (mv / totalValue) * 100;
  const overrides = position.overrides ?? {};
  const t = (id) => thresholdsFor(id, settings, overrides);

  // History relevant to holding period (for peak / drawdown since open)
  const held = position.openedDate
    ? history.filter((h) => h.date >= position.openedDate)
    : history;
  const heldCloses = held.map((h) => h.close);
  const peakSinceOpen = heldCloses.length
    ? Math.max(...heldCloses, price)
    : Math.max(cost, price);
  const peakReturnPct = (peakSinceOpen / cost - 1) * 100;
  const ddFromPeak = price < peakSinceOpen ? ((price - peakSinceOpen) / peakSinceOpen) * 100 : 0;

  const closes = history.map((h) => h.close);
  const recent60 = closes.slice(-60);
  const push = (a) => advices.push(a);
  const base = {
    code: position.code,
    name: position.name,
    asset_type: position.asset_type,
  };
  const money = (frac) => round2(mv * frac);

  // ---------- G2 single-position concentration (all types) ----------
  {
    const { maxSinglePct } = t("G2");
    if (sharePct >= maxSinglePct) {
      const trimTo = mv - (totalValue * maxSinglePct) / 100 * 0.95;
      push({
        ...base, rule_id: "G2", action: "sell", severity: "mid",
        reason: `${position.name} 市值占总资产 ${fmt(sharePct, 1)}%，超过集中度上限 ${fmt(maxSinglePct, 0)}%`,
        detail: { sharePct: round2(sharePct), refAmount: round2(Math.max(0, trimTo)) },
      });
    }
  }

  // ---------- type-specific trading rules ----------
  if (position.asset_type === "stock") {
    const { stopLossPct } = t("S1");
    if (pnlPct <= stopLossPct) {
      push({
        ...base, rule_id: "S1", action: "sell", severity: "high",
        reason: `浮亏 ${fmt(pnlPct, 1)}%，触及止损线 ${fmt(stopLossPct, 0)}%（成本 ${fmt(cost)} → 现价 ${fmt(price)}）。建议复核买入逻辑，考虑减仓或离场`,
        detail: { pnlPct: round2(pnlPct), refAmount: money(0.5) },
      });
    }
    const { takeProfitPct, sellFraction } = t("S2");
    const { ladder } = t("S3");
    if (pnlPct >= takeProfitPct) {
      const hitLevel = [...ladder].reverse().find((lv) => pnlPct >= lv);
      push({
        ...base, rule_id: pnlPct >= (ladder[1] ?? 1e9) ? "S3" : "S2", action: "sell", severity: "mid",
        reason: `浮盈 ${fmt(pnlPct, 1)}%，达到阶梯止盈第 ${ladder.indexOf(hitLevel) + 1} 档（+${fmt(hitLevel, 0)}%）。建议兑现约 ${fmt(sellFraction * 100, 0)}% 仓位锁定利润`,
        detail: { pnlPct: round2(pnlPct), level: hitLevel, refAmount: money(sellFraction) },
      });
    }
    const { drawdownPct } = t("S4");
    if (peakReturnPct > 0 && -ddFromPeak >= drawdownPct) {
      push({
        ...base, rule_id: "S4", action: "sell", severity: "mid",
        reason: `价格自持有期高点 ${fmt(peakSinceOpen)} 回撤 ${fmt(-ddFromPeak, 1)}%（≥${fmt(drawdownPct, 0)}% 回撤线）。趋势兑现信号，建议减仓锁定部分利润`,
        detail: { peak: peakSinceOpen, ddPct: round2(ddFromPeak), refAmount: money(1 / 3) },
      });
    }
  }

  if (position.asset_type === "fund") {
    const { takeProfitPct, sellFraction } = t("F2");
    if (pnlPct >= takeProfitPct) {
      push({
        ...base, rule_id: "F2", action: "sell", severity: "mid",
        reason: `浮盈 ${fmt(pnlPct, 1)}%，达到基金止盈线 +${fmt(takeProfitPct, 0)}%。建议分批赎回约 ${fmt(sellFraction * 100, 0)}%`,
        detail: { pnlPct: round2(pnlPct), refAmount: money(sellFraction) },
      });
    }
    const { drawdownPct } = t("F3");
    if (peakReturnPct > 0 && -ddFromPeak >= drawdownPct) {
      push({
        ...base, rule_id: "F3", action: "sell", severity: "mid",
        reason: `收益率自持有期最高 ${fmt(peakReturnPct, 1)}% 回撤 ${fmt(-ddFromPeak, 1)}%（≥${fmt(drawdownPct, 0)}% 回撤兑现线），建议考虑部分赎回锁定利润`,
        detail: { peakReturnPct: round2(peakReturnPct), ddPct: round2(ddFromPeak), refAmount: money(1 / 3) },
      });
    }
    const { ladder } = t("F1");
    const hi60 = recent60.length ? Math.max(...recent60) : null;
    if (hi60) {
      const dd = ((price - hi60) / hi60) * 100; // <= 0
      const hitLevel = [...ladder].reverse().find((lv) => dd <= lv);
      if (hitLevel != null) {
        const trancheAmt = overrides.F1?.trancheAmount ?? settings.global?.F1?.trancheAmount ?? 1000;
        const dcaNote = position.dca
          ? `；该基金已有${position.dca.freqLabel}定投 ¥${fmt(position.dca.amount, 0)}，也可将本档补仓并入提高定投额度`
          : "";
        push({
          ...base, rule_id: "F1", action: "buy", severity: "mid",
          reason: `净值较 60 日高点 ${fmt(hi60)} 回撤 ${fmt(-dd, 1)}%，进入补仓档（-${fmt(-hitLevel, 0)}%）。可按计划分档补仓，参考单笔 ¥${fmt(trancheAmt, 0)}${dcaNote}`,
          detail: { hi60, ddPct: round2(dd), level: hitLevel, refAmount: trancheAmt },
        });
      }
    }
    // F5 underperformance vs CSI300 (stand-in benchmark)
    const { underperfPP, days } = t("F5");
    if (indexCloses && indexCloses.length >= days && closes.length >= days) {
      const fundChg = ((price - closes[closes.length - days]) / closes[closes.length - days]) * 100;
      const idxChg = ((indexCloses[indexCloses.length - 1] - indexCloses[indexCloses.length - days])
        / indexCloses[indexCloses.length - days]) * 100;
      if (fundChg - idxChg <= -underperfPP) {
        push({
          ...base, rule_id: "F5", action: "watch", severity: "info",
          reason: `近 ${days} 日收益 ${fmt(fundChg, 1)}%，跑输沪深300 ${fmt(idxChg - fundChg, 1)} 个百分点（阈值 ${fmt(underperfPP, 0)}pp）。基金不设硬止损，但持续落后值得考虑转换`,
          detail: { fundChg: round2(fundChg), idxChg: round2(idxChg) },
        });
      }
    }
  }

  if (position.asset_type === "etf") {
    const { takeProfitPct, sellFraction } = t("E2");
    if (pnlPct >= takeProfitPct) {
      push({
        ...base, rule_id: "E2", action: "sell", severity: "mid",
        reason: `浮盈 ${fmt(pnlPct, 1)}%，达到 ETF 止盈线 +${fmt(takeProfitPct, 0)}%，建议分批卖出约 ${fmt(sellFraction * 100, 0)}%`,
        detail: { pnlPct: round2(pnlPct), refAmount: money(sellFraction) },
      });
    }
    const { drawdownPct } = t("E3");
    if (peakReturnPct > 0 && -ddFromPeak >= drawdownPct) {
      push({
        ...base, rule_id: "E3", action: "sell", severity: "mid",
        reason: `价格自持有期高点 ${fmt(peakSinceOpen)} 回撤 ${fmt(-ddFromPeak, 1)}%（≥${fmt(drawdownPct, 0)}% 回撤线），建议减仓`,
        detail: { peak: peakSinceOpen, ddPct: round2(ddFromPeak), refAmount: money(1 / 3) },
      });
    }
    const { bands } = t("E1");
    const lo = recent60.length ? Math.min(...recent60) : null;
    const hi = recent60.length ? Math.max(...recent60) : null;
    if (lo && hi && hi > lo) {
      const step = (hi - lo) / bands;
      const bandIdx = Math.min(bands - 1, Math.max(0, Math.floor((price - lo) / step)));
      if (bandIdx === 0) {
        push({
          ...base, rule_id: "E1", action: "buy", severity: "mid",
          reason: `价格 ${fmt(price)} 处于 60 日区间 [${fmt(lo)}, ${fmt(hi)}] 第 1 档（网格下沿），按网格计划买入一档`,
          detail: { lo, hi, band: 1, bands, refAmount: money(1 / bands) },
        });
      } else if (bandIdx === bands - 1) {
        push({
          ...base, rule_id: "E1", action: "sell", severity: "mid",
          reason: `价格 ${fmt(price)} 处于 60 日区间 [${fmt(lo)}, ${fmt(hi)}] 第 ${bands} 档（网格上沿），按网格计划卖出一档`,
          detail: { lo, hi, band: bands, bands, refAmount: money(1 / bands) },
        });
      }
    }
  }

  if (position.asset_type === "gold") {
    const t1 = t("GD1");
    const target = overrides.GD1?.targetPct ?? settings.targetGoldPct ?? 12;
    if (Math.abs(sharePct - target) >= t1.devPP) {
      const dir = sharePct > target ? "sell" : "buy";
      const amt = round2(Math.abs((target / 100) * totalValue - mv));
      push({
        ...base, rule_id: "GD1", action: dir, severity: "mid",
        reason: `黄金占比 ${fmt(sharePct, 1)}%，偏离目标配置 ${fmt(target, 0)}% 达 ${fmt(Math.abs(sharePct - target), 1)}pp，建议${dir === "buy" ? "增持" : "分批兑现"}约 ¥${fmt(amt, 0)}`,
        detail: { sharePct: round2(sharePct), target, refAmount: amt },
      });
    }
    const ma20 = movingAverage(closes, t("GD2").maDays);
    if (ma20) {
      const dev = ((price - ma20) / ma20) * 100;
      if (dev >= t("GD2").aboveMaPct) {
        push({
          ...base, rule_id: "GD2", action: "watch", severity: "info",
          reason: `金价 ${fmt(price)} 高于 20 日均线 ${fmt(ma20)} 达 ${fmt(dev, 1)}%，处于超买区：不建议追高买入，已有仓位可继续持有`,
          detail: { ma20: round2(ma20), devPct: round2(dev) },
        });
      }
      if (dev <= t("GD3").belowMaPct) {
        const { tranches } = t("GD3");
        push({
          ...base, rule_id: "GD3", action: "buy", severity: "mid",
          reason: `金价 ${fmt(price)} 低于 20 日均线 ${fmt(ma20)} 达 ${fmt(-dev, 1)}%，进入分批配置区间：建议分 ${tranches} 批逢跌买入`,
          detail: { ma20: round2(ma20), devPct: round2(dev), refAmount: money(1 / tranches) },
        });
        // GD5: in accumulation zone but no top-up in the last 20 days
        const t5 = t("GD5");
        const lastBuy = ctx.lastBuyDate;
        const quiet = !lastBuy || daysBetween(lastBuy, ctx.today) >= t5.quietDays;
        if (quiet) {
          push({
            ...base, rule_id: "GD5", action: "buy", severity: "info",
            reason: `金价处于配置区间且已 ${lastBuy ? daysBetween(lastBuy, ctx.today) : "多"} 日未补仓，可临时提高积存金定投额度`,
            detail: { lastBuyDate: lastBuy ?? null },
          });
        }
      }
    } else if (history.length >= 5) {
      // still accumulating MA window; informational only
    }
    const t4 = t("GD4");
    if (quote.prevClose) {
      const dayPct = ((price - quote.prevClose) / quote.prevClose) * 100;
      if (Math.abs(dayPct) >= t4.dayMovePct) {
        push({
          ...base, rule_id: "GD4", action: "watch", severity: "high",
          reason: `金价单日${dayPct > 0 ? "大涨" : "大跌"} ${fmt(Math.abs(dayPct), 1)}%（阈值 ${fmt(t4.dayMovePct, 0)}%）。急变行情建议次日再决策，避免盘中情绪化操作`,
          detail: { dayPct: round2(dayPct) },
        });
      }
    }
  }

  // S5 trend context attached to stock advices (auxiliary, never standalone)
  if (position.asset_type === "stock" && advices.some((a) => a.rule_id.startsWith("S"))) {
    const { maDays } = t("S5");
    const ma = movingAverage(closes, maDays);
    if (ma) {
      const below = price < ma;
      const falling = maSlopeDown(closes, maDays);
      const trend = below && falling ? "20日均线下方且均线向下，趋势偏弱" :
        below ? "价格低于20日均线" : "20日均线上方，趋势偏强";
      for (const a of advices) if (a.rule_id.startsWith("S")) a.detail.trend = trend;
    }
  }

  return advices;
}

export function daysBetween(dateA, dateB) {
  const a = Date.parse(`${dateA}T00:00:00Z`);
  const b = Date.parse(`${dateB}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86400000);
}

/** G1: portfolio-level allocation drift, needs all evaluated positions with market values. */
export function evaluateAllocation(rows, settings, opts = {}) {
  // rows: [{asset_type, mv}], settings.targetAllocation: {stock:..,fund:..,etf:..,gold:..}
  const target = settings.targetAllocation;
  if (!target || !rows.length) return [];
  const total = rows.reduce((s, r) => s + r.mv, 0);
  if (total <= 0) return [];
  const { devPP } = thresholdsFor("G1", settings, {});
  const groups = {};
  for (const r of rows) groups[r.asset_type] = (groups[r.asset_type] ?? 0) + r.mv;
  const labels = { stock: "股票", fund: "场外基金", etf: "场内ETF", gold: "黄金" };
  const out = [];
  for (const [type, tgtPct] of Object.entries(target)) {
    const actual = ((groups[type] ?? 0) / total) * 100;
    if (Math.abs(actual - tgtPct) >= devPP) {
      const dir = actual > tgtPct ? "sell" : "buy";
      const dcaNote = dir === "buy" && type === "fund" && opts.fundHasDca
        ? "，或提高现有定投金额逐步消化" : "";
      out.push({
        code: "PORTFOLIO", name: labels[type] ?? type, asset_type: type,
        rule_id: "G1", action: dir, severity: "mid",
        reason: `${labels[type] ?? type}实际占比 ${fmt(actual, 1)}%，偏离目标 ${fmt(tgtPct, 0)}% 达 ${fmt(Math.abs(actual - tgtPct), 1)}pp，建议${dir === "buy" ? "增配" : "减配"}约 ¥${fmt(Math.abs((tgtPct / 100) * total - (groups[type] ?? 0)), 0)}${dcaNote}`,
        detail: { actualPct: round2(actual), targetPct: tgtPct },
      });
    }
  }
  return out;
}
