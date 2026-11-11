'use strict';
/*
 * 问金寻银 · 纯逻辑层（不碰界面，可在 Node 里测试）。
 * 每个粒子都对应一只真实股票：这里负责解析行情、校验、算涨跌分布、把股票摆到星云上。
 * 完整报价的字段位置（实测校准）：43 是振幅、44 流通市值、45 总市值、46 市净率。
 *
 * Wenjin Xunyin · pure logic layer (no DOM; can be tested in Node).
 * Every particle is a real stock: this module parses and validates quotes, computes the up/down distribution and lays stocks out on the nebula.
 * Full-quote field positions (verified against live data): 43 amplitude, 44 float market cap, 45 total market cap, 46 P/B.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NebulaCore = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const LINE = /v_([a-z]{2}[A-Za-z0-9.]+)="([^"]*)"/g;
  const SIMPLE = /v_s_([a-z]{2}[A-Za-z0-9.]+)="([^"]*)"/g;
  const SHANGHAI_MS = 8 * 3600 * 1000;

  const num = v => { const n = Number(v); return v === '' || v === undefined || !Number.isFinite(n) ? null : n; };
  const pos = v => { const n = num(v); return n !== null && n > 0 ? n : null; };
  const marketOf = code => (code.startsWith('hk') ? 'HK' : code.startsWith('us') ? 'US' : 'CN');
  /**
   * 股息率超过 30% 是特别派息或股价暴跌造成的（亨得利 369%），不能当真实回报水平，算没有数据。
   * A dividend yield above 30% comes from a special payout or a price crash (one stock showed 369%); it is not a real yield, so treat it as missing.
   */
  const dividendOf = v => { const d = num(v); return d !== null && d >= 0 && d <= 30 ? d : null; };

  /**
   * 纽约和 UTC 差几小时：夏令时（3 月第二个周日到 11 月第一个周日）-4，其余 -5。这条规则从 2007 年起没变过。
   * Hours between New York and UTC: -4 during DST (second Sunday of March to first Sunday of November), otherwise -5. Unchanged since 2007.
   */
  function newYorkOffset(ms) {
    const y = new Date(ms).getUTCFullYear();
    const sunday = (month, nth) => 1 + ((7 - new Date(Date.UTC(y, month, 1)).getUTCDay()) % 7) + (nth - 1) * 7;
    const start = Date.UTC(y, 2, sunday(2, 2), 7), end = Date.UTC(y, 10, sunday(10, 1), 6);
    return ms >= start && ms < end ? -4 : -5;
  }

  /**
   * 行情时间戳 → 毫秒。A 股 20261103150002，港股 2026/11/03 16:08:29，都是北京时间；美股 2026-11-03 16:00:02，是纽约时间。
   * Quote timestamp → milliseconds. A-share 20261103150002 and HK 2026/11/03 16:08:29 are Beijing time; US 2026-11-03 16:00:02 is New York time.
   */
  function parseStamp(raw) {
    const s = String(raw || '').trim();
    const us = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (us) {
      const local = Date.UTC(+us[1], +us[2] - 1, +us[3], +us[4], +us[5], +us[6]);
      return local - newYorkOffset(local + 5 * 3600000) * 3600000;
    }
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s) || /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
    if (!m) return 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - SHANGHAI_MS;
  }

  /**
   * 约一半美股没有中文名，报价里是英文全称：去掉公司类型和股份类别，列表里放得下。中文名不动。
   * About half of US stocks have no Chinese name and come with the full English name: strip the company type and share class so it fits in lists. Chinese names are left as is.
   */
  function shortName(raw) {
    const name = String(raw || '').trim();
    if (/[^\x00-\x7f]/.test(name)) return name;
    const twice = /^(.{6,}?)\s+\1$/.exec(name);
    let s = (twice ? twice[1] : name).replace(/\s+(-\s|Class [A-Z]\b|Common\b|Ordinary\b|Subordinate\b|Trading Under\b|American Depositary\b|Series [A-Z]\b).*$/i, '');
    for (let k = 0; k < 3; k++) s = s.replace(/[,\s]+(Inc|Incorporated|Corporation|Corp|Company|Co|Limited|Ltd|PLC|LLC|L\.?P|N\.?V|S\.?A|SE|AG|Holdings?|Group)\.?$/i, '');
    return s.trim().replace(/,+$/, '') || name;
  }

  /**
   * 美股一条完整报价（2026-11-04 核对字段）：盘中没有盘口，没有涨跌停，成交额是美元，最少 1 股。
   * One full US quote (fields checked 2026-11-04): no order book during the session, no price limits, turnover in USD, minimum 1 share.
   */
  function parseUsFields(code, f) {
    const price = pos(f[3]), prev = pos(f[4]);
    if (!price || !prev || f.length < 57) return null;
    const levels = from => [[num(f[from]) || 0, num(f[from + 1]) || 0], [0, 0], [0, 0], [0, 0], [0, 0]];
    const floatShares = pos(f[63]);
    return {
      code, name: shortName(String(f[1] || '').trim() || f[46]), market: 'US', price, prev,
      open: pos(f[5]) || price, vol: num(f[6]) || 0,
      bids: levels(9), asks: levels(19),
      at: parseStamp(f[30]),
      high: pos(f[33]) || price, low: pos(f[34]) || price,
      amount: num(f[37]) || 0,
      pe: num(f[39]),
      limitUp: null, limitDown: null,
      volRatio: pos(f[64]),
      // 第 38 项是成交量 / 总股本，A 股、港股的换手率都按流通股算，这里统一（2026-11-05 核对：第 63 项是流通股）
      turnover: floatShares ? (num(f[6]) || 0) / floatShares * 100 : num(f[38]),
      capYi: pos(f[45]),
      floatCapYi: pos(f[44]),
      pb: pos(f[51]),
      dividend: dividendOf(f[52]),
      lot: 1,
      type: String(f[56] || ''),
    };
  }

  /**
   * 一条完整格式报价。无效（没有价格或昨收）返回 null。
   * One full-format quote. Returns null when invalid (no price or previous close).
   */
  function parseFullFields(code, f) {
    const hk = code.startsWith('hk');
    const price = pos(f[3]), prev = pos(f[4]);
    let q;
    if (code.startsWith('us')) {
      q = parseUsFields(code, f);
      if (!q) return null;
    } else {
    if (!price || !prev || f.length < (hk ? 64 : 50)) return null;
    const levels = from => [0, 1, 2, 3, 4].map(i => [num(f[from + i * 2]) || 0, num(f[from + 1 + i * 2]) || 0]);
    q = {
      code, name: String(f[1] || '').trim(), market: marketOf(code), price, prev,
      open: pos(f[5]) || price, vol: num(f[6]) || 0,
      bids: levels(9), asks: levels(19),
      at: parseStamp(f[30]),
      high: pos(f[33]) || price, low: pos(f[34]) || price,
      amount: hk ? (num(f[37]) || 0) : (num(f[37]) || 0) * 10000,
      pe: num(f[39]),
      limitUp: hk ? null : pos(f[47]), limitDown: hk ? null : pos(f[48]),
      volRatio: hk ? pos(f[50]) : pos(f[49]),
      turnover: hk ? num(f[59]) : num(f[38]),
      // 港股第 44 项是 H 股市值，第 45 项才是总市值：A+H 公司差很多（2026-11-05 核对：美的集团 641 亿和 7527 亿）
      capYi: pos(f[45]) || pos(f[44]),
      floatCapYi: pos(f[44]),
      pb: hk ? pos(f[58]) : pos(f[46]),
      dividend: dividendOf(hk ? f[47] : f[64]),
      lot: hk ? (pos(f[60]) || 100) : 100,
      type: hk ? String(f[63] || '') : String(f[61] || ''),
    };
    }
    q.pct = (price / prev - 1) * 100;
    // 僵尸报价：成交额为 0 且现价等于昨收（停牌、未开盘或废码），照样 HTTP 200，不能当真实成交用
    q.stale = q.amount === 0 && price === prev;
    return q;
  }

  /**
   * 解析一段完整格式行情文本。返回 { quotes: {code: q}, rejected: n }。
   * Parse a block of full-format quote text. Returns { quotes: {code: q}, rejected: n }.
   */
  function parseFull(text) {
    const quotes = {};
    let rejected = 0;
    LINE.lastIndex = 0;
    let m;
    while ((m = LINE.exec(text))) {
      if (m[1].startsWith('s_') || m[1].startsWith('pv_')) continue;
      const q = parseFullFields(m[1], m[2].split('~'));
      if (!q || !sane(q)) { rejected++; continue; }
      quotes[q.code] = q;
    }
    return { quotes, rejected };
  }

  /**
   * 清洗校验：高低价矛盾、价格跑出涨跌停 1% 以外的记录不算有效行情。
   * Sanity checks: records whose high and low contradict each other, or whose price is more than 1% outside the limit band, are not valid quotes.
   */
  function sane(q) {
    if (q.high < q.low) return false;
    if (!q.stale && (q.price > q.high * 1.001 || q.price < q.low * 0.999)) return false;
    if (q.limitUp && q.limitDown && (q.price > q.limitUp * 1.01 || q.price < q.limitDown * 0.99)) return false;
    return true;
  }

  /**
   * 简版报价（s_ 前缀）：现价、涨跌、成交量、成交额、市值。全市场一轮只要约 184 KB。
   * Short quote (s_ prefix): price, change, volume, turnover, market cap. A full-market round is only about 184 KB.
   */
  function parseSimple(text) {
    const ticks = {};
    SIMPLE.lastIndex = 0;
    let m;
    while ((m = SIMPLE.exec(text))) {
      const f = m[2].split('~');
      const price = pos(f[3]);
      if (!price) continue;
      // 市值：A 股、港股在第 9 项，美股在第 8 项
      ticks[m[1]] = { code: m[1], name: String(f[1] || '').trim(), price, change: num(f[4]) || 0, vol: num(f[6]) || 0, amountRaw: num(f[7]), capYi: pos(f[9]) || pos(f[8]) };
    }
    return ticks;
  }

  /**
   * 用简版报价更新完整报价：最高最低随看到的价格扩展，估值按价格比例换算，股息率反比。
   * 昨收变了说明进入了新交易日，从这一刻重新计开高低；只有这时才把报价时间改成现在（开盘前拿到的还是上一日收盘）。
   * Update a full quote from a short quote: high/low expand with the prices seen, valuations scale with price, dividend yield inversely.
   * A changed previous close means a new trading day: restart open/high/low from now, and only then move the quote time to now (before the open we still hold the previous close).
   */
  function mergeTick(old, t, now) {
    const prev = t.price - t.change;
    const fresh = prev > 0 && Math.abs(prev - old.prev) > old.prev * 0.0005;
    const ratio = t.price / old.price;
    const q = Object.assign({}, old, {
      price: t.price, prev: fresh ? prev : old.prev,
      open: fresh ? t.price : old.open,
      high: fresh ? t.price : Math.max(old.high, t.price),
      low: fresh ? t.price : Math.min(old.low, t.price),
      vol: t.vol,
      amount: t.amountRaw === null ? old.amount : (old.market === 'CN' ? t.amountRaw * 10000 : t.amountRaw),
      pe: old.pe === null ? null : old.pe * ratio, pb: old.pb === null ? null : old.pb * ratio,
      capYi: t.capYi || (old.capYi && old.capYi * ratio),
      dividend: old.dividend === null ? null : old.dividend / ratio,
      limitUp: fresh ? null : old.limitUp, limitDown: fresh ? null : old.limitDown,
      at: fresh ? now : old.at,
      bids: old.bids, asks: old.asks,
    });
    q.pct = (q.price / q.prev - 1) * 100;
    q.stale = q.amount === 0 && q.price === q.prev;
    return q;
  }

  // ---------------------------------------------------------------- 交易时段 / Trading sessions

  /**
   * 北京时间的 分钟数 / 星期。港股、A 股都按北京时间判断，节假日以行情时间是否在走为准。
   * Minutes and weekday in Beijing time. HK and A-shares are judged in Beijing time; holidays are detected by whether quote times keep moving.
   */
  function beijing(now) {
    const d = new Date(now + SHANGHAI_MS);
    return { minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay(), day: d.toISOString().slice(0, 10) };
  }
  /**
   * 纽约当地时间的 分钟数 / 星期 / 日期。美股的一个交易日在北京时间跨两天，日期和时段都要按纽约算。
   * Minutes / weekday / date in New York local time. A US trading day spans two Beijing dates, so both date and session follow New York.
   */
  function newYork(now) {
    const d = new Date(now + newYorkOffset(now) * 3600000);
    return { minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay(), day: d.toISOString().slice(0, 10) };
  }
  /**
   * 这个时刻属于这个市场的哪一天（YYYY-MM-DD）。
   * Which day (YYYY-MM-DD) this moment belongs to in this market.
   */
  function marketDay(market, at) { return (market === 'US' ? newYork(at) : beijing(at)).day; }
  function sessionOpen(market, now) {
    if (market === 'US') {
      const ny = newYork(now);
      return ny.weekday !== 0 && ny.weekday !== 6 && ny.minute >= 570 && ny.minute < 960;
    }
    const t = beijing(now);
    if (t.weekday === 0 || t.weekday === 6) return false;
    if (market === 'HK') return (t.minute >= 570 && t.minute < 720) || (t.minute >= 780 && t.minute < 970);
    return (t.minute >= 570 && t.minute < 690) || (t.minute >= 780 && t.minute < 900);
  }

  /**
   * 现在真的在交易吗：时钟在交易时段，并且这个市场的参考报价（指数）时间没有停住。
   * 节假日时钟也在交易时段，但报价时间还停在上一个交易日，这样不用维护休市表，每年也不会过期。还没取到参考报价时只看时钟。
   * Is the market really trading: the clock is within the session and the market's reference quote (index) time is still moving.
   * On holidays the clock is in session but the quote time stays on the last trading day, so no holiday calendar is needed and nothing expires. Before any reference quote arrives, only the clock is used.
   */
  function sessionLive(market, now, refAt) {
    if (!sessionOpen(market, now)) return false;
    return !(refAt && now - refAt > 20 * 60000);
  }

  // ---------------------------------------------------------------- 涨跌分布 / Up/down distribution

  /**
   * 这只股票的涨跌停幅度（%）。港股、美股没有涨跌停，返回 null。主板 ST、S 开头的是 5%。
   * Daily price-limit range (%) of this stock. HK and US have none and return null. Main-board ST / S names are 5%.
   */
  function limitOf(code, name) {
    if (code.startsWith('hk') || code.startsWith('us')) return null;
    if (/^(sh68[89]|sz30[012])/.test(code)) return 20;
    if (code.startsWith('bj')) return 30;
    return name && /^\*?S/.test(name) ? 5 : 10;
  }

  /**
   * 涨跌停价：按交易所规则从昨收算，四舍五入到分（2026-11-05 全市场和接口给的涨跌停价逐只比过）。
   * 没有涨跌停的返回 null：港股、美股，以及新股（名字 N、C 开头，上市前 5 天不设涨跌幅）。
   * Limit-up / limit-down prices from the previous close by exchange rules, rounded to the cent (checked stock by stock across the whole market on 2026-11-05).
   * Returns null when there is no limit: HK, US, and new listings (names starting with N or C, no limit for the first 5 days).
   */
  function limitPrices(code, name, prev) {
    const pct = limitOf(code, name);
    if (!pct || !(prev > 0) || (name && /^[NC](?![A-Za-z])/.test(name))) return null;
    const cents = v => Math.round(v * 100 + 1e-6) / 100;
    return { up: cents(prev * (1 + pct / 100)), down: cents(prev * (1 - pct / 100)) };
  }

  /**
   * 全市场涨跌统计。bins：-10% 到 +10%，每 1% 一格（两端含更大涨跌）。
   * hits：和 pcts 等长，+1 涨停、-1 跌停，由现价和涨跌停价比出来，这是准的。
   * 回放只有涨跌幅、没有价格，才用 limits（涨跌停幅度）估算：分价取整会让封板涨幅略低于幅度，留 0.15 个点，会多算几只。
   * Full-market up/down statistics. bins: -10% to +10% in 1% steps (both ends include larger moves).
   * hits: same length as pcts, +1 limit-up, -1 limit-down, from price vs. limit price; this is exact.
   * Replay has only percentage changes, no prices, so it estimates with limits (limit ranges): price rounding leaves a limit-up move slightly under the range, so allow 0.15 points; a few extra may be counted.
   */
  function breadth(pcts, limits, hits) {
    const bins = new Array(21).fill(0);
    let up = 0, down = 0, flat = 0, sum = 0, n = 0, limitUp = 0, limitDown = 0;
    for (let i = 0; i < pcts.length; i++) {
      const p = pcts[i];
      if (p === null || p === undefined || Number.isNaN(p)) continue;
      n++; sum += p;
      if (p > 0.0001) up++; else if (p < -0.0001) down++; else flat++;
      const limit = limits ? limits[i] : null;
      if (hits) {
        if (hits[i] > 0) limitUp++; else if (hits[i] < 0) limitDown++;
      } else if (limit) {
        if (p >= limit - 0.15) limitUp++;
        if (p <= -limit + 0.15) limitDown++;
      }
      bins[Math.max(0, Math.min(20, Math.round(p) + 10))]++;
    }
    const tilt = up + down > 0 ? (up - down) / (up + down) : 0;
    return { up, down, flat, n, limitUp, limitDown, mean: n ? sum / n : 0, tilt, bins };
  }

  /**
   * 多空势能（朗道双势阱）：V(x)=x⁴/4−x²/2−h·x，h 是涨跌家数的偏斜。返回势能最低点。
   * Bull/bear potential (Landau double well): V(x)=x⁴/4−x²/2−h·x, where h is the up/down skew. Returns the potential minimum.
   */
  function wellMinimum(h) {
    let x = h >= 0 ? 1 : -1;
    for (let i = 0; i < 40; i++) {
      const g = x * x * x - x - h, d = 3 * x * x - 1;
      if (Math.abs(d) < 1e-6) break;
      x -= g / d;
    }
    return x;
  }

  /**
   * 秩相关（Spearman）：横截面 IC。两个等长数组，null 跳过。至少 30 对才算。
   * Rank correlation (Spearman): cross-sectional IC. Two equal-length arrays, nulls skipped. Needs at least 30 pairs.
   */
  function rankIC(a, b) {
    const pairs = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null && Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]]);
    const n = pairs.length;
    if (n < 30) return null;
    const rank = key => {
      const order = pairs.map((p, i) => [p[key], i]).sort((x, y) => x[0] - y[0]);
      const r = new Float64Array(n);
      for (let i = 0; i < n;) {
        let j = i;
        while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
        for (let k = i; k <= j; k++) r[order[k][1]] = (i + j) / 2;
        i = j + 1;
      }
      return r;
    };
    const ra = rank(0), rb = rank(1);
    let sa = 0, sb = 0, sab = 0;
    const m = (n - 1) / 2;
    for (let i = 0; i < n; i++) { sa += (ra[i] - m) ** 2; sb += (rb[i] - m) ** 2; sab += (ra[i] - m) * (rb[i] - m); }
    return sa && sb ? sab / Math.sqrt(sa * sb) : null;
  }

  /**
   * 一个交易日的横截面 Rank IC：当天能算出的因子值，和之后 horizon 天的累计收益做秩相关。
   * matrix：逐日涨跌矩阵（行 = 股票，列 = 交易日，万分比，缺失 -32768）。
   * 因子：reversal5（近 5 日反转，取负号）、momentum20（近 20 日动量）、vol20（近 20 日波动率）。样本不足返回 null。
   * Cross-sectional Rank IC for one trading day: rank-correlate the factor values known that day with the cumulative return over the next horizon days.
   * matrix: daily change matrix (rows = stocks, columns = trading days, in basis points, missing = -32768).
   * Factors: reversal5 (5-day reversal, negated), momentum20 (20-day momentum), vol20 (20-day volatility). Returns null when the sample is too small.
   */
  function factorICDay(matrix, rows, cols, day, horizon = 5) {
    if (day < 20 || day + horizon >= cols) return null;
    const reversal = new Array(rows), momentum = new Array(rows), vol = new Array(rows), forward = new Array(rows);
    for (let r = 0; r < rows; r++) {
      const at = r * cols;
      let m = 1, v = 1, s = 0, ss = 0, n = 0;
      for (let k = day - 19; k <= day; k++) {
        const raw = matrix[at + k];
        if (raw === -32768) continue;
        const x = raw / 10000;
        m *= 1 + x; s += x; ss += x * x; n++;
        if (k > day - 5) v *= 1 + x;
      }
      let f = 1, fn = 0;
      for (let k = day + 1; k <= day + horizon; k++) {
        const raw = matrix[at + k];
        if (raw === -32768) continue;
        f *= 1 + raw / 10000; fn++;
      }
      const usable = n >= 15 && fn === horizon;
      reversal[r] = usable ? 1 - v : null;
      momentum[r] = usable ? m - 1 : null;
      vol[r] = usable ? Math.sqrt(Math.max(0, ss / n - (s / n) ** 2)) : null;
      forward[r] = usable ? f - 1 : null;
    }
    return { reversal5: rankIC(reversal, forward), momentum20: rankIC(momentum, forward), vol20: rankIC(vol, forward) };
  }

  /**
   * 一串 IC 的均值、标准差、ICIR、IC 为正的比例。
   * Mean, standard deviation, ICIR and share of positive values for a series of ICs.
   */
  function icSummary(series) {
    const xs = series.filter(x => x !== null && Number.isFinite(x));
    if (xs.length < 5) return null;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const std = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
    return { n: xs.length, mean, std, icir: std > 0 ? mean / std : 0, positive: xs.filter(x => x > 0).length / xs.length };
  }

  // ---------------------------------------------------------------- 星云布局 / Nebula layout

  function hash32(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const K = 3.7;
  /**
   * 螺旋二十四面体（gyroid）：多孔球壳。投影到它的零等值面上，就有了天然的孔洞。
   * Gyroid: a porous spherical shell. Projecting onto its zero level set gives natural holes.
   */
  function gyroid(x, y, z) { return Math.sin(K * x) * Math.cos(K * y) + Math.sin(K * y) * Math.cos(K * z) + Math.sin(K * z) * Math.cos(K * x); }
  function gyroidGrad(x, y, z) {
    return [K * (Math.cos(K * x) * Math.cos(K * y) - Math.sin(K * z) * Math.sin(K * x)),
      K * (Math.cos(K * y) * Math.cos(K * z) - Math.sin(K * x) * Math.sin(K * y)),
      K * (Math.cos(K * z) * Math.cos(K * x) - Math.sin(K * y) * Math.sin(K * z))];
  }
  function toSurface(p) {
    for (let i = 0; i < 4; i++) {
      const f = gyroid(p[0], p[1], p[2]), g = gyroidGrad(p[0], p[1], p[2]);
      const n = g[0] * g[0] + g[1] * g[1] + g[2] * g[2] || 1;
      p[0] -= f * g[0] / n; p[1] -= f * g[1] / n; p[2] -= f * g[2] / n;
    }
    return p;
  }

  /**
   * 把股票摆到星云上：同行业聚在一起（方向由行业决定），再贴到多孔壳面上。位置由代码决定，每次打开都一样。
   * stocks: [{code, industry}]。返回 Float32Array(n*3)，半径约 0.55–1.05（中间留给核心）。
   * Place stocks on the nebula: same-industry stocks cluster (direction set by industry), then snap onto the porous shell. Positions depend only on the codes, so they are the same every time.
   * stocks: [{code, industry}]. Returns Float32Array(n*3), radius about 0.55–1.05 (the center is left for the core).
   */
  function layoutStocks(stocks) {
    const groups = new Map();
    stocks.forEach((s, i) => {
      const key = s.industry || (s.code.startsWith('hk') ? '港股·未分类' : s.code.startsWith('us') ? '美股·未分类' : 'A股·未分类');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(i);
    });
    const names = [...groups.keys()].sort((a, b) => groups.get(b).length - groups.get(a).length);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const centers = new Map();
    names.forEach((name, i) => {
      const y = 1 - (i + 0.5) / names.length * 2, r = Math.sqrt(1 - y * y), t = golden * i;
      centers.set(name, [Math.cos(t) * r, y, Math.sin(t) * r]);
    });
    const out = new Float32Array(stocks.length * 3);
    names.forEach(name => {
      const center = centers.get(name), members = groups.get(name);
      const spread = 0.16 + 0.34 * Math.sqrt(members.length / stocks.length);
      for (const idx of members) {
        const random = rng(hash32(stocks[idx].code));
        const u = random(), v = random(), w = random();
        const gauss = () => Math.sqrt(-2 * Math.log(1 - random() * 0.999)) * Math.cos(2 * Math.PI * random());
        const d = [center[0] + gauss() * spread, center[1] + gauss() * spread, center[2] + gauss() * spread];
        const len = Math.hypot(d[0], d[1], d[2]) || 1;
        const radius = 0.62 + 0.42 * Math.pow(u, 0.6);
        const p = toSurface([d[0] / len * radius, d[1] / len * radius, d[2] / len * radius]);
        const r = Math.hypot(p[0], p[1], p[2]) || 1;
        const clamped = Math.max(0.5, Math.min(1.06, r));
        const thick = (v - 0.5) * 0.028, jitter = (w - 0.5) * 0.02;
        out[idx * 3] = p[0] / r * clamped + thick;
        out[idx * 3 + 1] = p[1] / r * clamped + jitter;
        out[idx * 3 + 2] = p[2] / r * clamped - thick;
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- 颜色和格式 / Colors and formatting

  /**
   * 涨跌幅 → 颜色（中国习惯：涨红跌绿）。小幅用暖金和青绿，幅度越大越饱和；平盘是银灰。
   * Change → color (Chinese convention: red up, green down). Small moves are warm gold / teal, larger moves more saturated; unchanged is silver-gray.
   */
  function changeColor(pct) {
    if (pct === null || pct === undefined || Number.isNaN(pct)) return [0.28, 0.30, 0.34];
    const a = Math.min(1, Math.abs(pct) / 7);
    const mix = (x, y, t) => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
    if (Math.abs(pct) < 0.05) return [0.62, 0.66, 0.72];
    if (pct > 0) return a < 0.35 ? mix([0.98, 0.78, 0.36], [1.0, 0.56, 0.20], a / 0.35) : mix([1.0, 0.56, 0.20], [1.0, 0.16, 0.20], (a - 0.35) / 0.65);
    return a < 0.35 ? mix([0.40, 0.72, 0.95], [0.16, 0.82, 0.72], a / 0.35) : mix([0.16, 0.82, 0.72], [0.08, 0.86, 0.40], (a - 0.35) / 0.65);
  }

  const fixed = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const signed = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d));
  /**
   * 金额（元）→ 亿 / 万。
   * Amount (yuan) → 亿 (1e8) / 万 (1e4).
   */
  function money(v) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e12) return (v / 1e12).toFixed(2) + ' 万亿';
    if (a >= 1e8) return (v / 1e8).toFixed(a >= 1e10 ? 0 : 1) + ' 亿';
    if (a >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return v.toFixed(0);
  }
  const clock = ms => { const d = new Date(ms + SHANGHAI_MS); return d.toISOString().slice(11, 19); };

  return { parseFull, parseSimple, parseFullFields, parseStamp, shortName, sane, mergeTick, beijing, newYork, marketDay, sessionOpen, sessionLive, limitOf, limitPrices, breadth, wellMinimum, rankIC,
    factorICDay, icSummary, hash32, rng, gyroid, toSurface, layoutStocks, changeColor, fixed, signed, money, clock, marketOf };
}));
