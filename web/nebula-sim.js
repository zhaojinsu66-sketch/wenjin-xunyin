'use strict';
/*
 * 问金寻银 · 模拟交易引擎（纯逻辑，可在 Node 里测试；金额一律用“分”做整数运算，不产生浮点误差）。
 * 只记本机账本，不连券商、不下真实订单。
 *
 * 规则：
 * - A 股：T+1；主板、创业板 100 股一手（卖出可一次卖完不足一手的零股）；科创板最少 200 股、之后按 1 股递增；
 *   佣金万 2.5（最低 5 元）；过户费十万分之一（双边）；印花税万分之五（只卖出收）。
 * - 港股：T+0；每手股数以行情为准；印花税 0.1%（双边）；交易费 0.00565% + 证监会征费 0.0027% + 会财局征费 0.00015% = 0.0085%；佣金万 3。
 * - 美股：T+0；最少 1 股；佣金约万 1（最低 1 美元）；卖出规费约十万分之三。费率各家券商不同，这里按常见水平估算。
 *   美股行情没有盘口（2026-11-04 开盘时核对，盘中买一卖一都是 0）：按最新价估算成交，单笔不超过当天成交量的 1%。
 * - 成交：按真实五档盘口逐档吃单（买吃卖盘、卖吃买盘），超过五档总量的部分不成交；
 *   开盘涨停（没有卖盘）买不进，开盘跌停（没有买盘）卖不出；停牌（僵尸报价）不成交。
 * - 收盘后的委托排到下一个交易日，按真实开盘价成交；午休时的委托等下午开市，按当时的五档盘口成交。
 *
 * 账户（version 2）：
 * - 每个市场一本账（人民币 / 港币 / 美元），有账号（CN0001 这样，重置一次序号加一）和开户时间。
 * - 成交记录最多留 3000 笔。每只股票的累计买入、卖出、费用和已实现盈亏记在它的持仓里，旧记录删掉了汇总也不变。
 * - 委托记录（已成交、部分成交、排队中、未成交、已撤单）最多留 2000 笔。股数不合规、可卖不够这类当场就提示的不算委托。
 * - 重置账户前先 archiveBook 整本存档，买卖记录还能查。
 *
 * Wenjin Xunyin · simulated trading engine (pure logic, testable in Node; all money is integer cents, so no floating-point error).
 * Keeps a local ledger only: no broker connection, no real orders.
 *
 * Rules:
 * - A-shares: T+1; main board and ChiNext trade in lots of 100 (odd lots may be sold in one go); STAR Market at least 200 shares, then in steps of 1;
 *   commission 0.025% (min 5 yuan); transfer fee 0.001% (both sides); stamp duty 0.05% (sell side only).
 * - Hong Kong: T+0; lot size from the quote; stamp duty 0.1% (both sides); trading fee 0.00565% + SFC levy 0.0027% + AFRC levy 0.00015% = 0.0085%; commission 0.03%.
 * - US: T+0; minimum 1 share; commission about 0.01% (min 1 USD); sell-side regulatory fee about 0.003%. Brokers differ; these are typical levels.
 *   US quotes carry no order book (checked at the open on 2026-11-04: bid and ask are 0 during the session), so fills use the last price, capped at 1% of the day's volume.
 * - Fills walk the real 5-level book (buys take asks, sells take bids); anything beyond the 5 levels is not filled;
 *   no buying when sealed limit-up at the open (no asks), no selling when sealed limit-down (no bids); suspended stocks (stale quotes) do not trade.
 * - Orders placed after the close queue to the next trading day and fill at the real open; orders during the lunch break wait for the afternoon and fill against the book then.
 *
 * Accounts (version 2):
 * - One book per market (CNY / HKD / USD) with an account number (like CN0001, incremented on each reset) and an opening time.
 * - Keeps up to 3000 trades. Per-stock totals (bought, sold, fees, realized P&L) live in the position, so trimming old trades does not change them.
 * - Keeps up to 2000 orders (filled, partial, queued, rejected, cancelled). Problems reported on the spot (bad quantity, not enough sellable shares) are not orders.
 * - archiveBook saves the whole book before a reset, so its trades stay searchable.
 */
(function (root, factory) {
  const core = typeof module === 'object' && module.exports ? require('./nebula-core.js') : root.NebulaCore;
  const api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NebulaSim = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  const RULES = {
    CN: { t1: true, commission: 0.00025, minCommission: 500, transfer: 0.00001, stampBuy: 0, stampSell: 0.0005, levy: 0 },
    HK: { t1: false, commission: 0.0003, minCommission: 0, transfer: 0, stampBuy: 0.001, stampSell: 0.001, levy: 0.000085 },
    US: { t1: false, commission: 0.0001, minCommission: 100, transfer: 0, stampBuy: 0, stampSell: 0, levy: 0, levySell: 0.00003 },
  };
  const TRADE_CAP = 3000, ORDER_CAP = 2000;
  const toCents = yuan => Math.round(yuan * 100);
  const marketOf = code => (code.startsWith('hk') ? 'HK' : code.startsWith('us') ? 'US' : 'CN');

  /**
   * opened：{ no 账号序号, at 开户时间 }。
   * opened: { no account sequence, at opening time }.
   */
  function createBook(capitalYuan = 1000000, currency = 'CNY', opened = {}) {
    const capital = toCents(capitalYuan);
    return { version: 2, currency, capital, cash: capital, positions: {}, trades: [], pending: [], orders: [], seq: 0,
      no: opened.no || 1, openedAt: opened.at || 0, day: '', dayOpenEquity: capital, equityDays: [] };
  }

  /**
   * 账号：市场加 4 位序号，例如 CN0001。
   * Account number: market plus a 4-digit sequence, e.g. CN0001.
   */
  const accountId = (market, book) => market + String((book && book.no) || 1).padStart(4, '0');

  const emptyStats = () => ({ bought: 0, boughtAmt: 0, sold: 0, soldAmt: 0, fees: 0, first: 0, last: 0 });

  /**
   * 旧账本（version 1）补上账号、委托记录、每只股票的累计数和每笔卖出的盈亏：按成交记录从头重算。
   * 某只股票重算出来的股数和持仓对不上（记录被截掉过），它的卖出盈亏记成 null（不知道），不瞎算。
   * Upgrade a version-1 book: add the account number, order records, per-stock totals and the realized P&L of each sale by replaying its trades.
   * If the replayed share count of a stock does not match its position (trades were trimmed), its sale P&L becomes null (unknown) rather than a guess.
   */
  function upgradeBook(book, now = 0) {
    if (!book || typeof book !== 'object' || book.version >= 2) return book;
    const trades = (Array.isArray(book.trades) ? book.trades : []).map((t, k) => Object.assign({}, t, { no: k + 1 }));
    const run = {}, stats = {};
    for (const t of trades) {
      const fee = t.fee ? t.fee.total || 0 : 0;
      const s = stats[t.code] || (stats[t.code] = emptyStats());
      const r = run[t.code] || (run[t.code] = { qty: 0, cost: 0 });
      s.fees += fee;
      if (!s.first) s.first = t.at || 0;
      s.last = t.at || s.last;
      if (t.side === 'buy') { s.bought += t.qty; s.boughtAmt += t.amount; r.qty += t.qty; r.cost += t.amount + fee; }
      else {
        s.sold += t.qty; s.soldAmt += t.amount;
        const basis = r.qty > 0 ? Math.round(r.cost * Math.min(t.qty, r.qty) / r.qty) : 0;
        t.realized = r.qty >= t.qty ? t.amount - fee - basis : null;
        r.qty -= t.qty; r.cost -= basis;
      }
    }
    const positions = {};
    for (const [code, p] of Object.entries(book.positions || {})) {
      const known = run[code] ? run[code].qty === p.qty : p.qty === 0;
      if (!known) trades.forEach(t => { if (t.code === code && t.side === 'sell') t.realized = null; });
      positions[code] = Object.assign({}, p, stats[code] || emptyStats(), known ? {} : { partial: true });
    }
    let seq = trades.length;
    const orders = trades.map(t => ({ no: t.no, code: t.code, name: t.name, side: t.side, qty: t.qty, at: t.at, via: t.basis === 'open' ? 'queue' : 'now',
      status: 'filled', filled: t.qty, price: t.price, amount: t.amount, done: t.at }));
    const pending = (Array.isArray(book.pending) ? book.pending : []).map(o => {
      seq += 1;
      orders.push({ no: seq, code: o.code, name: o.name, side: o.side, qty: o.qty, at: o.placedOn || now, via: 'queue', status: 'queued' });
      return Object.assign({}, o, { no: seq });
    });
    const firstDay = book.equityDays && book.equityDays.length ? Date.parse(book.equityDays[0][0] + 'T09:30:00+08:00') : 0;
    const known = [trades.length ? trades[0].at : 0, firstDay, now].filter(v => v > 0);
    return Object.assign({}, book, { version: 2, trades, positions, pending, orders: orders.slice(-ORDER_CAP), seq,
      no: book.no || 1, openedAt: book.openedAt || (known.length ? Math.min(...known) : 0) });
  }

  /**
   * 这只股票的数量规则：返回错误文字，合规返回 null。
   * Lot rules for this stock: returns an error message, or null when valid.
   */
  function lotError(code, side, qty, owned, lot) {
    if (!Number.isSafeInteger(qty) || qty <= 0) return '请输入大于零的整数股数';
    if (code.startsWith('us')) return null;
    if (code.startsWith('hk')) return qty % lot === 0 ? null : `港股这只每手 ${lot} 股，请按整手`;
    if (/^sh68[89]/.test(code)) {
      if (side === 'buy') return qty >= 200 ? null : '科创板单笔最少 200 股';
      return qty >= 200 || qty === owned ? null : '科创板模拟卖出最少 200 股，不足 200 股时须一次卖完';
    }
    if (side === 'buy') return qty % 100 === 0 ? null : 'A 股模拟买入须为 100 股的整数倍';
    return qty % 100 === 0 || qty === owned ? null : 'A 股模拟卖出须为 100 股的整数倍，零股须一次卖完';
  }

  /**
   * 费用（分）。amount 为成交金额（分）。
   * Fees (cents). amount is the trade value (cents).
   */
  function fees(market, side, amount) {
    const r = RULES[market] || RULES.CN;
    const commission = Math.max(r.minCommission, Math.round(amount * r.commission));
    const transfer = Math.round(amount * r.transfer);
    const stamp = Math.ceil(amount * (side === 'buy' ? r.stampBuy : r.stampSell));
    const levy = Math.round(amount * (r.levy + (side === 'sell' ? r.levySell || 0 : 0)));
    return { commission, transfer, stamp, levy, total: commission + transfer + stamp + levy };
  }

  /**
   * 沿五档盘口吃单：返回能成交的股数和金额（分）。盘口的量：A 股是手，科创板也是（2026-11-05 逐只核对过），港股是股。
   * Walk the 5-level book: returns fillable shares and value (cents). Book sizes are lots for A-shares (STAR Market too, checked stock by stock on 2026-11-05) and shares for HK.
   */
  function walkBook(levels, qty, sharesPerUnit) {
    let left = qty, amount = 0, filled = 0;
    const used = [];
    for (const [price, size] of levels) {
      if (!(price > 0) || !(size > 0) || left <= 0) continue;
      const take = Math.min(left, Math.floor(size * sharesPerUnit));
      if (take <= 0) continue;
      amount += Math.round(take * price * 100);
      filled += take; left -= take;
      used.push([price, take]);
    }
    return { filled, amount, used };
  }
  const bookUnit = code => (/^(hk|us)/.test(code) ? 1 : 100);

  /**
   * 美股这一边的价：有买一卖一并且离现价不超过 2% 才用（盘后的挂单可能差很远），否则用最新价。盘中实测都是 0，实际就是最新价。
   * Price on this side for US stocks: use the best bid/ask only when it is within 2% of the last price (after-hours quotes can be far off), otherwise the last price. They are 0 during the session, so in practice it is the last price.
   */
  function usPrice(q, side) {
    const level = (side === 'buy' ? q.asks : q.bids)[0];
    return level && level[0] > 0 && Math.abs(level[0] / q.price - 1) <= 0.02 ? level[0] : q.price;
  }

  /**
   * 这份报价现在能不能成交。不能返回原因。
   * Whether this quote can trade right now. Returns the reason when it cannot.
   */
  function untradable(q, side) {
    if (!q) return '没有这只股票的报价';
    if (q.stale) return '停牌或尚未成交，不能模拟成交';
    if (q.code && q.code.startsWith('us')) return null;
    const levels = side === 'buy' ? q.asks : q.bids;
    const hasDepth = levels && levels.some(([p, s]) => p > 0 && s > 0);
    if (!hasDepth) {
      if (side === 'buy' && q.limitUp && q.price >= q.limitUp * 0.9995) return '涨停封板，没有卖盘，买不进';
      if (side === 'sell' && q.limitDown && q.price <= q.limitDown * 1.0005) return '跌停封板，没有买盘，卖不出';
      return '盘口没有对手盘';
    }
    return null;
  }

  /**
   * 跨交易日：T+1 解锁，记下昨日净值。tradingDay 是报价所属交易日（YYYY-MM-DD）。
   * 只往前走：停牌股票的报价日期可能更早，不能因此解锁当天买入的股票。
   * Cross into a new trading day: unlock T+1 shares and record yesterday's equity. tradingDay is the quote's trading day (YYYY-MM-DD).
   * Only moves forward: a suspended stock's quote may carry an older date and must not unlock shares bought today.
   */
  function rollDay(book, tradingDay, equityCents) {
    if (!tradingDay || book.day >= tradingDay) return book;
    const positions = {};
    for (const [code, p] of Object.entries(book.positions)) positions[code] = Object.assign({}, p, { avail: p.qty });
    const days = book.day && equityCents !== null && equityCents !== undefined
      ? book.equityDays.concat([[book.day, equityCents]]).slice(-400) : book.equityDays;
    return Object.assign({}, book, { day: tradingDay, positions, equityDays: days, dayOpenEquity: equityCents === null || equityCents === undefined ? book.dayOpenEquity : equityCents });
  }

  function applyFill(book, order, price, filled, amount, at, basis, name) {
    const code = order.code, side = order.side, market = marketOf(code);
    const fee = fees(market, side, amount);
    const position = Object.assign({ qty: 0, avail: 0, cost: 0, realized: 0, name: name || code }, emptyStats(), book.positions[code]);
    let cash = book.cash, qty = position.qty, avail = position.avail, cost = position.cost, realized = position.realized;
    let gain = null;
    if (side === 'buy') {
      cash -= amount + fee.total;
      qty += filled;
      if (!RULES[market].t1) avail += filled;
      cost += amount + fee.total;
    } else {
      const basisCost = position.qty > 0 ? Math.round(position.cost * filled / position.qty) : 0;
      cash += amount - fee.total;
      qty -= filled; avail -= filled;
      cost -= basisCost;
      gain = amount - fee.total - basisCost;
      realized += gain;
    }
    const counts = side === 'buy'
      ? { bought: position.bought + filled, boughtAmt: position.boughtAmt + amount }
      : { sold: position.sold + filled, soldAmt: position.soldAmt + amount };
    const positions = Object.assign({}, book.positions);
    positions[code] = Object.assign({}, position, counts, { qty, avail, cost, realized, name: name || position.name, fees: position.fees + fee.total, first: position.first || at, last: at });
    const trade = { no: order.no || 0, code, name: name || position.name, side, qty: filled, price, amount, fee, at, basis, cashAfter: cash };
    if (side === 'sell') trade.realized = gain;
    return Object.assign({}, book, { cash, positions, trades: book.trades.concat([trade]).slice(-TRADE_CAP) });
  }

  // ---------------------------------------------------------------- 委托记录 / Order records

  function addOrder(book, record) {
    const orders = (book.orders || []).concat([record]).slice(-ORDER_CAP);
    return Object.assign({}, book, { orders, seq: Math.max(book.seq || 0, record.no) });
  }
  function updateOrder(book, no, patch) {
    if (!no || !book.orders) return book;
    let hit = false;
    const orders = book.orders.map(o => (o.no === no ? (hit = true, Object.assign({}, o, patch)) : o));
    return hit ? Object.assign({}, book, { orders }) : book;
  }

  /**
   * 按当前报价成交（不记委托）。check 为真：数量、可卖这类当场提示的问题，不算一笔委托。
   * Fill at the current quote (no order record). check is true for problems reported on the spot (quantity, sellable shares), which do not count as orders.
   */
  function fillNow(book, order, q, now) {
    const { code, side, qty } = order;
    const market = marketOf(code);
    const owned = book.positions[code] ? book.positions[code].qty : 0;
    const lotProblem = lotError(code, side, qty, owned, q ? q.lot || 100 : 100);
    if (lotProblem) return { book, reject: lotProblem, check: true };
    if (side === 'sell') {
      const avail = book.positions[code] ? book.positions[code].avail : 0;
      if (qty > avail) return { book, check: true, reject: owned > avail ? `T+1：今天模拟买入的 ${owned - avail} 股要下一个交易日才能卖，现在可卖 ${avail} 股` : `可卖只有 ${avail} 股` };
    }
    const blocked = untradable(q, side);
    if (blocked) return { book, reject: blocked };
    if (market === 'US') {
      const room = Math.floor((q.vol || 0) * 0.01);
      const filled = room > 0 ? Math.min(qty, room) : qty;
      const price = usPrice(q, side);
      const amount = Math.round(filled * price * 100);
      const fee = fees(market, side, amount);
      if (side === 'buy' && amount + fee.total > book.cash) return { book, reject: '可用现金不足' };
      const next = applyFill(book, order, price, filled, amount, now, 'live', q.name);
      return { book: next, trade: next.trades[next.trades.length - 1], unfilled: qty - filled };
    }
    const levels = side === 'buy' ? q.asks : q.bids;
    const walked = walkBook(levels, qty, bookUnit(code));
    const lot = code.startsWith('hk') ? q.lot || 100 : (/^sh68[89]/.test(code) ? 1 : 100);
    let filled = walked.filled - walked.filled % lot, amount = walked.amount;
    if (filled !== walked.filled) amount = walkBook(levels, filled, bookUnit(code)).amount;
    if (filled <= 0) return { book, reject: '五档盘口的量不够一手' };
    if (/^sh68[89]/.test(code) && side === 'buy' && filled < 200) return { book, reject: '五档盘口的量不够科创板最低 200 股' };
    const fee = fees(market, side, amount);
    if (side === 'buy' && amount + fee.total > book.cash) return { book, reject: '可用现金不足' };
    const price = amount / filled / 100;
    const next = applyFill(book, order, price, filled, amount, now, 'live', q.name);
    return { book: next, trade: next.trades[next.trades.length - 1], unfilled: qty - filled };
  }

  /**
   * 立即按当前报价模拟成交，并记一笔委托。返回 { book, trade?, reject?, unfilled?, no? }。
   * quote 是刚取到的完整报价（含五档）。order 带 no 的是排队委托在结算，更新那一笔，不另记。
   * Simulate a fill at the current quote right away and record an order. Returns { book, trade?, reject?, unfilled?, no? }.
   * quote is the freshly fetched full quote (with the 5-level book). An order carrying no is a queued order being settled: update that record instead of adding one.
   */
  function placeNow(book, order, q, now) {
    const no = order.no || (book.seq || 0) + 1;
    const out = fillNow(book, Object.assign({}, order, { no }), q, now);
    if (out.check) return { book, reject: out.reject };
    const result = out.trade
      ? { status: out.unfilled ? 'partial' : 'filled', filled: out.trade.qty, price: out.trade.price, amount: out.trade.amount, done: now }
      : { status: 'rejected', reason: out.reject, done: now };
    if (out.unfilled) result.reason = marketOf(order.code) === 'US' ? `超过当天成交量的 1%，${out.unfilled} 股没成交` : `五档盘口不够，${out.unfilled} 股没成交`;
    const name = (q && q.name) || (book.positions[order.code] && book.positions[order.code].name) || order.name || order.code;
    const next = order.no ? updateOrder(out.book, no, result)
      : addOrder(out.book, Object.assign({ no, code: order.code, name, side: order.side, qty: order.qty, at: now, via: 'now' }, result));
    return { book: next, trade: out.trade, reject: out.reject, unfilled: out.unfilled, no };
  }

  /**
   * 挂单（非交易时段用），记一笔排队中的委托。
   * Queue an order (outside trading hours) and record it as queued.
   */
  function queue(book, order, q, now = 0) {
    const { code, side, qty } = order;
    const owned = book.positions[code] ? book.positions[code].qty : 0;
    const lotProblem = lotError(code, side, qty, owned, q ? q.lot || 100 : 100);
    if (lotProblem) return { book, reject: lotProblem };
    const no = (book.seq || 0) + 1;
    const name = q && q.name ? q.name : code;
    const pending = book.pending.concat([{ no, code, side, qty, name, placedOn: q && q.at ? q.at : 0 }]);
    const next = addOrder(Object.assign({}, book, { pending }), { no, code, name, side, qty, at: now || (q && q.at) || 0, via: 'queue', status: 'queued' });
    return { book: next, no };
  }

  // 美股的一个交易日在北京时间跨两天，日期要按纽约算
  const quoteDay = (at, code) => (code && code.startsWith('us') ? Core.newYork(at).day : Core.beijing(at).day);

  /**
   * 结算挂单。
   * - 报价已经是委托之后的交易日：按当天真实开盘价成交。一字涨停买不进、一字跌停卖不出、停牌的继续留到下一天；
   *   超过可卖、现金不足的取消并给出原因。
   * - 还是同一天（午休时下的单）：当天开盘价已经过去了，不能用。sessionOpen(market) 为真时按现在的五档盘口成交，否则继续等。
   * Settle queued orders.
   * - The quote is from a trading day after the order: fill at that day's real open. One-price limit-up buys, limit-down sells and suspended stocks stay queued;
   *   orders exceeding the sellable shares or the cash are cancelled with a reason.
   * - Same day (placed during the lunch break): that day's open has passed and cannot be used. Fill against the current book when sessionOpen(market) is true, otherwise keep waiting.
   */
  function settlePending(book, quotes, now, sessionOpen) {
    if (!book.pending.length) return { book, results: [] };
    const results = [];
    const rest = [];
    let next = book;
    const cancel = (order, reason) => { next = updateOrder(next, order.no, { status: 'rejected', reason, done: now }); results.push({ order, reject: reason }); };
    for (const order of book.pending) {
      const q = quotes[order.code];
      if (!q || !q.at || q.vol <= 0 || q.stale) { rest.push(order); continue; }
      if (quoteDay(q.at, order.code) <= quoteDay(order.placedOn, order.code)) {
        const open = sessionOpen ? sessionOpen(marketOf(order.code)) : false;
        if (!open) { rest.push(order); continue; }
        if (untradable(q, order.side)) { rest.push(order); continue; }
        const done = placeNow(next, order, q, now);
        next = done.book;
        if (done.trade) results.push({ order, trade: done.trade }); else cancel(order, done.reject + '，委托取消');
        continue;
      }
      const openLimitUp = q.limitUp && q.open >= q.limitUp * 0.9995 && q.low >= q.limitUp * 0.9995;
      const openLimitDown = q.limitDown && q.open <= q.limitDown * 1.0005 && q.high <= q.limitDown * 1.0005;
      if ((order.side === 'buy' && openLimitUp) || (order.side === 'sell' && openLimitDown)) { rest.push(order); continue; }
      const market = marketOf(order.code);
      const amount = Math.round(order.qty * q.open * 100);
      if (order.side === 'buy' && amount + fees(market, 'buy', amount).total > next.cash) { cancel(order, '开盘时可用现金不足，委托取消'); continue; }
      if (order.side === 'sell' && order.qty > (next.positions[order.code] ? next.positions[order.code].avail : 0)) { cancel(order, '开盘时可卖数量不足，委托取消'); continue; }
      next = applyFill(next, order, q.open, order.qty, amount, now, 'open', q.name);
      const trade = next.trades[next.trades.length - 1];
      next = updateOrder(next, order.no, { status: 'filled', filled: order.qty, price: q.open, amount, done: now });
      results.push({ order, trade });
    }
    return { book: Object.assign({}, next, { pending: rest }), results };
  }

  /**
   * 撤掉第 k 笔排队中的委托。
   * Cancel the k-th queued order.
   */
  function cancelPending(book, k, now = 0) {
    if (!(k >= 0 && k < book.pending.length)) return book;
    const order = book.pending[k];
    const next = Object.assign({}, book, { pending: book.pending.filter((_, i) => i !== k) });
    return updateOrder(next, order.no, { status: 'cancelled', done: now });
  }

  /**
   * 账户净值（分）。有持仓缺报价时用成本价估，并在 missing 里说明。
   * Account equity (cents). Positions without a quote are valued at cost and listed in missing.
   */
  function equity(book, quotes) {
    let total = book.cash, market = 0;
    const missing = [];
    for (const [code, p] of Object.entries(book.positions)) {
      if (!p.qty) continue;
      const q = quotes[code];
      const value = q ? Math.round(p.qty * q.price * 100) : p.cost;
      if (!q) missing.push(code);
      total += value; market += value;
    }
    return { total, market, cash: book.cash, pnl: total - book.capital, dayPnl: total - book.dayOpenEquity, missing };
  }

  /**
   * 这本账用过没有：有成交、委托或持仓。
   * Whether this book has been used: any trades, orders or positions.
   */
  const used = book => !!(book && (book.trades.length || (book.orders && book.orders.length) || book.pending.length || Object.values(book.positions).some(p => p.qty > 0)));

  /**
   * 重置前把整本账存档：账号、起止时间、本金、结束时的总资产、全部成交和委托。quotes 给持仓估值，没报价的按成本。
   * 还在排队的委托随重置撤掉，存档里记成已撤单。
   * Archive the whole book before a reset: account number, start and end time, capital, final equity, all trades and orders. quotes values the positions; those without a quote use cost.
   * Orders still queued are cancelled by the reset and recorded as cancelled in the archive.
   */
  function archiveBook(book, market, quotes, now) {
    const e = equity(book, quotes || {});
    const held = {};
    for (const [code, p] of Object.entries(book.positions)) {
      if (!(p.qty > 0)) continue;
      const q = quotes && quotes[code];
      held[code] = { name: p.name, qty: p.qty, cost: p.cost, value: q ? Math.round(p.qty * q.price * 100) : p.cost };
    }
    const orders = (book.orders || []).map(o => (o.status === 'queued' ? Object.assign({}, o, { status: 'cancelled', reason: '重置账户时撤单', done: now }) : o));
    return { version: 2, market, currency: book.currency, no: book.no || 1, openedAt: book.openedAt || 0, closedAt: now, capital: book.capital, cash: book.cash,
      final: e.total, held, positions: book.positions, trades: book.trades, orders, equityDays: book.equityDays || [] };
  }

  /**
   * 每只股票从开户到现在的买卖汇总（金额是分），持有的在前，其余按最近成交排。
   * floating 浮动盈亏、realized 已实现盈亏，都扣过费用；total 是两者之和。
   * Per-stock buy/sell summary since the account opened (amounts in cents); held stocks first, the rest by most recent trade.
   * floating (unrealized) and realized P&L both include fees; total is their sum.
   */
  function stockSummary(book, quotes) {
    return Object.entries(book.positions).filter(([, p]) => p.qty > 0 || p.bought || p.sold).map(([code, p]) => {
      const q = quotes && quotes[code];
      const held = p.qty > 0;
      const value = held ? (q ? Math.round(p.qty * q.price * 100) : p.cost) : 0;
      const floating = held ? value - p.cost : 0;
      const realized = p.realized || 0;
      return { code, name: p.name, qty: p.qty, cost: p.cost, value, priced: !held || !!q, floating, realized, total: floating + realized,
        bought: p.bought || 0, boughtAmt: p.boughtAmt || 0, sold: p.sold || 0, soldAmt: p.soldAmt || 0, fees: p.fees || 0,
        first: p.first || 0, last: p.last || 0, partial: !!p.partial };
    }).sort((a, b) => (b.qty > 0) - (a.qty > 0) || b.last - a.last);
  }

  /**
   * 筛成交：text 名称或代码（不分大小写），side 'buy' / 'sell'，from / to 是 YYYY-MM-DD（含两头，按市场当地日期）。
   * Filter trades: text matches name or code (case-insensitive), side 'buy' / 'sell', from / to are YYYY-MM-DD (inclusive, in the market's local date).
   */
  function filterTrades(trades, f = {}) {
    const text = String(f.text || '').trim().toLowerCase();
    return trades.filter(t => {
      if (f.side && f.side !== 'all' && t.side !== f.side) return false;
      if (text && !(t.code.toLowerCase().includes(text) || String(t.name || '').toLowerCase().includes(text))) return false;
      if (f.from || f.to) {
        const day = Core.marketDay(marketOf(t.code), t.at);
        if (f.from && day < f.from) return false;
        if (f.to && day > f.to) return false;
      }
      return true;
    });
  }

  /**
   * 一组成交的合计（分）。有卖出的盈亏不知道（旧记录截掉过）时 realizedKnown 为假。
   * Totals for a list of trades (cents). realizedKnown is false when some sale P&L is unknown (old records were trimmed).
   */
  function tradeTotals(list) {
    const t = { n: list.length, buys: 0, sells: 0, buyAmt: 0, sellAmt: 0, fees: 0, realized: 0, realizedKnown: true };
    for (const x of list) {
      t.fees += x.fee ? x.fee.total : 0;
      if (x.side === 'buy') { t.buys++; t.buyAmt += x.amount; } else {
        t.sells++; t.sellAmt += x.amount;
        if (x.realized === null || x.realized === undefined) t.realizedKnown = false; else t.realized += x.realized;
      }
    }
    return t;
  }

  return { RULES, TRADE_CAP, ORDER_CAP, createBook, accountId, upgradeBook, lotError, fees, walkBook, untradable, rollDay, placeNow, queue, settlePending, cancelPending,
    equity, used, archiveBook, stockSummary, filterTrades, tradeTotals, bookUnit };
}));
