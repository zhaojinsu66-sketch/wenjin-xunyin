/*
 * 问金寻银 · 主逻辑。
 * 流程：取股票名单 → 真实行情一批批点亮粒子 → 开市走滚动刷新，收盘走真实历史回放 → 规则、模拟账户跟着走。
 * 画面里没有任何随机生成的行情：闪光、彗星、数字全部来自收到的真实数据；数据没到就是暗的。
 *
 * Wenjin Xunyin · main logic.
 * Flow: load the stock list → real quotes light particles batch by batch → rolling refresh while markets are open, real history replay after the close → rules and the simulated account follow.
 * Nothing on screen is randomly generated: flares, comets and numbers all come from data actually received; stocks without data stay dark.
 */
import { NebulaScene, CORE_SOCKET } from './nebula-scene.js';

const Core = window.NebulaCore, Sim = window.NebulaSim;
const $ = id => document.getElementById(id);
const esc = s => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const cls = v => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const commas = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const NOTE = '数据来自公开网络，可能延迟或有误，仅供研究。';
const BATCH = 60;
const REPLAY_DAY_MS = 1500;
const INDEX_NAMES = { sh000001: '上证', sh000300: '沪深300', sz399006: '创业板', hkHSI: '恒生', hkHSTECH: '恒生科技', usINX: '标普500', usIXIC: '纳指', usDJI: '道指' };
const INDEX_VIEW = { ALL: ['sh000300', 'hkHSI', 'usINX', 'usIXIC'], CN: ['sh000001', 'sh000300', 'sz399006'], HK: ['hkHSI', 'hkHSTECH'], US: ['usINX', 'usIXIC', 'usDJI'] };
const INDEX_CODES = Object.keys(INDEX_NAMES);
const MARKETS = ['CN', 'HK', 'US'];
/**
 * 各市场的基准指数：分时、回放路径都用它。minutes 是一天有多少分钟的分时点。
 * Benchmark index of each market, used by the intraday chart and the replay path. minutes is the number of intraday points per day.
 */
const MARKET_INDEX = { CN: { code: 'sh000300', name: '沪深300', minutes: 240 }, HK: { code: 'hkHSI', name: '恒生', minutes: 330 }, US: { code: 'usINX', name: '标普500', minutes: 390 } };
/**
 * 量行情新不新用的股票：成交最活跃的几只，盘中隔几秒就有新成交。跟指数一起取，不显示。
 * Stocks used to judge quote freshness: the most active names trade every few seconds during the session. Fetched with the indices, not shown.
 */
const FRESH_PROBE = { CN: 'sh600519', HK: 'hk00700', US: 'usAAPL' };
const LATE_MS = 180000;   // 比现在晚超过 3 分钟就不能叫实时
/**
 * 回测结果按这个键存，对比的指数也跟着它。
 * Backtest results are keyed by this, and so is the comparison index.
 */
const TEST_KEY = { CN: 'A', HK: 'HK', US: 'US' };
const BENCH_NAME = { A: '沪深300', HK: '恒生', US: '标普500' };
const MARKET_NAME = { A: 'A 股', CN: 'A 股', HK: '港股', US: '美股' };
const CURRENCY = { CN: 'CNY', HK: 'HKD', US: 'USD' };
/**
 * 不同币种的成交额粗略折成人民币，只用来比大小（粒子大小、上榜门槛、排序），不显示。
 * Rough conversion of other currencies' turnover to CNY, only for comparing sizes (particle size, ranking threshold, sorting); never shown.
 */
const FX = { CN: 1, HK: 0.92, US: 7.2 };
/**
 * 重置过的旧账户最多留几本（S 初始化时就要用，放在 S 前面）。
 * How many reset accounts to keep (needed when S is initialized, so defined before S).
 */
const ARCHIVE_MAX = 12;

const S = {
  mode: 'boot', view: 'ALL', stocks: [], n: 0, codeIndex: new Map(), pct: null, price: null, amount: null, seen: null,
  industries: [], full: new Map(), indices: {}, breadth: Core.breadth([]),
  counters: { batches: 0, rows: 0, rejected: 0, stale: 0, changes: 0, bytes: 0, fullQuotes: 0, minute: 0, lastLatency: 0, updates: 0 },
  rate: 0, rules: [], ruleId: null, history: null, sweepOrder: null, sweepPos: 0, focus: null,
  replay: { day: 0, playing: true, started: 0, sweep: 0, last: 0, target: null }, ic: { series: { reversal5: [], momentum20: [], vol20: [] }, done: false },
  minute: { points: [], prev: 0, date: '', code: '', total: 240 }, sigmas: {},
  books: loadBooks(), sheet: null, sheetStack: [], acctShown: 0, acctTarget: 0, acctPrev: 0, acctAt: 0, feedAt: 0, pendingWrites: [], hidden: false, metered: false,
  basket: loadBasket(), basketEach: 10000, archive: loadArchive(),
};
// 地址参数直达：?open=account&market=CN&tab=trades 启动后打开模拟账户；?open=stock&code=sh600519 打开这只股票
const OPEN = new URLSearchParams(location.search);
// 录演示视频用：?capture=1 时由外部逐帧驱动（window.__step），画面时间和截图一一对应
const CAPTURE = /[?&]capture=1/.test(location.search);
// 调试用：?live=1 时收盘也走实时刷新的路径
S.forceLive = /[?&]live=1/.test(location.search);
let virtualNow = 0;
const clockNow = () => (CAPTURE ? virtualNow : performance.now());
const scene = new NebulaScene($('gl'), { capture: CAPTURE });
const overlay = $('overlay'), ctx = overlay.getContext('2d');
const nodes = { left: [], right: [] };
let layoutInfo = { w: 1, h: 1, cx: 0, cy: 0, r: 100 };

window.__nebula = { S, scene };

// ---------------------------------------------------------------- 账本 / Books

/**
 * 读账本：存在浏览器的 localStorage 里，只在这个浏览器有效，不上传。
 * 旧版账本（没有账号、委托记录）读进来时补齐。
 * Load the books from the browser's localStorage: valid only in this browser, never uploaded.
 * Older books (without account numbers or order records) are upgraded on load.
 */
function loadBooks() {
  let stored = null;
  try { const raw = JSON.parse(localStorage.getItem('wenjin.books.v1')); stored = raw && raw.CN && raw.HK ? raw : null; } catch (e) { /* 存储不可用或内容坏了 */ }
  const now = Date.now();
  const fresh = { CN: [1000000, 'CNY'], HK: [1000000, 'HKD'], US: [100000, 'USD'] };
  const books = {};
  for (const m of MARKETS) books[m] = stored && stored[m] ? Sim.upgradeBook(stored[m], now) : Sim.createBook(fresh[m][0], fresh[m][1], { at: now });
  return books;
}
function saveBooks() {
  try { localStorage.setItem('wenjin.books.v1', JSON.stringify(S.books)); } catch (e) { /* 无痕或存储满：本次会话内仍可用 */ }
}

/**
 * 重置过的旧账户：整本存着，买卖记录还能查。最多留 ARCHIVE_MAX 本，最新的在前。
 * Reset accounts are archived whole so their trades stay searchable. Keeps up to ARCHIVE_MAX, newest first.
 */
function loadArchive() {
  try {
    const raw = JSON.parse(localStorage.getItem('wenjin.archive.v1') || '[]');
    return Array.isArray(raw) ? trimArchive(raw.filter(a => a && MARKETS.includes(a.market) && Array.isArray(a.trades))) : [];
  } catch (e) { return []; }
}
function trimArchive(list) { return list.slice(0, ARCHIVE_MAX); }
function saveArchive() {
  try { localStorage.setItem('wenjin.archive.v1', JSON.stringify(trimArchive(S.archive))); } catch (e) { /* 存储满：本次会话内仍可用 */ }
}

/**
 * 重置账户：用过的旧账本先存档，新账本账号序号加一。没用过的只换本金，账号不变。
 * Reset an account: a used book is archived first and the new book's account number goes up by one. An unused book only changes its capital and keeps its number.
 */
function resetBook(market, capital) {
  const now = Date.now();
  const old = S.books[market];
  const keep = Sim.used(old);
  if (keep) {
    S.archive.unshift(Sim.archiveBook(old, market, Object.fromEntries(S.full), now));
    S.archive = trimArchive(S.archive);
    saveArchive();
  }
  S.books[market] = Sim.createBook(capital, CURRENCY[market], { no: (old.no || 1) + (keep ? 1 : 0), at: keep ? now : old.openedAt || now });
  saveBooks();
  S.acctShown = 0;
  refreshAccount();
  renderPipeline();
  return keep;
}

/**
 * 地址里带了股票代码（?open=stock&code=…）：打开这只的卡片。星云名单里没有的，打开查找并说明。
 * A stock code in the URL (?open=stock&code=…) opens that stock's card. Codes not in the nebula list open search with a note.
 */
function openLinkedStock(code) {
  const i = S.codeIndex.get(code);
  if (i !== undefined) openStock(i);
  else openSheet({ kind: 'search', query: code.replace(/^(sh|sz|bj|hk|us)/, ''), missing: code.replace(/^(sh|sz|bj|hk|us)/, '') });
}

/**
 * 篮子：挑几只股票放在一起，一起模拟买卖、对照看涨跌。只存代码，最多 30 只。
 * Basket: put a few stocks together to trade them together in simulation and compare their moves. Stores codes only, up to 30.
 */
const BASKET_MAX = 30;
function loadBasket() {
  // S 初始化时就调这里，BASKET_MAX 还没定义（在下面），只能写数字
  try {
    const raw = JSON.parse(localStorage.getItem('wenjin.basket.v1') || '[]');
    return Array.isArray(raw) ? raw.filter(c => typeof c === 'string').slice(0, 30) : [];
  } catch (e) { return []; }
}
function saveBasket() {
  try { localStorage.setItem('wenjin.basket.v1', JSON.stringify(S.basket)); } catch (e) { /* 本次会话内仍可用 */ }
  paintBasketButton();
}
function paintBasketButton() {
  $('basketBtn').hidden = !S.basket.length;
  $('basketCount').textContent = S.basket.length;
}
/**
 * 加进篮子，返回实际加了几只（已经在的、超过上限的不加）。
 * Add to the basket; returns how many were actually added (skips ones already in it or over the limit).
 */
function addToBasket(codes) {
  let added = 0;
  for (const code of codes) {
    if (S.basket.length >= BASKET_MAX) break;
    if (!S.basket.includes(code)) { S.basket.push(code); added++; }
  }
  saveBasket();
  return added;
}
function dropFromBasket(code) {
  S.basket = S.basket.filter(c => c !== code);
  saveBasket();
}

// ---------------------------------------------------------------- 取数 / Fetching

async function getText(url) {
  const t0 = performance.now();
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  S.counters.lastLatency = Math.round(performance.now() - t0);
  S.counters.bytes += text.length;
  return text;
}
const getJson = async url => JSON.parse(await getText(url));

async function loadUniverse() {
  const u = await getJson('data/universe.json');
  S.industries = u.industries;
  S.asOf = u.asOf;
  S.stocks = u.stocks.map(([code, name, ind, amount]) => {
    const market = Core.marketOf(code);
    return { code, name: Core.shortName(name), ind, amount: (amount || 0) * FX[market], industry: u.industries[ind] || '', market };
  });
  S.n = S.stocks.length;
  S.stocks.forEach((s, i) => S.codeIndex.set(s.code, i));
  S.pct = new Float32Array(S.n).fill(NaN);        // 最新报价的涨跌，列表和卡片用
  S.shownPct = new Float32Array(S.n).fill(NaN);   // 回放当天的涨跌，只给星云和行业统计
  S.price = new Float32Array(S.n).fill(NaN);
  S.prev = new Float64Array(S.n);
  S.amount = new Float64Array(S.n);
  S.seen = new Uint8Array(S.n);
  S.limits = S.stocks.map(s => Core.limitOf(s.code, s.name));
  S.positions = Core.layoutStocks(S.stocks);
  S.sizes = sizesFrom(S.stocks.map(s => s.amount));
  S.stocks.forEach((s, i) => { S.amount[i] = s.amount || 0; });
  const big = window.innerWidth * window.devicePixelRatio > 900 || (navigator.hardwareConcurrency || 4) >= 8;
  scene.setStocks(S.positions, S.sizes, big ? 72000 : 42000);
  // 回放时的扫描波：按经度排序，颜色变化绕球一圈走过去
  S.sweepOrder = Array.from({ length: S.n }, (_, i) => i).sort((a, b) => Math.atan2(S.positions[a * 3 + 2], S.positions[a * 3]) - Math.atan2(S.positions[b * 3 + 2], S.positions[b * 3]));
  S.industryCenters = industryCenters();
  updateRays();
}

function sizesFrom(amounts) {
  const sorted = amounts.filter(a => a > 0).sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.985)] || 1;
  return amounts.map(a => (a > 0 ? clamp(Math.sqrt(a / top), 0.04, 1) : 0.05));
}

function industryCenters() {
  const m = S.industries.map(() => ({ x: 0, y: 0, z: 0, n: 0 }));
  S.stocks.forEach((s, i) => { const c = m[s.ind]; if (!c) return; c.x += S.positions[i * 3]; c.y += S.positions[i * 3 + 1]; c.z += S.positions[i * 3 + 2]; c.n++; });
  return m.map(c => { const l = Math.hypot(c.x, c.y, c.z) || 1; return { dir: [c.x / l, c.y / l, c.z / l], n: c.n }; });
}

const inView = i => S.view === 'ALL' || S.stocks[i].market === S.view;
const marketLive = m => (m === 'CN' ? S.cnOpen : m === 'HK' ? S.hkOpen : S.usOpen);
/**
 * 现在主要看哪个市场：选了就是选的；“全部”时看正在交易的，都收盘了看 A 股。
 * Which market is in focus: the selected one; under 'All', the one trading now, or A-shares when all are closed.
 */
function focusMarket() {
  if (S.view !== 'ALL') return S.view;
  if (S.mode === 'live') { const open = MARKETS.find(marketLive); if (open) return open; }
  return 'CN';
}
const accountMarket = () => (S.view === 'ALL' ? 'CN' : S.view);
const testKey = () => TEST_KEY[accountMarket()];
const testFor = rule => (rule && rule.backtests && rule.backtests[testKey()]) || null;
const ruleHits = rule => (S.view === 'ALL' ? rule.hits : rule.hits.filter(h => { const i = S.codeIndex.get(h.code); return i !== undefined && inView(i); }));
/**
 * 外盘标签放不下英文全称：美股没有中文名的用代码。
 * Dial labels cannot fit long English names: US stocks without a Chinese name show the ticker.
 */
const dialName = i => { const s = S.stocks[i]; return s.market === 'US' && s.name.length > 10 && !/[^\x00-\x7f]/.test(s.name) ? s.code.slice(2) : s.name; };
function viewBreadth(pcts) { return Core.breadth(S.view === 'ALL' ? pcts : pcts.map((p, i) => (inView(i) ? p : null)), S.limits); }

/**
 * 切换市场：别的市场的粒子变暗，涨跌榜、外盘、指数、账户、回测都换成这个市场的。
 * Switch market: other markets' particles dim; movers, dial, indices, account and backtests switch to this market.
 */
function setView(view) {
  S.view = view;
  document.querySelectorAll('#markets [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  scene.setViewOff(view === 'ALL' ? null : S.stocks.map(s => s.market !== view));
  if (S.mode === 'replay' && S.dayPcts) { S.breadth = viewBreadth(S.dayPcts); scene.tilt = S.breadth.tilt; } else recount();
  S.acctShown = 0;
  updateRays(); updateMovers(); renderIndices(); renderMarket(); renderPipeline(); refreshAccount(); updateModeText();
  loadMinute();
}
$('markets').addEventListener('click', e => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });

/**
 * 行业统计：放射线、标签都用它。
 * Industry statistics, used by the rays and the labels.
 */
function industryStats() {
  const stat = S.industries.map(() => ({ amount: 0, sum: 0, n: 0 }));
  const shown = S.mode === 'replay' && S.shownPct ? S.shownPct : S.pct;
  for (let i = 0; i < S.n; i++) {
    if (!inView(i)) continue;
    const c = stat[S.stocks[i].ind];
    if (!c) continue;
    c.amount += S.amount[i] || 0;
    if (!Number.isNaN(shown[i])) { c.sum += shown[i]; c.n++; }
  }
  return stat.map((c, i) => ({ i, name: S.industries[i], amount: c.amount, pct: c.n ? c.sum / c.n : null, dir: S.industryCenters[i].dir }));
}
function updateRays() {
  const stats = industryStats();
  const top = Math.max(...stats.map(s => s.amount), 1);
  const ranked = stats.filter(s => s.amount > 0 && s.pct !== null).sort((a, b) => b.amount - a.amount);
  // 放射线止于星云边缘（从 0.31 起，最长到 1.05），不再穿出外盘
  scene.setRays(ranked.slice(0, 64).map(s => ({ dir: s.dir, pct: s.pct, len: 0.2 + 0.54 * Math.pow(s.amount / top, 0.7) })));
  S.topIndustries = ranked.slice(0, 40);
  renderSide();
}

/**
 * 涨跌榜：成交额太小的不上榜，否则榜首总是几乎没成交的小票。外圈标签放前 6 名，里圈放第 7–12 名。
 * Movers: stocks with tiny turnover are excluded, otherwise the top is always illiquid small caps. The outer ring shows the top 6, the inner ring ranks 7–12.
 */
const RANK_MIN_AMOUNT = 5e7;
const DIAL_EACH = 6;
function updateMovers() {
  const replay = S.mode === 'replay' && S.dayPcts;
  // “全部”时开着的市场优先：美股交易时，A 股下午的涨跌榜不该占着外盘
  const liveOnly = S.view === 'ALL' && S.mode === 'live' && !S.forceLive;
  const rows = [];
  for (let i = 0; i < S.n; i++) {
    if (!inView(i) || (liveOnly && !marketLive(S.stocks[i].market))) continue;
    const p = replay ? S.dayPcts[i] : S.pct[i];
    if (p === null || p === undefined || Number.isNaN(p) || !(S.amount[i] >= RANK_MIN_AMOUNT)) continue;
    if (replay && Math.abs(p) >= 319.99) continue;   // 回放矩阵到 ±320% 封顶，这个数不是真实幅度，不上榜
    rows.push([i, p]);
  }
  // “全部”时每个市场轮流上榜：美股没有涨跌停，只按幅度排的话外盘几乎全是美股小票
  const spread = list => {
    if (S.view !== 'ALL') return list;
    const groups = MARKETS.map(m => list.filter(r => S.stocks[r[0]].market === m)).filter(g => g.length);
    const out = [];
    for (let k = 0; out.length < list.length; k++) groups.forEach(g => { if (g[k]) out.push(g[k]); });
    return out;
  };
  const byGain = spread(rows.filter(r => r[1] > 0).sort((a, b) => b[1] - a[1] || S.amount[b[0]] - S.amount[a[0]]));
  const byLoss = spread(rows.filter(r => r[1] < 0).sort((a, b) => a[1] - b[1] || S.amount[b[0]] - S.amount[a[0]]));
  const entry = r => (r ? { name: dialName(r[0]), pct: r[1], index: r[0] } : null);
  // 涨和跌交替排，转到哪里都能同时看到红和绿；里圈是次一级的涨跌，同样交替
  const slots = [], inner = [];
  for (let k = 0; k < DIAL_EACH; k++) {
    slots.push(entry(byGain[k]), entry(byLoss[k]));
    inner.push(entry(byGain[DIAL_EACH + k]), entry(byLoss[DIAL_EACH + k]));
  }
  scene.setDialSlots(slots);
  scene.setDialInner(inner);
  S.movers = { gain: byGain.slice(0, 8).sort((a, b) => b[1] - a[1]), loss: byLoss.slice(0, 8).sort((a, b) => a[1] - b[1]) };
  renderSide();
}

/**
 * 写入一条简版报价。返回价格是否真的变了。
 * Apply one short quote. Returns whether the price actually changed.
 */
function applyTick(i, t, { delay = 0 } = {}) {
  const prev = t.price - t.change;
  const pct = prev > 0 ? (t.price / prev - 1) * 100 : null;
  const changed = S.seen[i] === 1 && S.price[i] !== Math.fround(t.price);
  S.price[i] = t.price;
  S.pct[i] = pct === null ? NaN : pct;
  if (prev > 0) S.prev[i] = Math.round(prev * 1000) / 1000;
  if (t.name) S.stocks[i].name = Core.shortName(t.name);   // 名单一周才更新一次，新股的 N、C 开头会过期
  const market = S.stocks[i].market;
  if (t.amountRaw !== null) S.amount[i] = market === 'CN' ? t.amountRaw * 10000 : t.amountRaw * FX[market];
  const stale = (t.amountRaw === 0 || t.amountRaw === null) && Math.abs(t.change) < 1e-9;
  S.seen[i] = 1;
  scene.setChange(i, stale ? -99 : pct);
  scene.reveal(i, delay);
  S.counters.rows++;
  const old = S.full.get(S.stocks[i].code);
  if (old) S.full.set(old.code, Core.mergeTick(old, t, Date.now()));
  return changed;
}

function recount() {
  const pcts = new Array(S.n).fill(null);
  const hits = new Int8Array(S.n);
  let stale = 0, seen = 0;
  const amounts = { CN: 0, HK: 0, US: 0 };
  for (let i = 0; i < S.n; i++) {
    if (!S.seen[i]) continue;
    seen++;
    const dead = !(S.amount[i] > 0) && Math.abs(S.pct[i]) < 1e-6;
    if (dead) stale++;
    else if (inView(i)) {
      pcts[i] = S.pct[i];
      const limit = S.stocks[i].market === 'CN' ? Core.limitPrices(S.stocks[i].code, S.stocks[i].name, S.prev[i]) : null;
      if (limit) hits[i] = S.price[i] >= limit.up - 0.002 ? 1 : S.price[i] <= limit.down + 0.002 ? -1 : 0;
    }
    const market = S.stocks[i].market;
    amounts[market] += (S.amount[i] || 0) / FX[market];
  }
  S.breadth = Core.breadth(pcts, S.limits, hits);
  S.counters.stale = stale;
  S.seenCount = seen;
  S.amountBy = amounts;
  scene.tilt = S.breadth.tilt;
}

// ---------------------------------------------------------------- 启动：真实报价一批批点亮 / Startup: real quotes light up batch by batch

async function boot() {
  saveBooks();
  await loadUniverse();
  buildPipeline();   // 流程条要先有内容，星云舞台的高度才准
  layout();
  buildNodes();
  if (OPEN.get('open') === 'account') {
    const market = OPEN.get('market');
    const tab = OPEN.get('tab');
    openAccount({ market: MARKETS.includes(market) ? market : undefined, tab: ACCOUNT_TABS.some(([id]) => id === tab) ? tab : 'hold' });
  } else if (OPEN.get('open') === 'stock') {
    openLinkedStock(OPEN.get('code') || '');
  }
  // 指数、账户这些内容的高度变了，舞台跟着变：只重新定位，不用重建画布
  new ResizeObserver(() => layoutStage()).observe($('stage'));
  if (CAPTURE) window.__step = ms => { virtualNow += ms; loop(virtualNow); };
  else requestAnimationFrame(loop);
  setMode('boot');
  const historyReady = loadHistory();
  loadMinute();
  fetchIndices();
  const order = Array.from({ length: S.n }, (_, i) => i).sort((a, b) => (S.stocks[b].amount || 0) - (S.stocks[a].amount || 0));
  let cursor = 0;
  const workers = [];
  S.bootTotal = S.n;
  const pace = CAPTURE ? 200 : 75; // 每 75 毫秒一批
  for (let k = 0; k < 2; k++) {
    workers.push((async () => {
      while (cursor < order.length) {
        const slice = order.slice(cursor, cursor + BATCH);
        cursor += BATCH;
        await sweepBatch(slice, 0, true);
        await sleep(pace * 2);
      }
    })());
  }
  await Promise.all(workers);
  recount();
  S.sizes = sizesFrom(Array.from(S.amount));
  S.sizes.forEach((s, i) => scene.setSize(i, s));
  updateRays();
  await historyReady;
  startCalculations();
  checkNetwork();
  decideMode();
  // 规则要在全市场报价之后才有意义，不挡住前面的画面
  loadRules();
  setInterval(async () => {
    if (S.hidden) return;
    checkNetwork();
    // 回放时指数不刷新；开市时先取一次，否则报价时间一直是昨天的，会被当成休市，再也切不到实时
    const now = Date.now();
    if (MARKETS.some(m => Core.sessionOpen(m, now))) await fetchIndices();
    decideMode();
  }, 60000);
  liveLoop();
  fullLoop();
  setInterval(() => { if (!S.hidden && S.mode === 'live') { fetchIndices(); } }, 6000);
  setInterval(() => { if (!S.hidden && S.mode === 'live') loadMinute(); }, 30000);
  setInterval(() => { if (!S.hidden && S.mode === 'live') { recount(); updateRays(); updateMovers(); } }, 4000);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/**
 * 浏览器开了省流量，或者报告在用移动网络时，滚动刷新放慢。拿不到网络信息的浏览器照常刷新。
 * Slow the rolling refresh when the browser has data saver on or reports a cellular connection. Browsers without network info refresh normally.
 */
function checkNetwork() {
  const c = navigator.connection;
  S.metered = !!(c && (c.saveData || c.type === 'cellular'));
}

/**
 * 取一批简版报价并更新。ignite：启动时点火（每只都闪一下）。
 * Fetch and apply one batch of short quotes. ignite: the startup pass (every stock flashes once).
 */
async function sweepBatch(indices, sourceNode, ignite) {
  if (!indices.length) return 0;
  let text;
  try {
    text = await getText('proxy/qt?q=' + indices.map(i => 's_' + S.stocks[i].code).join(','));
  } catch (e) { flashNode(nodes.left[sourceNode], true); return 0; }
  const ticks = Core.parseSimple(text);
  const received = Object.keys(ticks);
  if (received.length) S.sweepOkAt = Date.now();
  S.counters.batches++;
  S.counters.rejected += indices.length - received.length;
  const pulseDelay = 0.55;   // 数据顺着接口线走到核心要这么久，粒子等它到了才亮
  firePulse(nodes.left[sourceNode], pulseDelay);
  pipelinePulse();
  const moved = [];
  for (const code of received) {
    const i = S.codeIndex.get(code);
    if (i === undefined) continue;
    const t = ticks[code];
    const changed = applyTick(i, t, { delay: ignite ? pulseDelay + Math.random() * 0.5 : 0 });
    if (ignite || changed) {
      moved.push(i);
      scene.flare(i, ignite ? pulseDelay + Math.random() * 0.5 : pulseDelay + 0.6);
      noteRuleUpdate(S.stocks[i].code);
      if (changed) scene.flashDialStock(i);
    }
  }
  S.counters.changes += moved.length;
  S.counters.updates += moved.length;
  // 彗星只给变化最大的几只，太多反而糊成一片
  moved.sort((a, b) => Math.abs(S.pct[b] || 0) - Math.abs(S.pct[a] || 0));
  moved.slice(0, ignite ? 8 : 10).forEach((i, k) => {
    scene.coreComet(i, Core.changeColor(S.pct[i]).map(v => v * 1.15), pulseDelay + k * 0.04, 0.7);
    if (k < (ignite ? 2 : 4)) feedStock(i);
  });
  return moved.length;
}

// ---------------------------------------------------------------- 开市：滚动刷新 / Market open: rolling refresh

function decideMode() {
  const now = Date.now();
  // 节假日：时钟在交易时段，但指数报价的时间不动。各市场各看各的，假期不一样
  S.cnOpen = Core.sessionLive('CN', now, S.indices.sh000300 && S.indices.sh000300.at);
  S.hkOpen = Core.sessionLive('HK', now, S.indices.hkHSI && S.indices.hkHSI.at);
  S.usOpen = Core.sessionLive('US', now, S.indices.usINX && S.indices.usINX.at);
  const open = S.cnOpen || S.hkOpen || S.usOpen;
  if (S.forceLive) { if (S.mode !== 'live') setMode('live'); return; }
  if (open && S.mode !== 'live') setMode('live');
  // 只在从开市转到收盘时切换；收盘后用户自己选的“回放 / 看收盘”不去动它
  if (!open && (S.mode === 'live' || S.mode === 'boot')) setMode(S.history ? 'replay' : 'closed');
}

function setMode(mode) {
  S.mode = mode;
  if (mode === 'live') S.sweepOkAt = Date.now();   // 刚开盘切过来，第一批还没回来，不算中断
  const el = $('mode');
  el.className = 'mode ' + (mode === 'live' ? 'live' : mode === 'replay' ? 'replay' : '');
  $('feedTag').textContent = mode === 'replay' ? '回放' : mode === 'live' ? '实时' : '行情';
  document.querySelector('.feed').classList.toggle('live', mode === 'live');
  // 这一行一直占位（节点的位置要稳定）：回放时是时间轴，开市时是全市场这一轮刷新到哪里，启动时是点亮进度
  const canReplay = (mode === 'replay' || mode === 'closed') && S.history;
  $('playBtn').style.display = mode === 'replay' ? '' : 'none';
  $('liveBtn').style.display = canReplay ? '' : 'none';
  $('liveBtn').textContent = mode === 'replay' ? '看收盘' : '看回放';
  if (mode === 'closed') { $('tapeFill').style.width = '100%'; $('replayText').textContent = '最新收盘'; }
  if (mode === 'replay') {
    S.replay.playing = true;
    S.replay.day = 0;
    startReplayDay();
  }
  if (mode === 'live') loadMinute();   // 分时跟着正在交易的市场换，不等下一轮刷新
  if (mode === 'closed' || mode === 'live') {
    // 回到真实最新状态：把回放写进去的颜色换回最新报价
    for (let i = 0; i < S.n; i++) scene.setChange(i, S.seen[i] ? (S.pct[i]) : -99);
    S.replay.target = null;
    recount();
    updateRays();
    updateMovers();
    renderIndices();
    renderMarket();
  }
  refreshAccount();
  updateModeText();
}

function updateModeText() {
  const text = $('modeText');
  if (S.mode === 'boot') {
    const seen = S.seenCount || countSeen();
    text.textContent = `点亮中 ${commas(seen)}/${commas(S.n)}`;
  } else if (S.mode === 'live') {
    // “实时”要有依据：时间是这个市场最新报价的时间，不是本机时钟。行情停了这里就停，落后太多就写延迟
    const now = Date.now();
    const atOf = m => (S.indices[FRESH_PROBE[m]] || S.indices[MARKET_INDEX[m].code] || {}).at || 0;
    const open = MARKETS.filter(marketLive);
    const late = S.forceLive ? [] : open.filter(m => atOf(m) && now - atOf(m) > LATE_MS);
    const fresh = open.filter(m => !late.includes(m));
    const names = list => list.map(m => MARKET_NAME[m]).join('·');
    const at = Math.max(0, ...(S.forceLive ? MARKETS : fresh).map(atOf));
    const stamp = at ? Core.clock(at) : '';
    const broken = S.sweepOkAt && now - S.sweepOkAt > 30000;
    const lateText = late.map(m => `${MARKET_NAME[m]} 延迟 ${Math.round((now - atOf(m)) / 60000)} 分`).join(' · ');
    text.textContent = broken ? `${names(open)} 行情中断 · 最新 ${stamp}`
      : !late.length ? `${names(open)} 实时 ${stamp}`
      : fresh.length ? `${names(fresh)} 实时 · ${lateText}` : lateText;
    $('mode').classList.toggle('live', !broken && !late.length);
    $('feedTag').textContent = broken || late.length ? '行情' : '实时';
  } else if (S.mode === 'replay') {
    text.textContent = '已收盘 · 历史回放';
  } else {
    const ref = S.indices[MARKET_INDEX[focusMarket()].code];
    text.textContent = '已收盘 · 最新 ' + (ref ? Core.clock(ref.at).slice(0, 5) : '');
  }
}
function countSeen() { let c = 0; for (let i = 0; i < S.n; i++) c += S.seen[i]; return c; }

async function liveLoop() {
  let cursor = 0;
  for (;;) {
    if (S.hidden || S.mode !== 'live') { await sleep(800); continue; }
    const pool = S.stocks.map((s, i) => [s, i]).filter(([s]) => S.forceLive || marketLive(s.market)).map(x => x[1]);
    if (!pool.length) { await sleep(2000); continue; }
    if (cursor >= pool.length) {
      if (S.roundStart) S.roundSeconds = Math.round((performance.now() - S.roundStart) / 1000);
      S.roundStart = performance.now();
      cursor = 0;
    }
    const slice = pool.slice(cursor, cursor + BATCH);
    cursor += BATCH;
    await sweepBatch(slice, 0, false);
    $('tapeFill').style.width = (Math.min(cursor, pool.length) / pool.length * 100).toFixed(1) + '%';
    $('replayText').textContent = `本轮 ${commas(Math.min(cursor, pool.length))}/${commas(pool.length)}`;
    await sleep(S.metered ? 1000 : 200);
  }
}

/**
 * 完整报价：指数、规则命中的股票、持仓、挂单、正在看的股票，带五档。
 * Full quotes with the 5-level book: indices, rule hits, positions, queued orders and the stock being viewed.
 */
async function fullLoop() {
  for (;;) {
    await sleep(S.mode === 'live' ? 4000 : 20000);
    if (S.hidden) continue;
    const codes = priorityCodes();
    if (!codes.length) continue;
    await fetchFull(codes.slice(0, BATCH));
  }
}

function priorityCodes() {
  const out = new Set();
  if (S.focus !== null) out.add(S.stocks[S.focus].code);
  for (const m of MARKETS) {
    Object.entries(S.books[m].positions).forEach(([c, p]) => { if (p.qty > 0) out.add(c); });
    S.books[m].pending.forEach(o => out.add(o.code));
  }
  S.basket.forEach(c => out.add(c));
  const rule = currentRule();
  if (rule) rule.hits.forEach(h => out.add(h.code));
  S.rules.forEach(r => r.hits.forEach(h => out.add(h.code)));
  return [...out];
}

async function fetchFull(codes, sourceNode = 1) {
  try {
    const text = await getText('proxy/qt?q=' + codes.join(','));
    const { quotes, rejected } = Core.parseFull(text);
    S.counters.rejected += rejected;
    const now = Date.now();
    firePulse(nodes.left[sourceNode], 0.42);
    for (const q of Object.values(quotes)) {
      S.full.set(q.code, q);
      S.counters.fullQuotes++;
      const i = S.codeIndex.get(q.code);
      if (i !== undefined) {
        const changed = S.seen[i] === 1 && S.price[i] !== Math.fround(q.price);
        S.price[i] = q.price; S.pct[i] = q.pct; S.prev[i] = q.prev; S.amount[i] = q.amount * FX[q.market]; S.seen[i] = 1;
        if (S.mode !== 'replay') scene.setChange(i, q.stale ? -99 : q.pct);
        scene.reveal(i, 0);
        if (changed) { scene.flare(i, 0.4); noteRuleUpdate(q.code); scene.flashDialStock(i); }
      }
    }
    settleOrders(quotes, now);
    if (S.sheet && S.sheet.kind === 'stock') refreshStockSheet();
    else if (S.sheet && S.sheet.kind === 'basket' && !S.sheet.busy) refreshBasketSheet();
    else if (S.sheet && S.sheet.kind === 'account') refreshAccountSheet();
    return quotes;
  } catch (e) { flashNode(nodes.left[sourceNode], true); return {}; }
}

async function fetchIndices() {
  try {
    const text = await getText('proxy/qt?q=' + [...INDEX_CODES, ...Object.values(FRESH_PROBE)].join(','));
    const { quotes } = Core.parseFull(text);
    Object.assign(S.indices, quotes);
    renderIndices();
    updateModeText();
  } catch (e) { /* 指数条保持上次的值 */ }
}

async function loadMinute() {
  const { code, minutes } = MARKET_INDEX[focusMarket()];
  if (S.minute.code !== code) { S.minute.code = code; S.minute.points = []; S.minute.prev = 0; S.minute.total = minutes; }
  try {
    const json = JSON.parse(await getText('proxy/minute?code=' + code));
    const node = json.data && json.data[code];
    const lines = node && node.data && node.data.data;
    if (S.minute.code !== code || !lines || !lines.length) return;
    S.minute.date = node.data.date || '';
    S.minute.points = lines.map(l => { const f = l.split(' '); return { t: f[0], p: Number(f[1]) }; }).filter(x => x.p > 0);
    S.counters.minute = S.minute.points.length;
    const qt = node.qt && node.qt[code];
    if (qt) S.minute.prev = Number(qt[4]) || 0;
    firePulse(nodes.left[2], 0.42);
  } catch (e) { flashNode(nodes.left[2], true); }
}

async function loadRules() {
  try {
    const data = await getJson('data/rules.json');
    S.rules = data.rules || [];
    S.rulesAsOf = data.asOf;
    S.tracking = data.tracking || [];
    S.trackingSince = data.trackingSince || null;
    const preferred = S.rules.find(r => r.backtests && r.backtests.A) || S.rules[0];
    S.ruleId = preferred ? preferred.id : null;
    S.ruleCodes = new Map();
    S.rules.forEach(r => r.hits.forEach(h => { if (!S.ruleCodes.has(h.code)) S.ruleCodes.set(h.code, []); S.ruleCodes.get(h.code).push(r.id); }));
    buildNodes();
    refreshAccount();
  } catch (e) { S.rules = []; S.rulesMissing = true; }   // 规则数据是可选的，没有就不显示信号
}

async function loadHistory() {
  try {
    const meta = await getJson('data/history.json');
    const res = await fetch('data/history.bin', { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();
    S.counters.bytes += buffer.byteLength;
    const matrix = new Int16Array(buffer);
    // 文件行序按名单，名单变了就对不上，这时宁可不回放
    if (meta.rows !== S.n || matrix.length !== meta.rows * meta.cols) throw new Error('shape');
    S.history = { days: meta.days, rows: meta.rows, cols: meta.cols, matrix, indices: meta.indices || {}, dayAmount: meta.dayAmount || [] };
    firePulse(nodes.left[3], 0.42);
  } catch (e) { S.history = null; }
}

/**
 * 这个指数的日波动率，从回放数据算，画波动锥用。
 * Daily volatility of this index from the replay data, for the volatility cone.
 */
function indexSigma(code) {
  if (S.sigmas[code] !== undefined) return S.sigmas[code];
  const close = (S.history && S.history.indices[code] || {}).close || [];
  const rets = [];
  for (let k = 1; k < close.length; k++) if (close[k] > 0 && close[k - 1] > 0) rets.push(close[k] / close[k - 1] - 1);
  if (rets.length <= 5) return 0.009;
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  S.sigmas[code] = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  return S.sigmas[code];
}

/**
 * 因子 IC：分片算，不卡界面。
 * Factor IC, computed in small slices so the UI does not stall.
 */
function startCalculations() {
  if (!S.history) return;
  const { matrix, rows, cols } = S.history;
  let day = 20;
  const step = () => {
    if (day + 5 >= cols) { S.ic.done = true; S.ic.summary = { reversal5: Core.icSummary(S.ic.series.reversal5), momentum20: Core.icSummary(S.ic.series.momentum20), vol20: Core.icSummary(S.ic.series.vol20) }; renderPipeline(); return; }
    const r = Core.factorICDay(matrix, rows, cols, day, 5);
    if (r) { S.ic.series.reversal5.push(r.reversal5); S.ic.series.momentum20.push(r.momentum20); S.ic.series.vol20.push(r.vol20); }
    day++;
    setTimeout(step, 8);
  };
  setTimeout(step, 400);
}

// ---------------------------------------------------------------- 收盘：真实历史回放 / After the close: real history replay

function startReplayDay() {
  const h = S.history;
  if (!h) return;
  const r = S.replay;
  r.started = clockNow();
  r.sweep = 0;
  r.last = 0;
  r.target = r.day;
  const col = r.day;
  const pcts = new Array(h.rows);
  let top = [];
  for (let i = 0; i < h.rows; i++) {
    const raw = h.matrix[i * h.cols + col];
    pcts[i] = raw === -32768 ? null : raw / 100;
  }
  S.dayPcts = pcts;
  S.breadth = viewBreadth(pcts);
  updateMovers();
  scene.tilt = S.breadth.tilt;
  scene.heat = clamp(0.32 + Math.abs(S.breadth.mean) * 0.45, 0.25, 1);
  scene.flowSpeed = 0.045 + Math.min(0.13, Math.abs(S.breadth.mean) * 0.05);
  S.counters.batches++;
  S.counters.rows += h.rows;
  // 当天涨跌最大的股票：彗星和滚动条用
  for (let i = 0; i < h.rows; i += 1) if (pcts[i] !== null && Math.abs(pcts[i]) >= 7 && inView(i)) top.push(i);
  top.sort((a, b) => (S.stocks[b].amount || 0) - (S.stocks[a].amount || 0));
  top = top.slice(0, 26);
  S.dayTop = top;
  firePulse(nodes.left[3], 0.4);
  top.slice(0, 10).forEach((i, k) => {
    scene.coreComet(i, Core.changeColor(pcts[i]).map(v => v * 1.15), 0.4 + k * 0.05, 0.7);
    scene.flare(i, 1.05 + k * 0.05);
  });
  top.slice(0, 5).forEach(i => feedReplay(i, pcts[i]));
  // 每套规则按当天收盘重新估值：节点上的累计收益是回测记录，脉冲从星云流向规则
  S.ruleReturns = {};
  S.rules.forEach((candidate, k) => {
    const candidateTest = testFor(candidate);
    const daily = candidateTest && candidateTest.daily;
    const point = daily && lastOnOrBefore(daily, h.days[col]);
    if (point) { S.ruleReturns[candidate.id] = (point[1] - 1) * 100; firePulse(nodes.right[k], 0.55, true); }
  });
  pipelinePulse();
  // 当天规则的真实成交（回测记录）
  const rule = currentRule();
  const test = testFor(rule);
  if (test) {
    const date = h.days[col];
    const events = (test.events || []).filter(e => e[0] === date);
    const ruleNode = nodes.right[S.rules.indexOf(rule)];
    events.slice(0, 10).forEach((e, k) => {
      const i = S.codeIndex.get(e[2]);
      if (i !== undefined && ruleNode) {
        scene.coreComet(i, e[1] === 'buy' ? [1.3, 0.95, 0.4] : [0.45, 0.85, 1.3], 0.2 + k * 0.08, 0.8);
        scene.flare(i, 1.1 + k * 0.08);
        firePulse(ruleNode, 0.5, true);
      }
      S.eventsSeen = (S.eventsSeen || 0) + 1;
      feedText(`<time>${esc(date.slice(5))}</time><span class="name">${esc(rule.title)}</span>模拟${e[1] === 'buy' ? '买入' : '卖出'}<span class="name">${esc(e[3])}</span>${commas(e[4])} 股 @ ${Core.fixed(e[5])}`);
    });
    if (events.length) hitStage('成交');
  }
  hitStage('采集');
  refreshAccount();
  renderIndices();
  renderMarket();
  renderPipeline();
  const fill = $('tapeFill');
  if (fill) fill.style.width = ((col + 1) / h.cols * 100).toFixed(1) + '%';
  $('replayText').textContent = `${h.days[col]} · ${col + 1}/${h.cols}`;
}

/**
 * 回放的颜色变化：沿经度扫过去，不是一下子全变。
 * Replay color changes sweep along longitude instead of switching all at once.
 */
function replayFrame(now) {
  const r = S.replay;
  if (S.mode !== 'replay' || !S.history || r.target === null) return;
  const elapsed = now - r.started;
  const sweep = clamp(elapsed / (REPLAY_DAY_MS * 0.62), 0, 1);
  const upto = Math.floor(sweep * S.n);
  if (upto > r.sweep) {
    for (let k = r.sweep; k < upto; k++) {
      const i = S.sweepOrder[k];
      const p = S.dayPcts[i];
      S.shownPct[i] = p === null ? NaN : p;
      scene.setChange(i, p);
      scene.reveal(i, 0);
    }
    r.sweep = upto;
    if (upto >= S.n && r.last === 0) { r.last = 1; updateRays(); }
  }
  if (r.playing && elapsed >= REPLAY_DAY_MS) {
    r.day = (r.day + 1) % S.history.cols;
    startReplayDay();
  }
}

// ---------------------------------------------------------------- 账户 / Account

const currentRule = () => S.rules.find(r => r.id === S.ruleId) || null;

/**
 * 回放时显示规则的回测净值；实时、收盘显示用户自己的模拟账户。
 * During replay show the rule's backtest equity; when live or closed, show the user's own simulated account.
 */
function refreshAccount() {
  const label = $('acctLabel'), sub = $('acctSub');
  const rule = currentRule();
  const test = testFor(rule);
  const market = accountMarket();
  const account = ACCOUNTS.find(a => a.market === market);
  S.acctUnit = account.unit;
  if (S.mode === 'replay' && test && S.history) {
    const date = S.history.days[S.replay.day];
    const point = lastOnOrBefore(test.daily, date);
    const bench = lastOnOrBefore(test.benchmarkDaily, date);
    const value = point ? point[1] : 1;
    setAcct(value * 1000000);
    S.acctBase = 1000000;
    label.textContent = `规则回测净值 · ${rule.title} · ${date}`;
    const excess = point && bench ? (point[1] / bench[1] - 1) * 100 : null;
    sub.innerHTML = `累计 <b class="${cls(value - 1)}">${Core.signed((value - 1) * 100)}%</b> · 相对${BENCH_NAME[testKey()]} <b class="${cls(excess)}">${Core.signed(excess)}%</b>`;
    S.acctReturn = (value - 1) * 100;
  } else {
    const book = S.books[market];
    const quotes = Object.fromEntries(S.full);
    const e = Sim.equity(book, quotes);
    setAcct(e.total / 100);
    S.acctBase = book.capital / 100;
    const hasAny = Object.values(book.positions).some(p => p.qty > 0);
    label.textContent = (S.mode === 'closed' ? '我的模拟账户 · 已收盘' : '我的模拟账户') + (market === 'CN' ? '' : ' · ' + account.label);
    // 不同币种的账户单独算，不相加；有动静时跟在后面显示
    const tails = ACCOUNTS.filter(a => a.market !== market).map(a => {
      const other = S.books[a.market];
      return Object.values(other.positions).some(p => p.qty > 0) || other.pending.length
        ? ` · ${a.label} <b>${a.unit}${commas(Sim.equity(other, quotes).total / 100, 0)}</b>` : '';
    }).join('');
    sub.innerHTML = (hasAny ? `今日 <b class="${cls(e.dayPnl)}">${Core.signed(e.dayPnl / 100)}</b> · 累计 <b class="${cls(e.pnl)}">${Core.signed(e.pnl / book.capital * 100)}%</b>` : (tails ? `${account.label}没有持仓` : market === 'US' ? '点星云里的任一只股票，模拟成交' : '点星云里的任一只股票，用真实盘口模拟成交')) + tails;
    S.acctReturn = e.pnl / book.capital * 100;
  }
}
function lastOnOrBefore(series, date) {
  if (!series || !series.length) return null;
  let found = null;
  for (const p of series) { if (p[0] <= date) found = p; else break; }
  return found;
}
function setAcct(value) {
  S.acctPrev = S.acctShown || value;
  S.acctTarget = value;
  S.acctAt = clockNow();
}
function acctFrame(now) {
  if (!S.acctTarget) return;
  const k = clamp((now - S.acctAt) / 900, 0, 1);
  const e = 1 - (1 - k) ** 3;
  S.acctShown = S.acctPrev + (S.acctTarget - S.acctPrev) * e;
  const el = $('acctBig');
  el.textContent = (S.acctUnit || '¥') + commas(S.acctShown, 2);
  el.classList.toggle('neg', S.acctTarget < (S.acctBase || 1000000));
}

function settleOrders(quotes, now) {
  let changed = false;
  for (const m of MARKETS) {
    const inMarket = Object.fromEntries(Object.entries(quotes).filter(([c]) => Core.marketOf(c) === m));
    // 这批报价里最新的交易日；停牌股的日期可能更早，不能用它翻账本
    const day = Object.values(inMarket).reduce((latest, q) => { const d = q.at && !q.stale ? Core.marketDay(m, q.at) : ''; return d > latest ? d : latest; }, '');
    if (day > S.books[m].day) {
      // 今日盈亏的基准是昨收：今天的报价用它的昨收估值，还停在上一个交易日的报价就用它的现价。
      // 不能直接用新价，否则下午才打开时，上午的涨跌全被算进“昨天”
      const closes = {};
      S.full.forEach((q, code) => {
        closes[code] = q.at && Core.marketDay(Core.marketOf(code), q.at) === day ? Object.assign({}, q, { price: q.prev }) : q;
      });
      const e = Sim.equity(S.books[m], closes);
      S.books[m] = Sim.rollDay(S.books[m], day, e.total);
      changed = true;
    }
    if (S.books[m].pending.length) {
      const before = S.books[m].pending.length;
      const out = Sim.settlePending(S.books[m], inMarket, now, market => Core.sessionOpen(market, now));
      S.books[m] = out.book;
      out.results.forEach(r => {
        if (r.trade) { feedText(`<span class="name">${esc(r.trade.name)}</span>挂单按开盘价成交 ${commas(r.trade.qty)} 股 @ ${Core.fixed(r.trade.price)}`); hitStage('成交'); }
        else feedText(`<span class="name">${esc(r.order.name)}</span>${esc(r.reject)}`);
      });
      if (out.book.pending.length !== before) changed = true;
    }
  }
  if (changed) saveBooks();
  refreshAccount();
}

// ---------------------------------------------------------------- 顶部和面板 / Header and panels

function renderIndices() {
  const box = $('indices');
  const replay = S.mode === 'replay' && S.history;
  // 回放只有基准指数的历史，其他指数不占位
  box.innerHTML = INDEX_VIEW[S.view].filter(code => !replay || S.history.indices[code]).map(code => {
    const name = INDEX_NAMES[code];
    let price = null, pct = null;
    if (replay) {
      const series = S.history.indices[code];
      if (series) { const k = S.replay.day; price = series.close[k] || null; pct = series.prev[k] > 0 && price ? (price / series.prev[k] - 1) * 100 : null; }
    } else if (S.indices[code]) { price = S.indices[code].price; pct = S.indices[code].pct; }
    return `<div><span>${name}</span><b>${price ? Core.fixed(price, price > 10000 ? 0 : 2) : '—'}</b><em class="${cls(pct)}">${Core.signed(pct)}%</em></div>`;
  }).join('');
}

/**
 * 宽屏右侧：涨跌榜、行业涨跌、研究结论。窄屏上没有这一栏（display:none），不用算。
 * Right column on wide screens: movers, industry moves, rule results. Hidden on narrow screens (display:none), so skip the work there.
 */
function renderSide() {
  if (window.innerWidth < 900) return;
  const box = $('side');
  const replay = S.mode === 'replay' && S.history;
  const when = replay ? S.history.days[S.replay.day] : '最新';
  const mover = r => `<button class="mover" data-stock="${r[0]}"><span class="nm">${esc(S.stocks[r[0]].name)}</span><b class="${cls(r[1])}">${Core.signed(r[1])}%</b></button>`;
  const movers = S.movers
    ? `<div class="side-card"><h4>涨跌榜<span>${esc(when)} · 成交额约 5000 万元以上</span></h4><div class="movers"><div>${S.movers.gain.map(mover).join('')}</div><div>${S.movers.loss.map(mover).join('')}</div></div></div>`
    : '';
  // “港股其他”只是没分类的那一堆，不算行业。美股只有 12 个大类，成交额都很大，“全部”时只放 4 个，不然看不到 A 股、港股的行业
  const named = (S.topIndustries || []).filter(s => !s.name.endsWith('其他'));
  const inds = S.view === 'ALL' ? [...named.filter(s => !s.name.startsWith('美股')).slice(0, 8), ...named.filter(s => s.name.startsWith('美股')).slice(0, 4)] : named.slice(0, 12);
  const widest = Math.max(1, ...inds.map(s => Math.abs(s.pct || 0)));
  const industries = inds.length
    ? `<div class="side-card"><h4>行业涨跌<span>成交额最大的 12 个</span></h4>${inds.map(s => {
      const w = Math.abs(s.pct || 0) / widest * 50;
      const bar = s.pct >= 0 ? `left:50%;width:${w.toFixed(1)}%;background:var(--up)` : `right:50%;width:${w.toFixed(1)}%;background:var(--down)`;
      return `<div class="ind-row"><span class="nm">${esc(s.name)}</span><span class="ind-bar"><i style="${bar}"></i></span><b class="${cls(s.pct)}">${Core.signed(s.pct, 1)}%</b></div>`;
    }).join('')}</div>`
    : '';
  const rules = S.rules.length
    ? `<div class="side-card"><h4>研究结论<span>${replay ? '回测累计收益' : '今天符合条件的股票'}</span></h4>${S.rules.map(r => {
      const cum = replay && S.ruleReturns ? S.ruleReturns[r.id] : undefined;
      return `<button class="rule-row" data-rule="${esc(r.id)}"><span class="nm">${esc(r.title)}</span><small>${esc(r.tagline)}</small><b class="${cum === undefined ? '' : cls(cum)}">${cum === undefined ? ruleHits(r).length + ' 只' : Core.signed(cum, 1) + '%'}</b></button>`;
    }).join('')}</div>`
    : '';
  box.innerHTML = movers + industries + rules;
}
$('side').addEventListener('click', e => {
  const stock = e.target.closest('[data-stock]');
  if (stock) { openStock(Number(stock.dataset.stock)); return; }
  const rule = e.target.closest('[data-rule]');
  if (rule) openSheet({ kind: 'stage', stage: '信号', rule: rule.dataset.rule });
});

function renderMarket() {
  const b = S.breadth;
  const market = accountMarket();
  const amount = S.mode === 'replay' && S.history ? (market === 'CN' ? S.history.dayAmount[S.replay.day] : null) : (S.amountBy || {})[market];
  const limits = market === 'CN' ? `<span>${S.mode === 'replay' ? '约 ' : ''}涨停/跌停</span><b><span class="up">${commas(b.limitUp)}</span>/<span class="down">${commas(b.limitDown)}</span></b>` : '';
  const unit = { CN: '', HK: 'HK$', US: '$' }[market];
  $('mkt').innerHTML = `<span>上涨</span><b class="up">${commas(b.up)}</b><span>下跌</span><b class="down">${commas(b.down)}</b>`
    + limits + (amount ? `<span>${MARKET_NAME[market]}成交</span><b>${unit}${Core.money(amount)}</b>` : '');
}

const STAGES = [
  ['采集', () => commas(S.counters.rows > 99999 ? S.counters.rows / 1000 : S.counters.rows) + (S.counters.rows > 99999 ? 'k' : '')],
  ['清洗', () => { const bad = S.counters.rejected + S.counters.stale; return bad ? `剔${commas(bad)}` : '0 异常'; }],
  ['因子', () => { const v = S.ic.summary && S.ic.summary.reversal5; return v ? 'IC' + Core.signed(v.mean, 3).replace('0.', '.') : S.history ? '计算中' : '—'; }],
  ['信号', () => (S.rules.length ? commas(S.rules.reduce((a, r) => a + ruleHits(r).length, 0)) + ' 只' : '—')],
  ['组合', () => MARKETS.reduce((n, m) => n + Object.values(S.books[m].positions).filter(p => p.qty > 0).length, 0) + ' 只'],
  ['成交', () => { const n = MARKETS.reduce((c, m) => c + S.books[m].trades.length, 0); return S.mode === 'replay' && testFor(currentRule()) ? commas(S.eventsSeen || 0) + ' 笔' : n + ' 笔'; }],
  ['净值', () => (S.acctReturn === undefined ? '—' : Core.signed(S.acctReturn, 1) + '%')],
];
function buildPipeline() {
  const box = $('pipeline');
  box.innerHTML = STAGES.map(([name]) => `<button class="stage-chip" data-stage="${name}"><b>${name}</b><span>—</span></button>`).join('');
  box.addEventListener('click', e => { const c = e.target.closest('[data-stage]'); if (c) openStage(c.dataset.stage); });
  renderPipeline();
}
function renderPipeline() {
  document.querySelectorAll('.stage-chip').forEach((chip, k) => { chip.querySelector('span').textContent = STAGES[k][1](); });
}
const stageTimers = {};
function hitStage(name) {
  const chip = document.querySelector(`[data-stage="${name}"]`);
  if (!chip) return;
  chip.classList.add('hit');
  clearTimeout(stageTimers[name]);
  stageTimers[name] = setTimeout(() => chip.classList.remove('hit'), 320);
}

function setupPanelCanvas(id) {
  const c = $(id);
  const r = c.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return { g, w: r.width, h: r.height };
}

function drawBreadth() {
  const { g, w, h } = setupPanelCanvas('pBreadth');
  const b = S.breadth.bins;
  const max = Math.max(...b, 1);
  const pad = 5, base = h - 13, top = 18;
  const bw = (w - pad * 2) / b.length;
  b.forEach((v, k) => {
    const height = Math.pow(v / max, 0.62) * (base - top);
    const [r0, g0, b0] = Core.changeColor(k === 10 ? 0 : k - 10);
    const color = `rgb(${r0 * 255 | 0},${g0 * 255 | 0},${b0 * 255 | 0})`;
    const x = pad + k * bw;
    const gradient = g.createLinearGradient(0, base - height, 0, base);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, `rgba(${r0 * 255 | 0},${g0 * 255 | 0},${b0 * 255 | 0},.18)`);
    g.fillStyle = gradient;
    g.fillRect(x + 0.6, base - height, Math.max(1, bw - 1.2), height);
  });
  g.fillStyle = '#7d7a73';
  g.font = '9px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  g.textAlign = 'left'; g.fillText('-10%', pad, h - 3);
  g.textAlign = 'center'; g.fillText('0', w / 2, h - 3);
  g.textAlign = 'right'; g.fillText('+10%', w - pad, h - 3);
  g.fillStyle = S.breadth.mean >= 0 ? '#FF7A6B' : '#2BD68A';
  g.font = '500 10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  g.textAlign = 'right';
  g.fillText('均 ' + Core.signed(S.breadth.mean) + '%', w - 5, 12);
}

let ball = { x: 0, v: 0 };
function drawWell(dt) {
  const { g, w, h } = setupPanelCanvas('pWell');
  const tilt = S.breadth.tilt || 0;
  const hField = tilt * 0.7;
  const V = x => x ** 4 / 4 - x ** 2 / 2 - hField * x;
  const xs = [];
  let vmin = 1e9, vmax = -1e9;
  for (let k = 0; k <= 60; k++) { const x = -1.75 + 3.5 * k / 60; const v = V(x); xs.push([x, v]); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
  const left = 5, right = w - 5, top = 20, bottom = h - 8;
  const px = x => left + (x + 1.75) / 3.5 * (right - left);
  const py = v => bottom - (v - vmin) / Math.max(vmax - vmin, 0.01) * (bottom - top);
  const fill = g.createLinearGradient(left, 0, right, 0);
  fill.addColorStop(0, 'rgba(43,214,138,.28)');
  fill.addColorStop(0.5, 'rgba(255,255,255,.02)');
  fill.addColorStop(1, 'rgba(255,77,79,.3)');
  g.beginPath();
  xs.forEach(([x, v], k) => (k ? g.lineTo(px(x), py(v)) : g.moveTo(px(x), py(v))));
  g.lineTo(right, bottom + 8); g.lineTo(left, bottom + 8); g.closePath();
  g.fillStyle = fill; g.fill();
  g.beginPath();
  xs.forEach(([x, v], k) => (k ? g.lineTo(px(x), py(v)) : g.moveTo(px(x), py(v))));
  g.strokeStyle = 'rgba(245,240,228,.9)'; g.lineWidth = 1.3; g.shadowColor = 'rgba(255,255,255,.45)'; g.shadowBlur = 5; g.stroke(); g.shadowBlur = 0;
  // 小球在势阱里滚：受势能梯度和阻尼，停在真实涨跌偏斜决定的最低点
  const force = -(ball.x ** 3 - ball.x - hField);
  ball.v = (ball.v + force * dt * 6) * Math.exp(-dt * 2.6);
  ball.x = clamp(ball.x + ball.v * dt * 6, -1.7, 1.7);
  const bx = px(ball.x), by = py(V(ball.x));
  g.beginPath(); g.arc(bx, by - 3, 3.4, 0, 7);
  g.fillStyle = '#FFD46B'; g.shadowColor = '#FFB347'; g.shadowBlur = 10; g.fill(); g.shadowBlur = 0;
  g.font = '500 9.5px ' + getComputedStyle(document.body).getPropertyValue('--mono');
  g.textAlign = 'right';
  g.fillStyle = tilt >= 0 ? '#FF7A6B' : '#2BD68A';
  // 势阱合并的临界点 |h| = 2/(3√3) ≈ 0.385
  g.fillText(Math.abs(hField) > 0.385 ? (tilt >= 0 ? '一边倒·多' : '一边倒·空') : (tilt >= 0 ? '拉锯偏多' : '拉锯偏空'), w - 5, 12);
}

function drawFunnel() {
  const { g, w, h } = setupPanelCanvas('pFunnel');
  const replay = S.mode === 'replay' && S.history;
  const focus = MARKET_INDEX[focusMarket()];
  let pts = [], total = focus.minutes, sigma = indexSigma(focus.code), title = '波动漏斗';
  if (replay) {
    const close = (S.history.indices[focus.code] || {}).close || [];
    const start = close.find(v => v > 0) || 1;
    pts = close.slice(0, S.replay.day + 1).map(v => (v > 0 ? v / start - 1 : null)).filter(v => v !== null);
    total = S.history.cols - 1;
    title = focus.name + ' 路径';
  } else if (S.minute.points.length && S.minute.code === focus.code) {
    const base = S.minute.prev || S.minute.points[0].p;
    pts = S.minute.points.map(p => p.p / base - 1);
    title = focus.name + ' 分时';
  }
  if ($('funnelTitle').textContent !== title) $('funnelTitle').textContent = title;
  const left = 6, right = w - 8, cy = (h + 12) / 2;
  const scale = (h - 26) / 2 / (Math.max(sigma * Math.sqrt(replay ? total : 1) * 1.15, Math.max(0.002, ...pts.map(Math.abs))));
  const X = k => left + (k / total) * (right - left);
  const coneAt = k => sigma * Math.sqrt(Math.max(k / (replay ? 1 : total), 0));
  // 波动锥：历史波动率按 √t 放大
  const grad = g.createLinearGradient(left, 0, right, 0);
  grad.addColorStop(0, 'rgba(90,169,255,.02)');
  grad.addColorStop(1, 'rgba(90,169,255,.16)');
  g.beginPath();
  for (let k = 0; k <= 40; k++) { const t = k / 40 * total; const c = coneAt(t); const y = cy - c * scale; k ? g.lineTo(X(t), y) : g.moveTo(X(t), y); }
  for (let k = 40; k >= 0; k--) { const t = k / 40 * total; const c = coneAt(t); g.lineTo(X(t), cy + c * scale); }
  g.closePath(); g.fillStyle = grad; g.fill();
  g.strokeStyle = 'rgba(120,180,255,.35)'; g.lineWidth = 0.8; g.stroke();
  // 零线
  g.strokeStyle = 'rgba(255,255,255,.1)'; g.beginPath(); g.moveTo(left, cy); g.lineTo(right, cy); g.stroke();
  // 收口圆环：最新一点的波动范围
  if (pts.length) {
    const lastK = pts.length - 1;
    const lastX = X(lastK), lastY = cy - pts[lastK] * scale;
    const c = coneAt(lastK) * scale;
    g.strokeStyle = 'rgba(235,240,255,.45)';
    g.beginPath(); g.ellipse(lastX, cy, Math.max(2, c * 0.2), Math.max(3, c), 0, 0, 7); g.stroke();
    g.beginPath();
    pts.forEach((v, k) => (k ? g.lineTo(X(k), cy - v * scale) : g.moveTo(X(k), cy - v * scale)));
    const up = pts[lastK] >= 0;
    g.strokeStyle = up ? '#FF6B5E' : '#2BD68A'; g.lineWidth = 1.3; g.shadowColor = g.strokeStyle; g.shadowBlur = 6; g.stroke(); g.shadowBlur = 0;
    g.beginPath(); g.arc(lastX, lastY, 2.4, 0, 7); g.fillStyle = '#fff'; g.shadowColor = '#fff'; g.shadowBlur = 8; g.fill(); g.shadowBlur = 0;
    g.fillStyle = up ? '#FF7A6B' : '#2BD68A';
    g.font = '500 10px ' + getComputedStyle(document.body).getPropertyValue('--mono');
    g.textAlign = 'right';
    g.fillText(Core.signed(pts[lastK] * 100) + '%', w - 5, 12);
  }
}

// ---------------------------------------------------------------- 滚动条 / Ticker

const feedQueue = [];
function feedStock(i) {
  const s = S.stocks[i];
  const now = Date.now();
  const open = m => S.forceLive || Core.sessionLive(m, now, (S.indices[MARKET_INDEX[m].code] || {}).at);
  const live = open(s.market);
  if (!live && MARKETS.some(open)) return;   // 有市场在交易时只滚它的；休市的报价不能打上现在的时间
  feedText(`<time>${live ? Core.clock(now).slice(0, 8) : '休市'}</time><span class="name">${esc(s.name)}</span><span>${Core.fixed(S.price[i])}</span> <span class="${cls(S.pct[i])}">${Core.signed(S.pct[i])}%</span>`);
}
function feedReplay(i, pct) {
  feedText(`<time>${esc(S.history.days[S.replay.day].slice(5))}</time><span class="name">${esc(S.stocks[i].name)}</span><span class="${cls(pct)}">${Core.signed(pct)}%</span>`);
}
function feedText(html) { if (feedQueue.length < 60) feedQueue.push(html); }
let feedOffset = 0;
function feedFrame(dt) {
  const track = $('track');
  const wrapWidth = track.parentElement.clientWidth;
  const trackRight = track.scrollWidth - feedOffset;
  if (feedQueue.length && trackRight < wrapWidth + 60) {
    const span = document.createElement('span');
    span.innerHTML = feedQueue.shift();
    track.appendChild(span);
  }
  const speed = 34 + Math.min(70, feedQueue.length * 3);
  if (track.scrollWidth - feedOffset > wrapWidth * 0.6) feedOffset += dt * speed;
  const first = track.firstElementChild;
  if (first && first.offsetLeft + first.offsetWidth < feedOffset) {
    const next = first.nextElementSibling;
    const shift = next ? next.offsetLeft : first.offsetLeft + first.offsetWidth;
    track.removeChild(first);
    feedOffset = Math.max(0, feedOffset - shift);
  }
  track.style.transform = `translate3d(${-feedOffset.toFixed(1)}px,0,0)`;
}

// ---------------------------------------------------------------- 覆盖层：节点、连线、脉冲 / Overlay: nodes, cables, pulses

const LEFT_NODES = [
  { name: '实时行情', sub: () => S.mode === 'replay' ? '收盘' : `${S.counters.lastLatency || '—'} ms` },
  { name: '五档盘口', sub: () => `${commas(S.full.size)} 只` },
  { name: '指数分时', sub: () => `${commas(S.counters.minute)} 点` },
  { name: '盘后全市场', sub: () => (S.history ? `${S.history.cols} 日` : '—') },
  { name: '行业财务', sub: () => `${S.industries.length} 业` },
  { name: '复权日线', sub: () => (S.rulesAsOf ? S.rulesAsOf.slice(5) : '—') },
];

function layout() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  scene.resize(w, h, window.devicePixelRatio || 1);
  layoutStage();
}

function layoutStage() {
  const w = window.innerWidth, h = window.innerHeight;
  const stage = $('stage').getBoundingClientRect();
  const r = stageRadius(stage) * (S.zoom || 1);
  layoutInfo = { w, h, cx: stage.left + stage.width / 2, cy: stage.top + stage.height / 2, r, stage };
  applyStageFrame(true);
  buildNodes();
}

/**
 * 整个星系从正面完整展示，星盘外缘是 1.32 个单位（两圈涨跌榜标签）。外盘很薄，星云尽量大。
 * Show the whole galaxy face-on; the dial's outer edge is at 1.32 units (two rings of mover labels). The dial is thin so the nebula can be as large as possible.
 */
const DIAL_EXTENT = 1.335;
function stageRadius(stage) { return Math.min(stage.width / 2 / DIAL_EXTENT, stage.height / 2 / DIAL_EXTENT); }

function applyStageFrame(instant) {
  const { cx, cy, r, w, h } = layoutInfo;
  if (S.sheet) {
    const rect = $('sheet').getBoundingClientRect();
    const wide = w >= 900;
    if (wide) {
      // 宽屏：左边 300 像素是指数和账户，右边是抽屉，星云放在中间，上下不超出舞台。
      // 抽屉还在滑入时位置不准，用它的宽度算
      const room = Math.max(200, w - rect.width - 300);
      const stage = layoutInfo.stage;
      scene.setFrame(300 + room / 2, stage.top + stage.height / 2, Math.min(room / 2 / DIAL_EXTENT - 6, stage.height / 2 / DIAL_EXTENT), instant);
    } else {
      // 指数和账户在抽屉打开时淡出，星云收到顶栏和抽屉之间：核心缩小，让位给明细
      const top = document.querySelector('.top').getBoundingClientRect().bottom;
      const free = Math.max(120, h - rect.height - top);
      scene.setFrame(w / 2, top + free / 2, Math.min(free / 2 / DIAL_EXTENT - 2, w / 2 / DIAL_EXTENT), instant);
    }
  } else scene.setFrame(cx, cy, r, instant);
}

function buildNodes() {
  const { stage, cx, cy, r } = layoutInfo;
  if (!stage) return;
  // 星盘整圈留在屏幕里，节点放到四个角的空位：左边数据接口，右边规则，一半在上一半在下
  const rowY = (k, count) => {
    const upper = Math.ceil(count / 2);
    return k < upper ? stage.top + 6 + k * 38 : stage.bottom - 42 - (count - 1 - k) * 38;
  };
  // 每个接口在核心上有自己的位置：最靠上的节点接核心偏上的地方，线不交叉
  const socketAngle = (side, k, count) => {
    const upper = Math.ceil(count / 2);
    const lower = count - upper;
    const top = k < upper;
    const j = top ? k : count - 1 - k, span = top ? upper : lower;
    const offset = (25 + (span > 1 ? j / (span - 1) : 0.5) * 50) * Math.PI / 180;
    const fromUp = side < 0 ? Math.PI / 2 + offset : Math.PI / 2 - offset;
    return top ? -fromUp : fromUp;
  };
  nodes.left = LEFT_NODES.map((n, k) => {
    const y = rowY(k, LEFT_NODES.length), x = stage.left + 15;
    return Object.assign(nodes.left[k] || { glow: 0, load: 0, pulses: [] }, { x, y, angle: socketAngle(-1, k, LEFT_NODES.length), name: n.name, sub: n.sub, side: -1, c1: { x: x + 34, y }, stage: '采集' });
  });
  const rules = S.rules.length ? S.rules : [];
  const count = Math.max(rules.length, 1);
  nodes.right = rules.map((rule, k) => {
    const y = rowY(k, count), x = stage.right - 15;
    // 回放时显示这套规则到当天的累计收益（回测），其他时候显示今天命中几只
    const sub = () => {
      const cum = S.mode === 'replay' && S.ruleReturns ? S.ruleReturns[rule.id] : undefined;
      return cum === undefined ? `${ruleHits(rule).length} 只` : Core.signed(cum, 1) + '%';
    };
    return Object.assign(nodes.right[k] || { glow: 0, load: 0, pulses: [] }, { x, y, angle: socketAngle(1, k, count), name: rule.title, sub, side: 1, c1: { x: x - 34, y }, rule: rule.id });
  });
  const frame = scene.frameCur || { cx, cy, radius: r };
  [...nodes.left, ...nodes.right].forEach(n => placeCable(n, frame));
  const chips = [...document.querySelectorAll('.stage-chip')].map(c => { const b = c.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top, w: b.width, h: b.height }; });
  layoutInfo.chips = chips;
}

/**
 * 接口线：从节点出来，到外盘附近转成径向，一直接到核心表面。跟着星云的位置和大小走，每帧算一次。
 * Cable: leaves the node, turns radial near the dial and runs to the core surface. Follows the nebula's position and size, recomputed every frame.
 */
function placeCable(n, frame) {
  const ca = Math.cos(n.angle), sa = Math.sin(n.angle);
  n.gate = { x: frame.cx + ca * frame.radius * CORE_SOCKET, y: frame.cy + sa * frame.radius * CORE_SOCKET };
  n.c2 = { x: frame.cx + ca * frame.radius * 1.02, y: frame.cy + sa * frame.radius * 1.02 };
}

function bezier(n, t) {
  const u = 1 - t;
  return {
    x: u * u * u * n.x + 3 * u * u * t * n.c1.x + 3 * u * t * t * n.c2.x + t * t * t * n.gate.x,
    y: u * u * u * n.y + 3 * u * u * t * n.c1.y + 3 * u * t * t * n.c2.y + t * t * t * n.gate.y,
  };
}
function firePulse(node, duration = 0.45, reverse = false) {
  if (!node) return;
  if (node.pulses.length < 10) node.pulses.push({ t: 0, d: duration, reverse });
  node.glow = 1;
  node.load = Math.min(1, (node.load || 0) + 0.3);
  ticks.push({ x: node.x - node.side * 51, y: node.y, life: 1, side: node.side });
}
function flashNode(node, bad) { if (node) { node.glow = 1; node.bad = bad ? 1 : 0; } }
/**
 * 流程条上跑的亮点：每批真实数据一颗，从采集走到净值。
 * Dots running along the pipeline bar: one per batch of real data, from collection to equity.
 */
const pipePulses = [];
function pipelinePulse() { if (pipePulses.length < 8) pipePulses.push({ t: 0 }); }
const lastRuleUpdate = {};
function noteRuleUpdate(code) {
  const ids = S.ruleCodes && S.ruleCodes.get(code);
  if (!ids) return;
  ids.forEach(id => {
    const k = S.rules.findIndex(r => r.id === id);
    const now = performance.now();
    if (k >= 0 && nodes.right[k] && now - (lastRuleUpdate[id] || 0) > 350) { lastRuleUpdate[id] = now; firePulse(nodes.right[k], 0.5, true); hitStage('信号'); }
  });
}
const ticks = [];

function drawNode(n, g, mono) {
  const color = n.bad ? 'rgba(255,120,100,1)' : n.side < 0 ? 'rgba(180,215,255,1)' : 'rgba(255,205,120,1)';
  // 接口线：数据越密越亮。外面一层是光晕，里面一根是线芯
  const rgb = n.side < 0 ? '150,195,255' : '255,195,110';
  const cable = () => { g.beginPath(); g.moveTo(n.x, n.y); g.bezierCurveTo(n.c1.x, n.c1.y, n.c2.x, n.c2.y, n.gate.x, n.gate.y); g.stroke(); };
  g.strokeStyle = `rgba(${rgb},${0.06 + n.load * 0.12})`;
  g.lineWidth = 3.2;
  cable();
  g.strokeStyle = `rgba(${rgb},${0.36 + n.load * 0.34})`;
  g.lineWidth = 1;
  cable();
  // 接在核心上的接口：深色底座加亮芯，橙色的核心上也看得见
  g.beginPath(); g.arc(n.gate.x, n.gate.y, 3.1 + n.load * 1.2, 0, 7);
  g.fillStyle = 'rgba(6,8,12,.78)'; g.fill();
  g.beginPath(); g.arc(n.gate.x, n.gate.y, 1.7 + n.load * 1.2, 0, 7);
  g.fillStyle = `rgba(${rgb},${0.75 + n.load * 0.25})`; g.fill();
  // 节点
  g.beginPath(); g.arc(n.x, n.y, 4.6, 0, 7);
  g.fillStyle = 'rgba(6,8,12,.9)'; g.fill();
  g.strokeStyle = color; g.lineWidth = 1; g.globalAlpha = 0.55 + n.glow * 0.45; g.stroke();
  g.beginPath(); g.arc(n.x, n.y, 2 + n.glow * 0.8, 0, 7); g.fillStyle = color; g.fill();
  if (n.glow > 0.02) {
    g.beginPath(); g.arc(n.x, n.y, 5 + n.glow * 6, 0, 7);
    g.strokeStyle = color; g.globalAlpha = n.glow * 0.5; g.stroke();
  }
  g.globalAlpha = 1;
  const align = n.side < 0 ? 'left' : 'right';
  const tx = n.x + n.side * 8;
  g.textAlign = align;
  // 粒子和外盘会转到文字后面：铺一层底，保证读得清
  g.font = '500 10px system-ui,sans-serif';
  const sub = n.sub();
  const tw = Math.max(g.measureText(n.name).width, sub.length * 5.8) + 8;
  g.fillStyle = 'rgba(4,5,7,.62)';
  g.fillRect(n.side < 0 ? tx - 3 : tx - tw + 3, n.y + 7, tw, 25);
  g.fillStyle = 'rgba(240,236,226,.96)';
  g.fillText(n.name, tx, n.y + 17);
  g.font = '500 9.5px ' + mono;
  g.fillStyle = n.side < 0 ? 'rgba(160,205,255,.95)' : 'rgba(255,205,125,.98)';
  g.fillText(sub, tx, n.y + 29);
}

function overlayFrame(dt) {
  const { w, h, cx, cy } = layoutInfo;
  const g = ctx;
  g.clearRect(0, 0, w, h);
  const mono = 'ui-monospace,"Roboto Mono",Consolas,monospace';
  const frame = scene.frameCur || { cx, cy, radius: layoutInfo.r };
  const sheetOpen = !!S.sheet;
  // 星盘最外层的涨跌环：弧长 = 真实上涨、下跌家数占比；启动时是点亮进度
  const b = S.breadth;
  const total = (b.up + b.down + b.flat) || 1;
  scene.setDialBreadth(b.up / total, b.down / total, S.mode === 'boot' ? Math.max(0.0001, countSeen() / (S.n || 1)) : 0);
  scene.dialFlat = sheetOpen;

  if (!sheetOpen) {
    // 回执带：每批真实数据一道刻度，往下走
    g.globalCompositeOperation = 'lighter';
    g.lineWidth = 1;
    for (let k = ticks.length - 1; k >= 0; k--) {
      const t = ticks[k];
      t.life -= dt * 0.55;
      t.y += dt * 42;
      if (t.life <= 0 || t.y > layoutInfo.stage.bottom - 8) { ticks.splice(k, 1); continue; }
      g.strokeStyle = t.side < 0 ? `rgba(170,210,255,${t.life})` : `rgba(255,205,125,${t.life})`;
      g.beginPath(); g.moveTo(t.x - 4, t.y); g.lineTo(t.x + 4, t.y); g.stroke();
    }
    // 相位线：涨跌榜标签连到它对应的那颗粒子，粒子转到背面时淡下去。线要细，星云才是主角
    g.lineWidth = 0.6;
    for (let k = 0; k < scene.slots.length; k++) {
      const anchor = scene.dialSlotAnchor(k);
      if (!anchor) continue;
      const p = scene.project(anchor.entry.index);
      const alpha = 0.24 * clamp((p.front + 0.9) / 1.4, 0.1, 1);
      const up = anchor.entry.pct >= 0;
      g.strokeStyle = up ? `rgba(255,96,90,${alpha})` : `rgba(50,230,145,${alpha})`;
      g.beginPath(); g.moveTo(anchor.x, anchor.y); g.lineTo(p.x, p.y); g.stroke();
      g.beginPath(); g.arc(p.x, p.y, 2.6, 0, 7);
      g.strokeStyle = up ? `rgba(255,120,110,${alpha * 2.2})` : `rgba(80,240,160,${alpha * 2.2})`;
      g.stroke();
    }
    g.globalCompositeOperation = 'source-over';
    [...nodes.left, ...nodes.right].forEach(n => {
      n.glow = Math.max(0, n.glow - dt * 1.6);
      n.load = (n.load || 0) * Math.exp(-dt * 0.9);
      if (n.bad) n.bad = Math.max(0, n.bad - dt * 0.3);
      placeCable(n, frame);
      drawNode(n, g, mono);
    });
    g.globalCompositeOperation = 'lighter';
    [...nodes.left, ...nodes.right].forEach(n => {
      for (let k = n.pulses.length - 1; k >= 0; k--) {
        const p = n.pulses[k];
        p.t += dt / p.d;
        if (p.t >= 1) {
          // 数据到了核心，核心亮一下；规则那边是从核心往外走的，不算
          if (!p.reverse) scene.kick(0.1);
          n.pulses.splice(k, 1);
          continue;
        }
        const t = p.reverse ? 1 - p.t : p.t;
        for (let s = 0; s < 5; s++) {
          const tt = clamp(t - (p.reverse ? -1 : 1) * s * 0.022, 0, 1);
          const q = bezier(n, tt);
          g.beginPath(); g.arc(q.x, q.y, 2.3 - s * 0.35, 0, 7);
          g.fillStyle = n.side < 0 ? `rgba(170,215,255,${0.85 - s * 0.16})` : `rgba(255,205,120,${0.85 - s * 0.16})`;
          g.fill();
        }
      }
    });
    // 行业标签：只标成交额最大、当前转到正面的
    if (S.topIndustries) {
      g.globalCompositeOperation = 'source-over';
      let drawn = 0;
      const placed = [];
      for (const ind of S.topIndustries) {
        if (drawn >= 6) break;
        const p = scene.projectDir(ind.dir, 1.0);
        if (p.front < 0.25) continue;
        if (placed.some(q => Math.abs(q.x - p.x) < 64 && Math.abs(q.y - p.y) < 22)) continue;
        if (Math.hypot(p.x - frame.cx, p.y - frame.cy) > frame.radius * 0.95) continue;
        placed.push(p);
        drawn++;
        const alpha = clamp((p.front - 0.25) / 0.4, 0, 1);
        const text = ind.name;
        const pct = Core.signed(ind.pct) + '%';
        g.font = '500 10px system-ui,sans-serif';
        const tw = g.measureText(text).width;
        g.font = '500 9.5px ' + mono;
        const pw = g.measureText(pct).width;
        const total2 = tw + pw + 13;
        g.globalAlpha = alpha;
        g.fillStyle = 'rgba(5,6,9,.78)';
        g.beginPath();
        if (g.roundRect) g.roundRect(p.x - total2 / 2, p.y - 8, total2, 16, 4); else g.rect(p.x - total2 / 2, p.y - 8, total2, 16);
        g.fill();
        g.globalAlpha = alpha;
        g.textAlign = 'left';
        g.font = '500 10px system-ui,sans-serif';
        g.fillStyle = 'rgba(240,236,226,.95)';
        g.fillText(text, p.x - total2 / 2 + 4, p.y + 3.5);
        g.font = '500 9.5px ' + mono;
        const [cr, cg, cb] = Core.changeColor(ind.pct);
        g.fillStyle = `rgb(${cr * 255 | 0},${cg * 255 | 0},${cb * 255 | 0})`;
        g.fillText(pct, p.x - total2 / 2 + tw + 8, p.y + 3.5);
      }
      g.globalAlpha = 1;
    }
  } else if (S.fan && S.fan.length) {
    // 主干：从星云连到抽屉顶部，扇形分支在抽屉自己的画布上（fanFrame）
    const sheet = sheetEl.getBoundingClientRect();
    const wide = w >= 900;
    const from = wide ? { x: frame.cx + frame.radius * 1.28, y: frame.cy } : { x: frame.cx, y: frame.cy + frame.radius * 1.28 };
    const to = wide ? { x: sheet.left, y: sheet.top + sheet.height * 0.12 } : { x: sheet.left + sheet.width / 2, y: sheet.top };
    g.globalCompositeOperation = 'lighter';
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,205,125,.55)';
    g.beginPath(); g.moveTo(from.x, from.y); g.lineTo(to.x, to.y); g.stroke();
    const t = (scene.time * 1.2) % 1;
    g.beginPath(); g.arc(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, 1.8, 0, 7); g.fillStyle = 'rgba(255,225,160,.95)'; g.fill();
  }
  // 流程条：底线 + 亮点
  const chips = layoutInfo.chips;
  if (chips && chips.length > 1 && !sheetOpen) {
    const y = chips[0].y - 1.5, x0 = chips[0].x - chips[0].w / 2 + 4, x1 = chips[chips.length - 1].x + chips[0].w / 2 - 4;
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,255,255,.1)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke();
    g.globalCompositeOperation = 'lighter';
    for (let k = pipePulses.length - 1; k >= 0; k--) {
      const p = pipePulses[k];
      p.t += dt / 1.5;
      if (p.t >= 1) { pipePulses.splice(k, 1); continue; }
      const x = x0 + (x1 - x0) * p.t;
      const stage = Math.min(STAGES.length - 1, Math.floor(p.t * STAGES.length));
      if (stage !== p.stage) { p.stage = stage; hitStage(STAGES[stage][0]); }
      const grad = g.createLinearGradient(x - 26, 0, x, 0);
      grad.addColorStop(0, 'rgba(255,190,90,0)');
      grad.addColorStop(1, 'rgba(255,215,140,.95)');
      g.strokeStyle = grad; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(Math.max(x0, x - 26), y); g.lineTo(x, y); g.stroke();
    }
  }
  // 选中的股票
  if (S.focus !== null) {
    const p = scene.project(S.focus);
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = 'rgba(255,230,170,.95)';
    g.lineWidth = 1;
    g.beginPath(); g.arc(p.x, p.y, 8 + Math.sin(scene.time * 4), 0, 7); g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
}

/**
 * 下钻连线：从抽屉顶部走左边的细沟，分叉到每一行。
 * Drill-down lines: from the top of the drawer down a thin gutter on the left, branching to each row.
 */
let fanDrawn = false;
function fanFrame() {
  const canvas = $('fanCanvas');
  const active = S.fan && S.fan.length && S.sheet;
  if (!active) {
    if (fanDrawn) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); fanDrawn = false; }
    return;
  }
  const rect = sheetEl.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, rect.width, rect.height);
  const body = $('sheetBody').getBoundingClientRect();
  const wide = window.innerWidth >= 900;
  const start = wide ? { x: 0, y: rect.height * 0.12 } : { x: rect.width / 2, y: 0 };
  const gutter = 5;
  g.globalCompositeOperation = 'lighter';
  g.lineWidth = 0.9;
  S.fan.forEach((row, k) => {
    if (!row.el.isConnected) return;
    const r = row.el.getBoundingClientRect();
    if (r.bottom < body.top + 4 || r.top > body.bottom - 4) return;
    const y = r.top + r.height / 2 - rect.top, x = r.left - rect.left + 4;
    const p0 = start, p1 = { x: wide ? gutter : gutter + 40, y: start.y + (wide ? 0 : 2) }, p2 = { x: gutter, y: Math.max(start.y + 26, y - 40) }, p3 = { x: gutter, y: y - 6 };
    g.strokeStyle = 'rgba(255,205,125,.34)';
    g.beginPath(); g.moveTo(p0.x, p0.y); g.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y); g.quadraticCurveTo(gutter, y, x, y); g.stroke();
    // 流动的亮点
    const t = (scene.time * 0.42 + k * 0.137) % 1, u = 1 - t;
    const px = u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x;
    const py = u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y;
    g.beginPath(); g.arc(px, py, 1.5, 0, 7); g.fillStyle = 'rgba(255,225,160,.95)'; g.fill();
    g.beginPath(); g.arc(x, y, 1.6, 0, 7); g.fillStyle = 'rgba(255,205,125,.85)'; g.fill();
  });
  fanDrawn = true;
}

// ---------------------------------------------------------------- 主循环 / Main loop

let lastFrame = 0, panelAt = 0, hudAt = 0;
function loop(now) {
  if (!CAPTURE) requestAnimationFrame(loop);
  if (S.hidden) return;
  const dt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 1 / 60;
  lastFrame = now;
  replayFrame(now);
  if (S.mode === 'live' || S.mode === 'boot') {
    S.rate += ((S.counters.updates / Math.max(dt, 0.001)) - S.rate) * 0.02;
    S.counters.updates = 0;
    scene.flowSpeed = 0.04 + Math.min(0.14, S.rate / 700);
    scene.heat = clamp(0.3 + S.rate / 260 + Math.abs(S.breadth.mean || 0) * 0.25, 0.25, 1);
  }
  scene.frame(now, true);
  overlayFrame(dt);
  fanFrame();
  acctFrame(now);
  feedFrame(dt);
  if (now - hudAt > 220) {
    hudAt = now;
    if (S.mode === 'boot') {
      recount(); renderMarket(); hitStage('采集'); hitStage('清洗');
      if (now - (S.moversAt || 0) > 700) { S.moversAt = now; updateRays(); updateMovers(); }
      $('tapeFill').style.width = (S.seenCount / (S.n || 1) * 100).toFixed(1) + '%';
      $('replayText').textContent = `点亮 ${commas(S.seenCount)}/${commas(S.n)}`;
    }
    else if (S.mode === 'live') { renderMarket(); }
    else if (S.mode === 'closed') { renderMarket(); }
    updateModeText();
    renderPipeline();
    if (S.mode === 'live' || S.mode === 'closed') refreshAccount();
  }
  if (now - panelAt > 90) {
    const pdt = (now - panelAt) / 1000;
    panelAt = now;
    drawWell(Math.min(0.2, pdt));
    if (Math.floor(now / 300) !== S.panelTick) {
      S.panelTick = Math.floor(now / 300);
      drawBreadth();
      drawFunnel();
    }
  }
}

// ---------------------------------------------------------------- 抽屉 / Drawer

const sheetEl = $('sheet');
function openSheet(state, push = false) {
  if (push && S.sheet) S.sheetStack.push(S.sheet); else if (!push) S.sheetStack = [];
  S.sheet = state;
  S.fan = null;
  $('sheetBody').scrollTop = 0;   // 新打开的一层从头看，不沿用上一层滚到的位置
  document.body.classList.add('sheet-open');
  sheetEl.classList.add('open');
  sheetEl.setAttribute('aria-hidden', 'false');
  $('sheetBack').classList.toggle('show', S.sheetStack.length > 0);
  renderSheet();
  setTimeout(() => applyStageFrame(false), 30);
}
function closeSheet() {
  S.sheet = null;
  S.sheetStack = [];
  S.fan = null;
  S.focus = null;
  scene.setMask(null);
  document.body.classList.remove('sheet-open');
  sheetEl.classList.remove('open');
  sheetEl.setAttribute('aria-hidden', 'true');
  applyStageFrame(false);
}
function sheetBack() {
  if (S.sheetStack.length) {
    S.sheet = S.sheetStack.pop();
    S.fan = null;
    if (S.sheet.kind !== 'stock') { S.focus = null; scene.setMask(null); }
    $('sheetBack').classList.toggle('show', S.sheetStack.length > 0);
    renderSheet();
    return true;
  }
  if (S.sheet) { closeSheet(); return true; }
  return false;
}
// 标签页切到后台时停下取数和动画；切回来先等一轮，不算中断，也不算延迟
const suspend = () => { S.hidden = true; };
const resume = () => { S.hidden = false; lastFrame = 0; scene.lastNow = 0; S.sweepOkAt = Date.now(); if (S.mode === 'live') fetchIndices(); };
document.addEventListener('visibilitychange', () => { document.hidden ? suspend() : resume(); });
// Esc：抽屉退回上一层，最外层就关上
document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.sheet) { e.preventDefault(); sheetBack(); } });
$('sheetClose').onclick = closeSheet;
$('sheetBack').onclick = sheetBack;
$('searchBtn').onclick = () => openSheet({ kind: 'search', query: '' });
$('basketBtn').onclick = () => openBasket(false);
paintBasketButton();
$('playBtn').onclick = () => { S.replay.playing = !S.replay.playing; $('playBtn').textContent = S.replay.playing ? '❚❚' : '▶'; if (S.replay.playing) S.replay.started = clockNow() - REPLAY_DAY_MS; };
$('liveBtn').onclick = () => {
  if (S.mode === 'replay') setMode('closed'); else if (S.history) setMode('replay');
};
function openStage(name) {
  // 组合、成交就是模拟账户的持仓和买卖记录
  if (name === '组合') { openAccount({ tab: 'hold' }); return; }
  if (name === '成交') { openAccount({ tab: 'trades' }); return; }
  openSheet({ kind: 'stage', stage: name });
}

function renderSheet() {
  const st = S.sheet;
  if (!st) return;
  const titleEl = $('sheetTitle'), subEl = $('sheetSub'), body = $('sheetBody');
  body.onclick = null;
  // 账户的列表长，窄屏上抽屉拉高一些
  sheetEl.classList.toggle('tall', st.kind === 'account' || st.kind === 'trade');
  if (st.kind === 'stage') {
    const fn = STAGE_VIEWS[st.stage];
    const view = fn(st);
    titleEl.textContent = view.title;
    subEl.textContent = view.sub || '';
    body.innerHTML = view.html + `<p class="small" style="margin-top:12px">${NOTE}</p>`;
    if (view.after) view.after(body);
  } else if (st.kind === 'stock') {
    renderStockSheet();
  } else if (st.kind === 'basket') {
    renderBasketSheet();
  } else if (st.kind === 'account') {
    renderAccountSheet();
  } else if (st.kind === 'trade') {
    renderTradeSheet();
  } else if (st.kind === 'search') {
    titleEl.textContent = '查找股票';
    subEl.textContent = `全市场 ${commas(S.n)} 只`;
    const missing = st.missing ? `<div class="sec card small" style="margin-bottom:8px">星云的股票名单里没有 ${esc(st.missing)}，这只暂时不能在这里模拟买卖。可以换一只。</div>` : '';
    body.innerHTML = `${missing}<input class="search" id="q" placeholder="名称或代码" autocomplete="off" value="${esc(st.query)}"><div id="qr" class="sec"></div>`;
    const input = $('q');
    const run = () => {
      st.query = input.value.trim();
      const q = st.query.toLowerCase();
      const hits = q ? S.stocks.map((s, i) => [s, i]).filter(([s]) => s.code.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)).slice(0, 40) : [];
      $('qr').innerHTML = hits.map(([s, i]) => stockRow(i)).join('');
    };
    input.oninput = run;
    run();
    // 有鼠标键盘的设备上直接能打字；触屏上不自动弹键盘
    if (window.matchMedia('(pointer: fine)').matches) input.focus({ preventScroll: true });
    body.onclick = e => { const b = e.target.closest('[data-stock]'); if (b) openStock(Number(b.dataset.stock)); };
  }
}

function stockRow(i, extra = '') {
  const s = S.stocks[i];
  const pct = S.pct[i];
  return `<button class="row" data-stock="${i}"><div class="grow"><div class="t">${esc(s.name)}</div><div class="d">${esc(s.code)} · ${esc(s.industry || (s.market === 'HK' ? '港股' : ''))}${extra}</div></div>`
    + `<div class="n">${Core.fixed(S.price[i])}<small class="${cls(pct)}">${Core.signed(pct)}%</small></div></button>`;
}

const ACCOUNTS = [{ market: 'CN', label: '人民币账户', unit: '¥' }, { market: 'HK', label: '港币账户', unit: 'HK$' }, { market: 'US', label: '美元账户', unit: '$' }];
const unitOf = code => (code.startsWith('hk') ? 'HK$' : code.startsWith('us') ? '$' : '¥');

const STAGE_VIEWS = {
  采集() {
    const c = S.counters;
    return {
      title: '采集', sub: '实时行情一批批进入星云',
      html: `<div class="sec card"><div class="kv">
          <div><span>已收到</span><b>${commas(c.rows)}</b></div><div><span>批次</span><b>${commas(c.batches)}</b></div><div><span>全市场一轮</span><b>${S.roundSeconds ? S.roundSeconds + ' 秒' : '—'}</b></div>
          <div><span>覆盖股票</span><b>${commas(countSeen())}/${commas(S.n)}</b></div><div><span>五档盘口</span><b>${commas(S.full.size)} 只</b></div><div><span>流量</span><b>${Core.fixed(c.bytes / 1048576, 1)} MB</b></div></div></div>
        <div class="sec"><h4>每一路数据做什么</h4><div class="card">
          <div class="src"><b>实时行情</b><p>正在交易的市场滚动刷新现价、涨跌、成交额，价格变了粒子才闪。美股和 A 股、港股的交易时间不重叠，不交易的市场不刷新。美股报价约 20 秒更新一次。</p></div>
          <div class="src"><b>五档盘口</b><p>规则命中、持仓和正在看的股票，4 秒一次，带买卖五档，模拟成交按它吃单。美股没有盘口数据，按最新价估算。</p></div>
          <div class="src"><b>指数分时</b><p>${MARKET_INDEX[focusMarket()].name} 当日每分钟点位，画波动漏斗。</p></div>
          <div class="src"><b>盘后全市场</b><p>${S.history ? `收盘后回放用的全市场日线，共 ${S.history.cols} 个交易日。回放的每一天都是当天真实涨跌，没有补算。` : '可选数据（data/history.json），现在没有，所以收盘后不回放。'}</p></div>
          <div class="src"><b>行业财务</b><p>行业分类来自股票名单，决定粒子聚在哪。</p></div>
          <div class="src"><b>复权日线</b><p>${S.rules.length ? `规则计算和回测用，数据日期 ${esc(S.rulesAsOf || '—')}。除权除息按前收盘比例复权。` : '可选数据（data/rules.json），规则信号和回测用。现在没有，所以不显示信号。'}</p></div>
        </div></div>`,
    };
  },
  清洗() {
    const c = S.counters;
    const dead = [];
    for (let i = 0; i < S.n && dead.length < 12; i++) if (S.seen[i] && !(S.amount[i] > 0) && Math.abs(S.pct[i]) < 1e-6) dead.push(i);
    return {
      title: '清洗', sub: '不合格的数据不进入计算',
      html: `<div class="sec card"><div class="kv"><div><span>有效</span><b>${commas(S.breadth.n)}</b></div><div><span>停牌或无成交</span><b>${commas(c.stale)}</b></div><div><span>拒收</span><b>${commas(c.rejected)}</b></div></div></div>
        <div class="sec"><h4>每条行情都要过这几关</h4><div class="card">
          <div class="check"><i>·</i><span>没有现价或昨收的记录不要。</span></div>
          <div class="check"><i>·</i><span>最高价低于最低价、现价跑到当日高低点之外、超出涨跌停 1% 的记录拒收。</span></div>
          <div class="check"><i>·</i><span>成交额为 0 且现价等于昨收的是停牌或未开盘：显示成灰色，不算涨跌，也不能模拟成交。</span></div>
          <div class="check"><i>·</i><span>除权除息用前收盘比例复权，不用减法，长区间才不会失真。</span></div>
        </div></div>
        ${dead.length ? `<div class="sec"><h4>当前停牌或无成交（前 ${dead.length} 只）</h4><div class="card">${dead.map(i => stockRow(i)).join('')}</div></div>` : ''}`,
      after: bindRows,
    };
  },
  因子() {
    const rows = [['reversal5', '近 5 日反转', '−(P_t/P_{t−5} − 1)'], ['momentum20', '近 20 日动量', 'P_t/P_{t−20} − 1'], ['vol20', '近 20 日波动率', 'std(r_{t−19..t})']];
    return {
      title: '因子', sub: S.history ? `${S.history.days[20]} 起的全市场横截面` : '',
      html: `<div class="sec"><h4>全市场 Rank IC（因子值和之后 5 日收益的秩相关）</h4>
        ${rows.map(([key, name, formula]) => {
          const v = S.ic.summary && S.ic.summary[key];
          return `<div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-weight:500">${name}</b><span class="formula">${formula}</span></div>
            ${v ? `<div class="kv" style="margin-top:6px"><div><span>IC 均值</span><b class="${cls(v.mean)}">${Core.signed(v.mean, 3)}</b></div><div><span>ICIR</span><b>${Core.signed(v.icir, 2)}</b></div><div><span>IC 为正</span><b>${(v.positive * 100).toFixed(0)}%</b></div></div>
              <canvas class="chart" style="height:54px;margin-top:6px" data-ic="${key}"></canvas>` : `<p class="small">${S.history ? '计算中…' : '需要收盘回放数据（data/history.json）才能算。'}</p>`}</div>`;
        }).join('')}
        <p class="small" style="margin-top:8px">样本只有 ${S.ic.summary && S.ic.summary.reversal5 ? S.ic.summary.reversal5.n : '—'} 个交易日，5 日收益有重叠，只能看方向，不能当作规则有效的证据。经验上 |IC| 大于 0.03、|ICIR| 大于 0.3 才值得继续研究；多试几个因子总会撞到好看的数字，所以要看滚动窗口和分行情段。</p></div>
        <div class="sec"><h4>从数据到因子的步骤</h4><div class="card formula">
          对数收益 r = ln(P_t / P_{t−1})<br>去极值 Winsorize 到 ±3 倍 MAD<br>标准化 z = (x − μ) / σ（行业内）<br>中性化：对市值、行业回归取残差<br>IC = corr(rank(f_t), rank(r_{t+h}))，ICIR = IC 均值 / IC 标准差</div></div>`,
      after(body) {
        body.querySelectorAll('[data-ic]').forEach(c => drawSeries(c, S.ic.series[c.dataset.ic].filter(x => x !== null), { bars: true }));
      },
    };
  },
  信号(st) {
    const rule = S.rules.find(r => r.id === (st.rule || S.ruleId)) || S.rules[0];
    if (!rule) return { title: '信号', sub: '', html: `<p class="small">${S.rulesMissing ? '没有规则数据（data/rules.json 是可选的），所以没有信号。格式见项目说明。' : '规则数据还没准备好，请稍后再试。'}</p>` };
    return {
      title: '研究结论', sub: `${rule.title} · ${rule.tagline} · 股票池 ${commas(rule.poolSize)} 只`,
      html: `<div class="tabs">${S.rules.map(r => `<button data-rule="${esc(r.id)}" class="${r.id === rule.id ? 'on' : ''}">${esc(r.title)} ${ruleHits(r).length}</button>`).join('')}</div>
        <p class="small" style="margin:6px 0 4px">${esc(rule.summary)}</p>
        ${rule.relaxNote ? `<p class="small" style="color:#ffdc9a">${esc(rule.relaxNote)}</p>` : ''}
        ${ruleHits(rule).length ? `<div style="display:flex;justify-content:flex-end;align-items:center;gap:8px;margin:4px 0">${st.basketNote ? `<span class="small" style="color:#ffdc9a">${esc(st.basketNote)}</span>` : ''}<button class="chip" id="hitsToBasket">这一组 ${ruleHits(rule).length} 只加入篮子</button></div>` : `<p class="small" style="margin:6px 0">${esc(MARKET_NAME[S.view])}今天没有符合这套规则的股票。</p>`}
        <div id="fanRows">${ruleHits(rule).map(h => {
          const i = S.codeIndex.get(h.code);
          if (i === undefined) return '';
          return `<button class="row" data-stock="${i}" data-rule-hit="${esc(rule.id)}"><div class="grow"><div class="t">${esc(h.name)} <span class="stars">${'★'.repeat(h.stars)}${'☆'.repeat(5 - h.stars)}</span></div>
            <div class="d">${h.headline.map(x => `${esc(x[0])} ${esc(x[1])}`).join(' · ')}</div></div>
            <div class="n">${Core.fixed(S.price[i])}<small class="${cls(S.pct[i])}">${Core.signed(S.pct[i])}%</small></div></button>`;
        }).join('')}</div>
        ${testFor(rule) ? backtestCard(rule, testKey()) : `<div class="sec"><p class="small">${esc(rule.noBacktestReason || '')}</p></div>`}
        ${trackingCard(rule)}
        <p class="small" style="margin-top:8px">星级表示这只股票的数据与规则条件的符合程度，不预测涨跌。规则依据 ${esc(S.rulesAsOf || '')} 的数据。</p>`,
      after(body) {
        if (rule.id !== S.ruleId) { S.ruleId = rule.id; refreshAccount(); }
        const hits = ruleHits(rule).map(h => S.codeIndex.get(h.code)).filter(i => i !== undefined);
        scene.setMask(hits);
        S.fan = [...body.querySelectorAll('#fanRows .row')].map(el => ({ el }));
        body.querySelectorAll('[data-rule]').forEach(b => { b.onclick = () => { st.rule = b.dataset.rule; st.basketNote = ''; renderSheet(); }; });
        const toBasket = body.querySelector('#hitsToBasket');
        if (toBasket) toBasket.onclick = () => {
          const added = addToBasket(ruleHits(rule).map(h => h.code).filter(c => S.codeIndex.has(c)));
          st.basketNote = added ? `已加入 ${added} 只，点右上角的篮子一起模拟买卖` : S.basket.length >= BASKET_MAX ? `篮子最多放 ${BASKET_MAX} 只` : '这一组已经都在篮子里';
          renderSheet();
        };
        bindRows(body);
        drawBacktest(body);
      },
    };
  },
  净值() {
    const rule = currentRule();
    const test = testFor(rule);
    const quotes = Object.fromEntries(S.full);
    return {
      title: '净值', sub: rule ? `${rule.title} 的回测和我的模拟账户` : '我的模拟账户',
      html: ACCOUNTS.filter(a => a.market === accountMarket() || S.books[a.market].trades.length).map(({ market, label, unit }) => {
        const book = S.books[market];
        const e = Sim.equity(book, quotes);
        return `<div class="sec card"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><h4 class="small">${label} · 账号 ${Sim.accountId(market, book)}</h4><button class="chip" data-days="${market}">每日对账 ›</button></div><div class="kv"><div><span>净值</span><b>${unit}${commas(e.total / 100, 0)}</b></div><div><span>累计收益</span><b class="${cls(e.pnl)}">${Core.signed(e.pnl / book.capital * 100)}%</b></div><div><span>今日</span><b class="${cls(e.dayPnl)}">${Core.signed(e.dayPnl / 100, 0)}</b></div></div>
          ${book.equityDays.length >= 2 ? `<canvas class="chart" style="height:96px;margin-top:8px" data-equity="${market}"></canvas><p class="small">${esc(book.equityDays[0][0])} 起，每个交易日收盘记一个点。</p>` : '<p class="small" style="margin-top:6px">净值曲线从下一个交易日开始记录，至少两天才有线。</p>'}</div>`;
      }).join('') + (test ? backtestCard(rule, testKey())
        + `<div class="sec"><h4>${esc(rule.title)} 回测的成交（${esc(test.start)} 至 ${esc(test.end)}）</h4><div class="card"><div class="kv"><div><span>模拟买入</span><b>${commas(test.buys)} 笔</b></div><div><span>买不进</span><b>${commas(test.blockedBuys)}</b></div><div><span>卖单顺延</span><b>${commas(test.delayedSells)}</b></div><div><span>成本占本金</span><b>${(test.costRatio * 100).toFixed(2)}%</b></div></div>
          ${test.note ? `<p class="small" style="margin-top:6px">${esc(test.note)}</p>` : ''}</div></div>` : ''),
      after(body) {
        drawBacktest(body);
        body.querySelectorAll('[data-equity]').forEach(c => {
          const book = S.books[c.dataset.equity];
          drawSeries(c, book.equityDays.map(p => p[1] / book.capital), { zero: 1 });
        });
        body.querySelectorAll('[data-days]').forEach(b => { b.onclick = () => openAccount({ market: b.dataset.days, tab: 'days' }, true); });
      },
    };
  },
};

/**
 * 这套规则每天的结论，到期后实际表现怎样。回测可以反复调参，这份记录不能。
 * What each day's picks of this rule actually did once they matured. A backtest can be re-tuned; this record cannot.
 */
function trackingCard(rule) {
  const rows = (S.tracking || []).filter(t => t.rule === rule.id && (S.view === 'ALL' || TEST_KEY[S.view] === t.market));
  const percent = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const body = rows.map(t => `<div class="kv"><div><span>${MARKET_NAME[t.market]} ${t.horizon} 日（${t.days} 天）</span><b class="${cls(t.avgReturn)}">${percent(t.avgReturn)}</b></div>
    <div><span>相对指数</span><b class="${cls(t.avgExcess)}">${percent(t.avgExcess)}</b></div><div><span>跑赢天数</span><b>${Math.round(t.beatShare * 100)}%</b></div></div>`).join('');
  const empty = S.trackingSince ? '还没有到期的记录，满 5 个交易日后出第一个结果。' : '今天收盘后开始记录。';
  return `<div class="sec"><h4>结论跟踪${S.trackingSince ? `（${esc(S.trackingSince)} 起）` : ''}</h4><div class="card">${body || `<p class="small">${empty}</p>`}
    <p class="small" style="margin-top:6px">每天收盘后记下选出的股票，从下一个交易日开盘算起，到期后和同期指数比较，未扣交易成本。</p></div></div>`;
}

function backtestCard(rule, market) {
  const t = rule.backtests[market];
  const excess = t.ruleReturn - t.benchmarkReturn;
  return `<div class="sec"><h4>这套规则过去的表现（${esc(t.start)} 至 ${esc(t.end)}，${t.periods} 次换股）</h4><div class="card">
    <canvas class="chart" id="btChart" data-rule="${esc(rule.id)}" data-market="${market}"></canvas>
    <div class="kv" style="margin-top:8px"><div><span>规则累计</span><b class="${cls(t.ruleReturn)}">${Core.signed(t.ruleReturn * 100, 1)}%</b></div><div><span>${BENCH_NAME[market]}</span><b class="${cls(t.benchmarkReturn)}">${Core.signed(t.benchmarkReturn * 100, 1)}%</b></div><div><span>相对</span><b class="${cls(excess)}">${Core.signed(excess * 100, 1)}%</b></div>
    <div><span>最大回撤</span><b>${(t.maxDrawdown * 100).toFixed(1)}%</b></div><div><span>指数回撤</span><b>${(t.benchmarkMaxDrawdown * 100).toFixed(1)}%</b></div><div><span>跑赢次数</span><b>${t.beat}/${t.periods}</b></div></div>
    <p class="small" style="margin-top:6px">${t.note ? esc(t.note) + ' ' : ''}样本只有 ${t.periods} 次换股，不代表未来。</p></div></div>`;
}

function drawBacktest(body) {
  const c = body.querySelector('#btChart');
  if (!c) return;
  const rule = S.rules.find(r => r.id === c.dataset.rule);
  const t = rule.backtests[c.dataset.market];
  const a = t.daily.map(p => p[1]);
  const b = t.benchmarkDaily.map(p => p[1]);
  drawSeries(c, a, { second: b, zero: 1, labels: [t.start, t.end], secondName: BENCH_NAME[c.dataset.market] });
}

function drawSeries(canvas, a, { second = null, bars = false, zero = 0, labels = null, secondName = '' } = {}) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height;
  const all = second ? a.concat(second) : a;
  if (!all.length) return;
  let lo = Math.min(...all, zero), hi = Math.max(...all, zero);
  if (hi - lo < 1e-6) { hi += 0.01; lo -= 0.01; }
  const bottom = labels ? h - 13 : h - 2;
  const X = (k, n) => 2 + (w - 4) * (n > 1 ? k / (n - 1) : 0.5);
  const Y = v => 3 + (bottom - 6) * (1 - (v - lo) / (hi - lo));
  g.strokeStyle = 'rgba(255,255,255,.12)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, Y(zero)); g.lineTo(w, Y(zero)); g.stroke();
  if (bars) {
    const bw = Math.max(1, (w - 4) / a.length - 1);
    a.forEach((v, k) => { g.fillStyle = v >= 0 ? 'rgba(255,107,94,.85)' : 'rgba(43,214,138,.85)'; g.fillRect(X(k, a.length) - bw / 2, Math.min(Y(v), Y(0)), bw, Math.abs(Y(v) - Y(0))); });
    return;
  }
  if (second) {
    g.strokeStyle = 'rgba(120,175,255,.9)'; g.lineWidth = 1.2;
    g.beginPath(); second.forEach((v, k) => (k ? g.lineTo(X(k, second.length), Y(v)) : g.moveTo(X(k, second.length), Y(v)))); g.stroke();
  }
  g.strokeStyle = '#FFC46B'; g.lineWidth = 1.6; g.shadowColor = '#FFB347'; g.shadowBlur = 6;
  g.beginPath(); a.forEach((v, k) => (k ? g.lineTo(X(k, a.length), Y(v)) : g.moveTo(X(k, a.length), Y(v)))); g.stroke();
  g.shadowBlur = 0;
  if (labels) {
    g.fillStyle = '#7d7a73'; g.font = '9.5px ui-monospace,Consolas,monospace';
    g.textAlign = 'left'; g.fillText(labels[0], 2, h - 2);
    g.textAlign = 'right'; g.fillText(labels[1], w - 2, h - 2);
    g.fillStyle = '#FFC46B'; g.textAlign = 'left'; g.fillText('规则', 4, 11);
    if (second) { g.fillStyle = 'rgba(120,175,255,1)'; g.fillText(secondName, 32, 11); }
  }
}

function bindRows(body) {
  body.querySelectorAll('[data-stock]').forEach(b => { b.onclick = () => openStock(Number(b.dataset.stock), b.dataset.ruleHit); });
}

// ---------------------------------------------------------------- 个股卡片和模拟下单 / Stock card and simulated orders

function openStock(i, ruleId) {
  S.focus = i;
  scene.setMask([i]);
  scene.flare(i, 0);
  openSheet({ kind: 'stock', index: i, ruleId, qty: null, msg: '', msgKind: '' }, !!S.sheet);
  fetchFull([S.stocks[i].code], 1);
}

function hitFor(code, ruleId) {
  const ordered = ruleId ? [S.rules.find(r => r.id === ruleId), ...S.rules] : S.rules;
  for (const r of ordered) { if (!r) continue; const h = r.hits.find(x => x.code === code); if (h) return { rule: r, hit: h }; }
  return null;
}

const percentText = v => (Core.fixed(v) === '—' ? '—' : Core.fixed(v) + '%');

function renderStockSheet() {
  const st = S.sheet;
  const i = st.index, s = S.stocks[i];
  const q = S.full.get(s.code);
  $('sheetTitle').textContent = s.name;
  const market = s.market;
  const session = Core.sessionOpen(market, Date.now());
  const us = market === 'US';
  $('sheetSub').textContent = `${us ? s.code.slice(2) : s.code} · ${s.industry || (market === 'HK' ? '港股' : '')}${q && q.at ? ' · 行情 ' + Core.clock(q.at) : ''}`;
  const body = $('sheetBody');
  const price = q ? q.price : S.price[i];
  const pct = q ? q.pct : S.pct[i];
  const lot = us ? 1 : q ? (market === 'HK' ? q.lot : (/^sh68[89]/.test(s.code) ? 200 : 100)) : 100;
  if (st.qty === null) st.qty = lot;
  const book = S.books[market];
  const position = book.positions[s.code];
  const records = book.trades.filter(t => t.code === s.code).length;
  const maxSize = q ? Math.max(...q.bids.map(x => x[1]), ...q.asks.map(x => x[1]), 1) : 1;
  const level = (p, v, color) => `<div><i style="width:${(v / maxSize * 100).toFixed(0)}%;background:${color}"></i><span>${p > 0 ? p.toFixed(q.price >= 1000 ? 2 : q.price < 2 ? 3 : 2) : '—'}</span><b>${v > 0 ? commas(v) : '—'}</b></div>`;
  const found = hitFor(s.code, st.ruleId);
  body.innerHTML = `
    <div class="sec" style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px">
      <div class="price ${cls(pct)}">${Core.fixed(price, 2)}</div>
      <div class="${cls(pct)}" style="font:500 13px/18px var(--mono);text-align:right">${Core.signed(q ? q.price - q.prev : null)}<br>${Core.signed(pct)}%</div>
    </div>
    ${q ? `<div class="sec card"><div class="kv">
      <div><span>今开</span><b>${Core.fixed(q.open)}</b></div><div><span>最高</span><b>${Core.fixed(q.high)}</b></div><div><span>最低</span><b>${Core.fixed(q.low)}</b></div>
      <div><span>成交额</span><b>${{ HK: 'HK$', US: '$' }[market] || ''}${Core.money(q.amount)}</b></div><div><span>换手率</span><b>${percentText(q.turnover)}</b></div><div><span>量比</span><b>${Core.fixed(q.volRatio)}</b></div>
      <div><span>市盈率 TTM</span><b>${q.pe > 0 ? Core.fixed(q.pe, 1) : q.pe < 0 ? '亏损' : '—'}</b></div><div><span>市净率</span><b>${Core.fixed(q.pb)}</b></div><div><span>股息率</span><b>${percentText(q.dividend)}</b></div>
      <div><span>总市值</span><b>${q.capYi ? ({ HK: 'HK$', US: '$' }[market] || '') + Core.money(q.capYi * 1e8) : '—'}</b></div>
      ${q.limitUp ? `<div><span>涨停价</span><b class="up">${Core.fixed(q.limitUp)}</b></div><div><span>跌停价</span><b class="down">${Core.fixed(q.limitDown)}</b></div>` : ''}
    </div></div>
    ${us ? '' : `<div class="sec"><h4>五档盘口（${market === 'HK' ? '股' : '手'}）</h4><div class="card book">
      <div style="color:var(--muted);font-size:10.5px"><span>买盘</span></div><div style="color:var(--muted);font-size:10.5px"><span>卖盘</span></div>
      ${[0, 1, 2, 3, 4].map(k => level(q.bids[k][0], q.bids[k][1], 'var(--up)') + level(q.asks[k][0], q.asks[k][1], 'var(--down)')).join('')}
    </div></div>`}` : '<div class="sec card small">正在取这只股票的完整报价…</div>'}
    <div class="sec"><h4>日 K（最近 60 根，前复权，黄线是 20 日均线）</h4><div class="card"><canvas class="chart" id="klineChart" style="height:150px"></canvas><p class="small" id="klineNote" style="display:none"></p></div></div>
    ${found ? `<div class="sec"><h4>研究结论 · ${esc(found.rule.title)}</h4><div class="card">
      <div class="stars" style="font-size:14px">${'★'.repeat(found.hit.stars)}${'☆'.repeat(5 - found.hit.stars)} <span class="small">数据符合度</span></div>
      <div style="margin-top:6px">${found.hit.checks.map(c => `<div class="check ${c[1] ? '' : 'no'}"><i>${c[1] ? '✓' : '✗'}</i><span>${esc(c[0])}：${esc(c[2])}</span></div>`).join('')}</div>
      <p class="small" style="margin-top:6px">入选依据只是这些数据符合规则，不预测涨跌。规则依据 ${esc(S.rulesAsOf || '')} 的数据。</p></div></div>` : ''}
    <div class="sec"><h4>模拟下单（${us ? '美元账户，按最新价估算' : (market === 'HK' ? '港元' : '人民币') + '账户，真实盘口'}，不连券商）</h4><div class="card">
      <div class="kv"><div><span>可用现金</span><b>${commas(book.cash / 100, 0)}</b></div><div><span>持仓</span><b>${commas(position ? position.qty : 0)}</b></div><div><span>可卖</span><b>${commas(position ? position.avail : 0)}</b></div></div>
      <div class="ticket"><button class="step" id="qtyMinus">−</button><input id="qty" type="number" inputmode="numeric" value="${st.qty}"><button class="step" id="qtyPlus">＋</button></div>
      <div class="actions"><button class="buy" id="doBuy">模拟买入</button><button class="sell" id="doSell">模拟卖出</button></div>
      <div class="actions"><button class="alt" id="basketToggle">${S.basket.includes(s.code) ? '移出篮子' : '加入篮子'}</button><button class="alt" id="basketOpen"${S.basket.length ? '' : ' disabled'}>${S.basket.length ? `看篮子 · ${S.basket.length} 只` : '篮子是空的'}</button></div>
      <div class="msg ${st.msgKind}" id="tradeMsg">${esc(st.msg || (session ? (us ? '按最新价估算成交。' : '按当前五档盘口逐档成交。') : '现在不在交易时段：委托排队，下一交易时段按真实开盘价成交。'))}</div>
      <div class="acct-link"><span class="small">${esc(ACCOUNTS.find(a => a.market === market).label)} · 账号 ${Sim.accountId(market, book)}</span><button class="chip" id="stockRecords">${records ? `这只的买卖记录 · ${records} 笔 ›` : '打开模拟账户 ›'}</button></div>
    </div></div>
    <p class="small" style="margin-top:10px">${NOTE}</p>`;
  const qtyInput = $('qty');
  qtyInput.oninput = () => { st.qty = Math.floor(Number(qtyInput.value) || 0); };
  $('qtyMinus').onclick = () => { st.qty = Math.max(lot, (st.qty || lot) - lot); qtyInput.value = st.qty; };
  $('qtyPlus').onclick = () => { st.qty = (st.qty || 0) + lot; qtyInput.value = st.qty; };
  $('doBuy').onclick = () => placeOrder('buy');
  $('doSell').onclick = () => placeOrder('sell');
  $('basketToggle').onclick = () => {
    if (S.basket.includes(s.code)) { dropFromBasket(s.code); st.msg = '已移出篮子'; st.msgKind = ''; }
    else if (addToBasket([s.code])) { st.msg = '已加入篮子：可以和篮子里的其他股票一起模拟买卖、对照涨跌'; st.msgKind = 'good'; }
    else { st.msg = `篮子最多放 ${BASKET_MAX} 只`; st.msgKind = 'bad'; }
    refreshStockSheet();
  };
  $('basketOpen').onclick = () => openBasket(true);
  $('stockRecords').onclick = () => openAccount(records ? { market, tab: 'trades', text: plainCode(s.code) } : { market, tab: 'hold' }, true);
  showKline(s.code);
}

/**
 * 日 K：一只只按需取，取过的留着。卡片每几秒重画一次，不重新请求。
 * Daily K-lines: fetched per stock on demand and cached. The card redraws every few seconds without refetching.
 */
const klines = new Map();
async function showKline(code) {
  const paint = () => {
    const canvas = $('klineChart');
    if (!canvas || !S.sheet || S.sheet.kind !== 'stock' || S.stocks[S.sheet.index].code !== code) return;
    const rows = klines.get(code);
    if (rows && rows.length) drawKline(canvas, rows.slice(-60));
    else if (rows) { canvas.style.display = 'none'; const note = $('klineNote'); note.style.display = ''; note.textContent = '暂时用不了，请稍后再试'; }
  };
  if (klines.has(code)) { paint(); return; }
  klines.set(code, null);
  try {
    const rows = await getJson('proxy/kline?code=' + encodeURIComponent(code));
    klines.set(code, Array.isArray(rows) ? rows : []);
  } catch (e) { klines.set(code, []); }
  paint();
}

/**
 * 蜡烛图，涨红跌绿。rows：[日期, 开, 收, 高, 低, 量]。
 * Candlestick chart, red up / green down. rows: [date, open, close, high, low, volume].
 */
function drawKline(canvas, rows) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, bottom = h - 13;
  const lo = Math.min(...rows.map(x => x[4])), hi = Math.max(...rows.map(x => x[3]));
  const Y = v => 4 + (bottom - 8) * (1 - (v - lo) / Math.max(hi - lo, 1e-6));
  const step = w / rows.length, body = Math.max(1, step * 0.66);
  rows.forEach((x, k) => {
    const up = x[2] >= x[1];
    const cx = step * (k + 0.5);
    g.strokeStyle = g.fillStyle = up ? '#FF4D4F' : '#2BD68A';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(cx, Y(x[3])); g.lineTo(cx, Y(x[4])); g.stroke();
    const top = Y(Math.max(x[1], x[2]));
    g.fillRect(cx - body / 2, top, body, Math.max(1, Y(Math.min(x[1], x[2])) - top));
  });
  g.strokeStyle = '#E8B04A'; g.lineWidth = 1.2;
  g.beginPath();
  let started = false;
  rows.forEach((x, k) => {
    if (k < 19) return;
    const ma = rows.slice(k - 19, k + 1).reduce((a, y) => a + y[2], 0) / 20;
    const cx = step * (k + 0.5);
    if (started) g.lineTo(cx, Y(ma)); else { g.moveTo(cx, Y(ma)); started = true; }
  });
  g.stroke();
  g.fillStyle = '#7d7a73'; g.font = '9.5px ui-monospace,Consolas,monospace';
  g.textAlign = 'left'; g.fillText(rows[0][0], 2, h - 2);
  g.textAlign = 'right'; g.fillText(rows[rows.length - 1][0], w - 2, h - 2);
  g.fillText(Core.fixed(hi), w - 2, 11);
}

function refreshStockSheet() {
  // 用户正在输入股数时不重画，免得键盘收起
  if (document.activeElement && document.activeElement.id === 'qty') return;
  const top = $('sheetBody').scrollTop;
  renderStockSheet();
  $('sheetBody').scrollTop = top;
}

async function placeOrder(side) {
  const st = S.sheet;
  const s = S.stocks[st.index];
  const market = s.market;
  const fresh = await fetchFull([s.code], 1);
  const q = fresh[s.code] || S.full.get(s.code);
  const order = { code: s.code, side, qty: st.qty };
  const now = Date.now();
  // 节假日时钟在交易时段，但报价时间不动：也按休市排队
  const session = q && Core.sessionLive(market, now, q.at);
  let result;
  if (!q) { st.msg = '暂时用不了，请稍后再试'; st.msgKind = 'bad'; renderStockSheet(); return; }
  if (session) {
    result = Sim.placeNow(S.books[market], order, q, now);
    if (result.trade) {
      S.books[market] = result.book;
      st.msg = `模拟${side === 'buy' ? '买入' : '卖出'} ${commas(result.trade.qty)} 股，均价 ${result.trade.price.toFixed(3)}，费用 ${(result.trade.fee.total / 100).toFixed(2)}${result.unfilled ? (market === 'US' ? `；超过当天成交量的 1%，${commas(result.unfilled)} 股没成交` : `；五档盘口不够，${commas(result.unfilled)} 股没成交`) : ''}`;
      st.msgKind = 'good';
      feedText(`<span class="name">${esc(s.name)}</span>模拟${side === 'buy' ? '买入' : '卖出'} ${commas(result.trade.qty)} 股 @ ${result.trade.price.toFixed(3)}`);
      hitStage('成交'); hitStage('组合'); hitStage('净值');
    } else { st.msg = result.reject; st.msgKind = 'bad'; }
  } else {
    result = Sim.queue(S.books[market], order, q, now);
    if (result.reject) { st.msg = result.reject; st.msgKind = 'bad'; }
    else {
      S.books[market] = result.book;
      st.msg = `已排队：下一交易日按真实开盘价（午休时等下午开市按盘口）模拟${side === 'buy' ? '买入' : '卖出'} ${commas(order.qty)} 股`;
      st.msgKind = 'good';
    }
  }
  saveBooks();
  renderStockSheet();
  refreshAccount();
  renderPipeline();
}

// ---------------------------------------------------------------- 篮子：几只一起模拟买卖，对照看涨跌 / Basket: simulate trading several stocks together and compare their moves

function openBasket(push) {
  openSheet({ kind: 'basket', results: {}, msg: '', msgKind: '', busy: false }, push && !!S.sheet);
  if (S.basket.length) fetchFull(S.basket.slice(0, BATCH), 1);
}

/**
 * 最少能买多少股：A 股一手 100 股（科创板最少 200 股），港股按这只的每手股数，美股 1 股。
 * Minimum buy quantity: A-shares 100 (STAR Market at least 200), HK this stock's lot size, US 1 share.
 */
function basketLot(s, q) {
  if (s.market === 'US') return 1;
  if (s.market === 'HK') return (q && q.lot) || 100;
  return /^sh68[89]/.test(s.code) ? 200 : 100;
}

/**
 * 按“每只投入”折成整手，不够就是 0。
 * Convert the per-stock amount into whole lots; 0 when it is not enough.
 */
function basketQty(s, q, each) {
  if (!q || !(q.price > 0) || !(each > 0)) return 0;
  const step = s.market === 'CN' ? 100 : basketLot(s, q);
  const qty = Math.floor(each / q.price / step) * step;
  return qty >= basketLot(s, q) ? qty : 0;
}

/**
 * 篮子的对照柱：每只一根，等距排开，涨红跌绿；只数不多时柱头写上涨跌幅。
 * Basket comparison bars: one per stock, evenly spaced, red up / green down; values are drawn on the bars when there are only a few.
 */
function drawBasketBars(canvas, values) {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, n = values.length;
  if (!n) return;
  const labels = n <= 12;
  const top = labels ? 12 : 3, bottom = labels ? h - 12 : h - 3;
  const lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  const span = Math.max(hi - lo, 0.5);
  const Y = v => top + (bottom - top) * (hi - v) / span;
  const slot = w / n, bar = Math.min(26, slot * 0.62);
  g.strokeStyle = 'rgba(255,255,255,.14)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, Y(0)); g.lineTo(w, Y(0)); g.stroke();
  g.font = '9.5px ui-monospace,Consolas,monospace';
  g.textAlign = 'center';
  values.forEach((v, k) => {
    const cx = slot * (k + 0.5);
    g.fillStyle = v >= 0 ? 'rgba(255,107,94,.88)' : 'rgba(43,214,138,.88)';
    const y0 = Y(0), y1 = Y(v);
    g.fillRect(cx - bar / 2, Math.min(y0, y1), bar, Math.max(1, Math.abs(y1 - y0)));
    if (labels) {
      g.fillStyle = v >= 0 ? '#ff8a7e' : '#5be3a4';
      g.fillText(Core.signed(v, 1), cx, v >= 0 ? y1 - 3 : y1 + 10);
    }
  });
}

function renderBasketSheet() {
  const st = S.sheet;
  const list = S.basket.map(code => [code, S.codeIndex.get(code)]).filter(([, i]) => i !== undefined);
  $('sheetTitle').textContent = '篮子';
  $('sheetSub').textContent = list.length ? `${list.length} 只 · 一起模拟买卖，对照看涨跌` : '还没有股票';
  const body = $('sheetBody');
  if (!list.length) {
    body.innerHTML = `<div class="sec card small">在个股卡片里点「加入篮子」，或者在「信号」的研究结论里把一整组加进来，就能几只一起模拟买卖、对照看涨跌。</div><p class="small" style="margin-top:12px">${NOTE}</p>`;
    return;
  }
  const each = S.basketEach;
  const today = [], heldReturns = [];
  const rows = list.map(([code, i]) => {
    const s = S.stocks[i];
    const q = S.full.get(code);
    const price = q ? q.price : S.price[i], pct = q ? q.pct : S.pct[i];
    today.push(Number.isFinite(pct) ? pct : 0);
    const p = S.books[s.market].positions[code];
    const result = st.results[code];
    let detail;
    if (p && p.qty > 0) {
      const value = q ? p.qty * q.price * 100 : p.cost;
      heldReturns.push((value / p.cost - 1) * 100);
    }
    if (result) detail = `<div class="d ${result.bad ? 'bad' : 'good'}">${esc(result.text)}</div>`;
    else if (p && p.qty > 0) {
      const back = heldReturns[heldReturns.length - 1];
      detail = `<div class="d">持有 ${commas(p.qty)} 股 · 成本 ${Core.fixed(p.cost / p.qty / 100)} · 持有以来 <span class="${cls(back)}">${Core.signed(back, 1)}%</span></div>`;
    } else {
      const qty = basketQty(s, q, each);
      const least = q ? Math.ceil(q.price * basketLot(s, q)) : 0;
      detail = `<div class="d">${q ? (qty ? `按每只 ${unitOf(code)}${commas(each)} 约 ${commas(qty)} 股` : `每只金额不够一手（最少约 ${unitOf(code)}${commas(least)}）`) : '正在取报价…'}</div>`;
    }
    return `<div class="basket-row"><button class="row" data-stock="${i}"><div class="grow"><div class="t">${esc(s.name)} <span class="small">${esc(MARKET_NAME[s.market])}</span></div>${detail}</div>`
      + `<div class="n">${Core.fixed(price)}<small class="${cls(pct)}">${Core.signed(pct)}%</small></div></button><button class="drop" data-drop="${esc(code)}" aria-label="移出篮子">×</button></div>`;
  }).join('');
  const up = today.filter(v => v > 0).length, down = today.filter(v => v < 0).length;
  const avg = today.reduce((a, v) => a + v, 0) / today.length;
  const heldAvg = heldReturns.length ? heldReturns.reduce((a, v) => a + v, 0) / heldReturns.length : null;
  const anyOpen = [...new Set(list.map(([, i]) => S.stocks[i].market))].some(m => Core.sessionOpen(m, Date.now()));
  body.innerHTML = `
    <div class="sec card">
      <div class="kv"><div><span>今天上涨</span><b class="up">${up} 只</b></div><div><span>今天下跌</span><b class="down">${down} 只</b></div><div><span>平均涨跌</span><b class="${cls(avg)}">${Core.signed(avg)}%</b></div></div>
      <canvas class="chart" id="basketToday" style="height:64px;margin-top:8px"></canvas>
      <p class="small">每根柱是一只股票今天的涨跌，顺序和下面的列表一样。</p>
      ${heldAvg !== null ? `<div class="kv" style="margin-top:8px"><div><span>已持有</span><b>${heldReturns.length} 只</b></div><div><span>持有以来平均</span><b class="${cls(heldAvg)}">${Core.signed(heldAvg, 1)}%</b></div><div><span>其中赚钱</span><b>${heldReturns.filter(v => v > 0).length} 只</b></div></div>` : ''}
    </div>
    <div class="sec"><h4>篮子里的股票（点名字看个股，× 移出）</h4><div class="card">${rows}</div></div>
    <div class="sec"><h4>一起模拟买卖（分别记在对应市场的模拟账户，不连券商）</h4><div class="card">
      <div class="ticket"><span class="small" style="flex:none">每只投入</span><input id="basketEach" type="number" inputmode="numeric" value="${each}"><span class="small" style="flex:none">元</span></div>
      <div class="tabs" style="margin-top:6px">${[5000, 10000, 50000, 100000].map(v => `<button data-each="${v}" class="${v === each ? 'on' : ''}">${commas(v)}</button>`).join('')}</div>
      <p class="small" style="margin-top:4px">港股、美股按各自币种。每只按整手折算，不够一手的跳过；一起模拟卖出时每只卖掉全部可卖的股数。</p>
      <div class="actions"><button class="buy" id="basketBuy"${st.busy ? ' disabled' : ''}>一起模拟买入</button><button class="sell" id="basketSell"${st.busy ? ' disabled' : ''}>一起模拟卖出</button></div>
      <div class="msg ${st.busy ? '' : st.msgKind}">${esc(st.busy ? '正在按真实报价逐只模拟成交…' : st.msg || (anyOpen ? '交易时段按当前盘口逐只成交；休市的市场排队到下一交易时段。' : '现在不在交易时段：委托排队，下一交易时段按真实开盘价成交。'))}</div>
      <div class="acct-link"><button class="chip" id="basketRecords">${st.msg && !st.busy ? '看这次的委托和成交 ›' : '模拟账户 ›'}</button><button class="chip" id="basketClear">清空篮子</button></div>
    </div></div>
    <p class="small" style="margin-top:12px">${NOTE}</p>`;
  drawBasketBars($('basketToday'), today);
  const input = $('basketEach');
  input.oninput = () => { S.basketEach = Math.max(0, Math.floor(Number(input.value) || 0)); };
  input.onchange = () => { st.results = {}; renderBasketSheet(); };
  body.querySelectorAll('[data-each]').forEach(b => { b.onclick = () => { S.basketEach = Number(b.dataset.each); st.results = {}; renderBasketSheet(); }; });
  body.querySelectorAll('[data-drop]').forEach(b => { b.onclick = () => { dropFromBasket(b.dataset.drop); delete st.results[b.dataset.drop]; renderBasketSheet(); }; });
  bindRows(body);
  $('basketBuy').onclick = () => placeBasket('buy');
  $('basketSell').onclick = () => placeBasket('sell');
  $('basketClear').onclick = () => { S.basket = []; saveBasket(); st.results = {}; st.msg = ''; renderBasketSheet(); };
  // 篮子可能跨市场：打开篮子里股票最多的那个市场的账户，刚下过单就看今天的委托
  const counts = {};
  list.forEach(([, i]) => { const m = S.stocks[i].market; counts[m] = (counts[m] || 0) + 1; });
  const market = MARKETS.slice().sort((a, b) => (counts[b] || 0) - (counts[a] || 0))[0];
  $('basketRecords').onclick = () => openAccount(st.msg ? { market, tab: 'orders', range: 'today' } : { market, tab: 'hold' }, true);
}

function refreshBasketSheet() {
  // 用户正在输入金额时不重画，免得键盘收起
  if (document.activeElement && document.activeElement.id === 'basketEach') return;
  const top = $('sheetBody').scrollTop;
  renderBasketSheet();
  $('sheetBody').scrollTop = top;
}

/**
 * 篮子里的股票逐只按真实报价模拟成交，规则和单只下单完全一样（T+1、整手、盘口吃单、费用、休市排队）。
 * Simulate fills for each basket stock at real quotes, with exactly the same rules as single orders (T+1, lots, book walking, fees, queueing when closed).
 */
async function placeBasket(side) {
  const st = S.sheet;
  if (!st || st.kind !== 'basket' || st.busy) return;
  const list = S.basket.filter(c => S.codeIndex.has(c));
  if (!list.length) return;
  st.busy = true; st.results = {}; st.msg = '';
  renderBasketSheet();
  const fresh = {};
  for (let k = 0; k < list.length; k += BATCH) Object.assign(fresh, await fetchFull(list.slice(k, k + BATCH), 1));
  const now = Date.now();
  const word = side === 'buy' ? '买入' : '卖出';
  let done = 0, queued = 0, skipped = 0;
  for (const code of list) {
    const s = S.stocks[S.codeIndex.get(code)], market = s.market;
    const q = fresh[code] || S.full.get(code);
    if (!q) { st.results[code] = { bad: true, text: '暂时取不到报价，没有下单' }; skipped++; continue; }
    const position = S.books[market].positions[code];
    const qty = side === 'buy' ? basketQty(s, q, S.basketEach) : position ? position.avail : 0;
    if (!(qty > 0)) {
      const least = Math.ceil(q.price * basketLot(s, q));
      st.results[code] = { bad: true, text: side === 'buy' ? `每只金额不够一手（最少约 ${unitOf(code)}${commas(least)}），跳过` : position && position.qty > 0 ? 'T+1：今天模拟买入的要下一个交易日才能卖' : '没有持仓，跳过' };
      skipped++;
      continue;
    }
    const order = { code, side, qty };
    // 节假日时钟在交易时段，但报价时间不动：也按休市排队（和单只下单一样）
    if (Core.sessionLive(market, now, q.at)) {
      const r = Sim.placeNow(S.books[market], order, q, now);
      if (r.trade) {
        S.books[market] = r.book;
        done++;
        st.results[code] = { text: `模拟${word} ${commas(r.trade.qty)} 股 @ ${r.trade.price.toFixed(3)}${r.unfilled ? `，${commas(r.unfilled)} 股没成交` : ''}` };
        feedText(`<span class="name">${esc(s.name)}</span>模拟${word} ${commas(r.trade.qty)} 股 @ ${r.trade.price.toFixed(3)}`);
      } else { st.results[code] = { bad: true, text: r.reject }; skipped++; }
    } else {
      const r = Sim.queue(S.books[market], order, q, now);
      if (r.reject) { st.results[code] = { bad: true, text: r.reject }; skipped++; }
      else { S.books[market] = r.book; queued++; st.results[code] = { text: `已排队：下一交易时段按真实开盘价模拟${word} ${commas(qty)} 股` }; }
    }
  }
  saveBooks();
  if (done) { hitStage('成交'); hitStage('组合'); hitStage('净值'); }
  st.busy = false;
  st.msg = `成交 ${done} 只${queued ? `，排队 ${queued} 只` : ''}${skipped ? `，${skipped} 只没有下单（原因见每一行）` : ''}`;
  st.msgKind = done || queued ? 'good' : 'bad';
  if (S.sheet === st) renderBasketSheet();
  refreshAccount();
  renderPipeline();
}

// ---------------------------------------------------------------- 模拟账户：账号、持仓、买卖记录、委托、个股盈亏、每日对账 / Simulated account: number, positions, trades, orders, per-stock P&L, daily statement

const ACCOUNT_TABS = [['hold', '持仓'], ['trades', '买卖记录'], ['orders', '委托'], ['stocks', '个股盈亏'], ['days', '每日']];
const SIDE_WORD = { buy: '模拟买入', sell: '模拟卖出' };
const ORDER_STATUS = { filled: ['已成交', 'good'], partial: ['部分成交', 'good'], queued: ['排队中', 'wait'], rejected: ['未成交', 'bad'], cancelled: ['已撤单', 'off'] };
const RANGES = [['all', '全部'], ['today', '今天'], ['7', '近 7 天'], ['30', '近 30 天'], ['custom', '按日期']];
const MONEY_WORD = { CN: '元', HK: '港元', US: '美元' };
const accountName = (market, book) => `账号 ${Sim.accountId(market, book)}`;
const WEEKDAY = '日一二三四五六';
const PAGE = 60;
const plainCode = code => code.replace(/^(sh|sz|bj|hk|us)/, '');
const cents = (v, d = 2) => commas(v / 100, d);
/**
 * 金额（分）带正负号和千分位。
 * Amount (cents) with sign and thousands separators.
 */
const signedCents = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '-' : '') + commas(Math.abs(v) / 100, d));
const bjDay = at => Core.beijing(at).day;
const dayTitle = day => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日 周${WEEKDAY[new Date(day + 'T00:00:00Z').getUTCDay()]}`;
/**
 * 北京时间；美股过了北京午夜的，前面带上北京日期，免得和交易日对不上。
 * Beijing time; US trades past Beijing midnight get the Beijing date in front so they line up with the trading day.
 */
const timeOf = (code, at) => { const day = bjDay(at); return (day === Core.marketDay(Core.marketOf(code), at) ? '' : day.slice(5) + ' ') + Core.clock(at); };
const sideTag = side => `<b class="tag ${side}">${side === 'buy' ? '买' : '卖'}</b>`;

/**
 * 正在看的账本：现在的账户，或者存档里的一本（只读，持仓按重置那一刻的价格）。
 * The book being viewed: the current account or an archived one (read-only, positions at the prices at reset time).
 */
function accountView(st) {
  const a = st.archive !== null && st.archive !== undefined ? S.archive[st.archive] : null;
  if (a) {
    const quotes = {};
    for (const [code, h] of Object.entries(a.held || {})) if (h.qty > 0) quotes[code] = { price: h.value / h.qty / 100 };
    return { book: a, market: a.market, archived: a, quotes, ref: a.closedAt || Date.now() };
  }
  return { book: S.books[st.market], market: st.market, archived: null, quotes: Object.fromEntries(S.full), ref: Date.now() };
}

function openAccount(opts = {}, push = false) {
  const market = MARKETS.includes(opts.market) ? opts.market : accountMarket();
  const st = Object.assign({ kind: 'account', tab: 'hold', text: '', side: 'all', range: 'all', from: '', to: '', status: 'all', limit: PAGE, reset: false, archive: null }, opts, { market });
  openSheet(st, push && !!S.sheet);
  if (st.archive === null) fetchHeld(market);
}
/**
 * 账户里持仓的完整报价：平时 fullLoop 也会取，打开账户时先取一次，市值马上是新的。
 * Full quotes for held positions: fullLoop fetches them anyway, but fetch once when the account opens so market value is fresh right away.
 */
function fetchHeld(market) {
  const codes = Object.entries(S.books[market].positions).filter(([, p]) => p.qty > 0).map(([c]) => c);
  if (codes.length) fetchFull(codes.slice(0, BATCH), 1);
}

/**
 * 按“今天 / 近 7 天 / 近 30 天 / 按日期”折成起止日期（市场当地日期）。存档的账户从重置那天往前算。
 * Turn 'today / last 7 days / last 30 days / by date' into a date range (market local dates). Archived accounts count back from the reset day.
 */
function rangeDays(st, market, ref) {
  if (st.range === 'custom') return { from: st.from || '', to: st.to || '' };
  if (st.range === 'all') return { from: '', to: '' };
  const today = Core.marketDay(market, ref);
  if (st.range === 'today') return { from: today, to: today };
  const d = new Date(today + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - (Number(st.range) - 1));
  return { from: d.toISOString().slice(0, 10), to: '' };
}

function renderAccountSheet() {
  const st = S.sheet;
  const v = accountView(st);
  if (!v.book) { st.archive = null; renderAccountSheet(); return; }
  const { book, market, archived } = v;
  const account = ACCOUNTS.find(a => a.market === market);
  $('sheetTitle').textContent = archived ? '以前的模拟账户' : '模拟账户';
  $('sheetSub').textContent = archived
    ? `${accountName(market, book)} · ${book.openedAt ? bjDay(book.openedAt) : '—'} 至 ${bjDay(book.closedAt)} · 只读`
    : `${account.label} · ${accountName(market, book)} · ${book.openedAt ? bjDay(book.openedAt) + ' 开户' : '开户时间没有记录'}`;
  const archivedNote = '这是重置前存下的账户，记录只能看，不能再下单。';
  const counts = {
    hold: Object.values(book.positions).filter(p => p.qty > 0).length + (archived ? 0 : book.pending.length),
    trades: book.trades.length, orders: (book.orders || []).length, stocks: Sim.stockSummary(book, v.quotes).length, days: 0,
  };
  const body = $('sheetBody');
  body.innerHTML = `
    ${archived
      ? `<div class="sec card acct-link" style="margin-top:2px"><span class="small">${archivedNote}</span><button class="chip" id="acctNow">现在的账户 ›</button></div>`
      : `<div class="tabs" id="acctMarkets">${ACCOUNTS.map(a => `<button data-market="${a.market}" class="${a.market === market ? 'on' : ''}">${a.label}</button>`).join('')}</div>`}
    ${accountSummary(v)}
    <div class="tabs acct-tabs" id="acctTabs">${ACCOUNT_TABS.map(([id, name]) => `<button data-tab="${id}" class="${id === st.tab ? 'on' : ''}">${name}${counts[id] ? ' ' + commas(counts[id]) : ''}</button>`).join('')}</div>
    <div id="acctPane">${accountPane(st, v)}</div>
    ${archived ? '' : archiveList(market)}
    <p class="small" style="margin-top:12px">模拟账户只存在这个浏览器里，不连券商，不涉及真实资金。${NOTE}</p>`;
  bindAccount(st, body);
  if (st.tab === 'days') drawAccountCurve(v);
}

function refreshAccountSheet() {
  // 正在输入搜索词或选日期时不重画，免得键盘收起
  const active = document.activeElement;
  if (active && ['acctQ', 'acctFrom', 'acctTo'].includes(active.id)) return;
  const st = S.sheet;
  if (!st || st.kind !== 'account' || st.archive !== null) return;
  const top = $('sheetBody').scrollTop;
  renderAccountSheet();
  $('sheetBody').scrollTop = top;
}

function accountSummary(v) {
  const { book, market, archived } = v;
  const realized = Object.values(book.positions).reduce((a, p) => a + (p.realized || 0), 0);
  const feesPaid = Object.values(book.positions).reduce((a, p) => a + (p.fees || 0), 0);
  const word = `<p class="small" style="margin-top:6px">金额单位：${MONEY_WORD[market]}。盈亏都扣过佣金、印花税等费用。</p>`;
  if (archived) {
    const pnl = book.final - book.capital;
    return `<div class="sec card"><div class="kv">
      <div><span>结束时总资产</span><b>${cents(book.final)}</b></div><div><span>累计盈亏</span><b class="${cls(pnl)}">${signedCents(pnl)}</b></div><div><span>收益率</span><b class="${cls(pnl)}">${Core.signed(pnl / book.capital * 100)}%</b></div>
      <div><span>本金</span><b>${cents(book.capital, 0)}</b></div><div><span>已实现盈亏</span><b class="${cls(realized)}">${signedCents(realized)}</b></div><div><span>累计费用</span><b>${cents(feesPaid)}</b></div></div>${word}</div>`;
  }
  const e = Sim.equity(book, v.quotes);
  return `<div class="sec card"><div class="kv">
    <div><span>总资产</span><b>${cents(e.total)}</b></div><div><span>持仓市值</span><b>${cents(e.market)}</b></div><div><span>可用现金</span><b>${cents(e.cash)}</b></div>
    <div><span>今日盈亏</span><b class="${cls(e.dayPnl)}">${signedCents(e.dayPnl)}</b></div><div><span>累计盈亏</span><b class="${cls(e.pnl)}">${signedCents(e.pnl)}</b></div><div><span>收益率</span><b class="${cls(e.pnl)}">${Core.signed(e.pnl / book.capital * 100)}%</b></div>
    <div><span>本金</span><b>${cents(book.capital, 0)}</b></div><div><span>已实现盈亏</span><b class="${cls(realized)}">${signedCents(realized)}</b></div><div><span>累计费用</span><b>${cents(feesPaid)}</b></div></div>
    ${e.missing.length ? `<p class="small" style="margin-top:6px">${e.missing.length} 只持仓还没取到报价，先按成本估。</p>` : ''}${word}</div>`;
}

function accountPane(st, v) {
  if (st.tab === 'trades') return filterBar(st, v, '搜股票名称或代码，看它的每一笔买卖') + `<div id="acctResults">${tradeResults(st, v)}</div>` + rulesNote(st);
  if (st.tab === 'orders') return filterBar(st, v, '搜股票名称或代码') + `<div id="acctResults">${orderResults(st, v)}</div>`;
  if (st.tab === 'stocks') return stocksPane(v);
  if (st.tab === 'days') return daysPane(v);
  return holdPane(st, v);
}

function holdPane(st, v) {
  const { book, archived, quotes } = v;
  const rows = Object.entries(book.positions).filter(([, p]) => p.qty > 0).map(([code, p]) => {
    const q = quotes[code];
    const value = q ? Math.round(p.qty * q.price * 100) : p.cost;
    const pnl = value - p.cost;
    const i = S.codeIndex.get(code);
    return `<button class="row"${i !== undefined ? ` data-stock="${i}"` : ''}><div class="grow"><div class="t">${esc(p.name)} <span class="code">${esc(plainCode(code))}</span></div>
      <div class="d">${commas(p.qty)} 股${archived ? '' : ` · 可卖 ${commas(p.avail)}`} · 成本 ${Core.fixed(p.cost / p.qty / 100, 3)}${q ? ` · ${archived ? '重置时' : '现价'} ${Core.fixed(q.price, 3)}` : ' · 还没取到报价，按成本估'}</div></div>
      <div class="n">${cents(value)}<small class="${cls(pnl)}">${signedCents(pnl)} · ${Core.signed(pnl / p.cost * 100, 1)}%</small></div></button>`;
  }).join('');
  const pending = archived ? '' : book.pending.map((o, k) => `<div class="row"><div class="grow"><div class="t">${sideTag(o.side)}${esc(o.name)} · 排队中</div><div class="d">${SIDE_WORD[o.side]} ${commas(o.qty)} 股，等下一交易时段按真实价格成交</div></div><button class="chip" data-cancel="${k}">撤单</button></div>`).join('');
  const empty = archived ? '重置时没有持仓。' : '现在没有持仓。点星云里的股票，或者在「信号」里选一只，用真实盘口模拟买入。';
  return `<div class="sec card">${rows || pending ? rows + pending : `<p class="small">${empty}</p>`}</div>${archived ? '' : resetBlock(st, v)}`;
}

function resetBlock(st, v) {
  const { book, market } = v;
  const unit = ACCOUNTS.find(a => a.market === market).unit;
  if (!st.reset) return `<div class="acct-link"><span class="small">重置会换一个新账号，现在的持仓和买卖记录存进「以前的账户」，以后还能查。</span><button class="chip" id="acctReset">重置账户</button></div>`;
  const next = Sim.accountId(market, { no: (book.no || 1) + 1 });
  return `<div class="sec card"><p class="small">选新账户的本金。${Sim.used(book) ? `现在的账号 ${Sim.accountId(market, book)} 存进「以前的账户」：持仓按现价记下，买卖记录、委托都还能查。新账号是 ${next}。` : '这个账户还没用过，只换本金，账号不变。'}</p>
    <div class="tabs" style="margin-top:6px">${[10000, 100000, 1000000].map(x => `<button data-capital="${x}">${unit}${commas(x)}</button>`).join('')}<button data-capital="">取消</button></div></div>`;
}

/**
 * 买卖记录和委托共用的筛选：搜索、方向、时间。
 * Shared filters for trades and orders: search, side, time.
 */
function filterBar(st, v, hint) {
  const statuses = [['all', '全部'], ['queued', '排队中'], ['filled', '已成交'], ['failed', '未成交 / 撤单']];
  return `<div class="sec filters">
    <input class="search" id="acctQ" placeholder="${esc(hint)}" autocomplete="off" value="${esc(st.text)}">
    <div class="tabs">${[['all', '全部'], ['buy', '模拟买入'], ['sell', '模拟卖出']].map(([id, name]) => `<button data-side="${id}" class="${st.side === id ? 'on' : ''}">${name}</button>`).join('')}</div>
    <div class="tabs">${RANGES.map(([id, name]) => `<button data-range="${id}" class="${st.range === id ? 'on' : ''}">${name}</button>`).join('')}</div>
    ${st.range === 'custom' ? `<div class="dates"><input type="date" id="acctFrom" value="${esc(st.from)}"><span>至</span><input type="date" id="acctTo" value="${esc(st.to)}"></div>` : ''}
    ${st.tab === 'orders' ? `<div class="tabs">${statuses.map(([id, name]) => `<button data-status="${id}" class="${st.status === id ? 'on' : ''}">${name}</button>`).join('')}</div>` : ''}
  </div>`;
}

/**
 * 按交易日分组，每组前面一行日期和笔数。
 * Group by trading day, each group headed by the date and count.
 */
function groupedRows(items, dayOf, row, limit) {
  const perDay = {};
  items.forEach(x => { const d = dayOf(x); perDay[d] = (perDay[d] || 0) + 1; });
  let html = '', last = '';
  for (const x of items.slice(0, limit)) {
    const d = dayOf(x);
    if (d !== last) { html += `<div class="day-head"><span>${d ? dayTitle(d) : '日期没有记录'}</span><span>${perDay[d]} 笔</span></div>`; last = d; }
    html += row(x);
  }
  return html;
}

function tradeResults(st, v) {
  const { book, market } = v;
  const span = rangeDays(st, market, v.ref);
  const hits = Sim.filterTrades(book.trades, { text: st.text, side: st.side, from: span.from, to: span.to }).slice().reverse();
  const sum = Sim.tradeTotals(hits);
  const filtered = st.text.trim() || st.side !== 'all' || st.range !== 'all';
  // 搜的股票在别的币种账户里也有记录：给个入口
  const others = st.text.trim() && !v.archived
    ? MARKETS.filter(m => m !== market).map(m => [m, Sim.filterTrades(S.books[m].trades, { text: st.text }).length]).filter(([, n]) => n) : [];
  const hint = others.length ? `<div class="acct-link">${others.map(([m, n]) => `<button class="chip" data-switch="${m}">${ACCOUNTS.find(a => a.market === m).label}有 ${n} 笔 ›</button>`).join('')}</div>` : '';
  if (!hits.length) {
    return `<div class="sec card small">${book.trades.length ? '没有符合条件的买卖记录。' : v.archived ? '这个账户没有成交过。' : '还没有成交。模拟买入或模拟卖出成交后，每一笔都记在这里：时间、股数、价格、费用和模拟卖出的盈亏。'}</div>${hint}`;
  }
  const row = t => {
    const gain = t.side === 'sell'
      ? `<small class="${t.realized === null || t.realized === undefined ? 'flat' : cls(t.realized)}">盈亏 ${t.realized === null || t.realized === undefined ? '—' : signedCents(t.realized)}</small>`
      : `<small class="flat">&nbsp;</small>`;
    // 排队的委托按开盘价成交：时间写“开盘价”，记账时间在明细里
    return `<button class="row" data-trade="${t.no || 0}" data-at="${t.at}"><div class="grow"><div class="t">${sideTag(t.side)}${esc(t.name)} <span class="code">${esc(plainCode(t.code))}</span></div>
      <div class="d">${t.basis === 'open' ? '开盘价' : timeOf(t.code, t.at)} · ${commas(t.qty)} 股 @ ${Core.fixed(t.price, 3)} · 费用 ${cents(t.fee ? t.fee.total : 0)}</div></div>
      <div class="n">${cents(t.amount)}${gain}</div></button>`;
  };
  const parts = [
    sum.buys ? `模拟买入 ${sum.buys} 笔共 ${cents(sum.buyAmt)}` : '',
    sum.sells ? `模拟卖出 ${sum.sells} 笔共 ${cents(sum.sellAmt)}` : '',
    `费用 ${cents(sum.fees)}`,
    sum.sells ? `模拟卖出盈亏 <b class="${cls(sum.realized)}">${signedCents(sum.realized)}</b>${sum.realizedKnown ? '' : '（早期记录不全，只算了能算的）'}` : '',
  ].filter(Boolean).join('，');
  return `<div class="sec card small sum">${filtered ? '符合条件的' : '全部'} ${commas(sum.n)} 笔：${parts}。</div>
    ${hint}
    <div class="sec card">${groupedRows(hits, t => Core.marketDay(market, t.at), row, st.limit)}</div>
    ${hits.length > st.limit ? `<button class="more" id="acctMore">再显示 ${Math.min(PAGE, hits.length - st.limit)} 笔（还有 ${commas(hits.length - st.limit)} 笔）</button>` : ''}
    <p class="small" style="margin-top:6px">点一笔看明细。时间是北京时间。</p>`;
}

function orderResults(st, v) {
  const { book, market, archived } = v;
  const span = rangeDays(st, market, v.ref);
  const text = st.text.trim().toLowerCase();
  const list = (book.orders || []).filter(o => {
    if (st.status === 'queued' && o.status !== 'queued') return false;
    if (st.status === 'filled' && o.status !== 'filled' && o.status !== 'partial') return false;
    if (st.status === 'failed' && o.status !== 'rejected' && o.status !== 'cancelled') return false;
    if (st.side !== 'all' && o.side !== st.side) return false;
    if (text && !(o.code.toLowerCase().includes(text) || String(o.name || '').toLowerCase().includes(text))) return false;
    const day = o.at ? Core.marketDay(market, o.at) : '';
    if (span.from && day < span.from) return false;
    if (span.to && day > span.to) return false;
    return true;
  }).slice().reverse();
  if (!list.length) {
    return `<div class="sec card small">${(book.orders || []).length ? '没有符合条件的委托。' : '还没有委托。'}股数不合规、可卖不够这类当场就提示的，不算委托，不记在这里。</div>`;
  }
  const row = o => {
    const [label, kind] = ORDER_STATUS[o.status] || [o.status, ''];
    const detail = o.status === 'filled' || o.status === 'partial'
      ? `成交 ${commas(o.filled)} 股 @ ${Core.fixed(o.price, 3)}${o.via === 'queue' ? '（排队后成交）' : ''}${o.reason ? '，' + esc(o.reason) : ''}`
      : o.status === 'queued' ? '等下一交易时段按真实价格成交'
        : o.status === 'cancelled' ? `撤单${o.done ? '于 ' + timeOf(o.code, o.done) : ''}`
          : esc(o.reason || '没有成交');
    const k = o.status === 'queued' && !archived ? book.pending.findIndex(p => p.no === o.no) : -1;
    return `<div class="row"><div class="grow"><div class="t">${sideTag(o.side)}${esc(o.name)} <span class="code">${esc(plainCode(o.code))}</span> · ${commas(o.qty)} 股</div>
      <div class="d">${o.at ? timeOf(o.code, o.at) : '—'} · ${detail}</div></div>
      ${k >= 0 ? `<button class="chip" data-cancel="${k}">撤单</button>` : `<span class="badge ${kind}">${label}</span>`}</div>`;
  };
  const n = s => list.filter(o => s.includes(o.status)).length;
  return `<div class="sec card small sum">${commas(list.length)} 笔委托：已成交 ${n(['filled', 'partial'])}，排队中 ${n(['queued'])}，未成交 ${n(['rejected'])}，已撤单 ${n(['cancelled'])}。</div>
    <div class="sec card">${groupedRows(list, o => (o.at ? Core.marketDay(market, o.at) : ''), row, st.limit)}</div>
    ${list.length > st.limit ? `<button class="more" id="acctMore">再显示 ${Math.min(PAGE, list.length - st.limit)} 笔（还有 ${commas(list.length - st.limit)} 笔）</button>` : ''}
    <p class="small" style="margin-top:6px">股数不合规、可卖不够这类当场就提示的，不算委托，不记在这里。</p>`;
}

function stocksPane(v) {
  const rows = Sim.stockSummary(v.book, v.quotes);
  if (!rows.length) return `<div class="sec card small">${v.archived ? '这个账户没有买卖过股票。' : '还没有买卖过股票。'}</div>`;
  const total = rows.reduce((a, r) => a + r.total, 0);
  const win = rows.filter(r => r.total > 0).length, lose = rows.filter(r => r.total < 0).length;
  return `<div class="sec card"><div class="kv"><div><span>做过</span><b>${rows.length} 只</b></div><div><span>赚钱 / 亏钱</span><b><em class="up">${win}</em> / <em class="down">${lose}</em></b></div><div><span>合计盈亏</span><b class="${cls(total)}">${signedCents(total)}</b></div></div>
    <p class="small" style="margin-top:6px">持有中的按${v.archived ? '重置时的价格' : '现价'}算浮动盈亏，卖掉的部分算已实现盈亏，都扣过费用。点一只看它的每一笔买卖。</p></div>
    <div class="sec card">${rows.map(r => `<button class="row" data-records="${esc(plainCode(r.code))}"><div class="grow"><div class="t">${esc(r.name)} <span class="code">${esc(plainCode(r.code))}</span> <span class="badge ${r.qty > 0 ? 'good' : 'off'}">${r.qty > 0 ? `持有 ${commas(r.qty)} 股` : '已清仓'}</span></div>
      <div class="d">买 ${commas(r.bought)} 股 ${cents(r.boughtAmt, 0)} · 卖 ${commas(r.sold)} 股 ${cents(r.soldAmt, 0)} · 费 ${cents(r.fees)}${r.partial ? ' · 早期记录不全' : ''}${r.priced ? '' : ' · 还没取到报价，按成本估'}</div></div>
      <div class="n ${cls(r.total)}">${signedCents(r.total)}<small class="flat">${[r.qty > 0 ? `浮动 ${signedCents(r.floating)}` : '', r.realized || !r.qty ? `已实现 ${signedCents(r.realized)}` : ''].filter(Boolean).join(' · ')}</small></div></button>`).join('')}</div>`;
}

/**
 * 每日对账：每个交易日收盘的总资产和当天盈亏，今天的按现价（盘中）。
 * Daily statement: equity at each trading day's close and that day's P&L; today uses current prices (intraday).
 */
function dayPoints(v) {
  const { book, archived } = v;
  const points = (book.equityDays || []).map(p => [p[0], p[1], false]);
  if (!archived && book.day && (!points.length || points[points.length - 1][0] < book.day)) points.push([book.day, Sim.equity(book, v.quotes).total, true]);
  return points;
}
function daysPane(v) {
  const { book, market } = v;
  const points = dayPoints(v);
  if (!points.length) return '<div class="sec card small">每个交易日收盘后记一次总资产，打开过星云的交易日都有记录。</div>';
  const perDay = {};
  book.trades.forEach(t => { const d = Core.marketDay(market, t.at); perDay[d] = (perDay[d] || 0) + 1; });
  const rows = points.map((p, k) => ({ day: p[0], total: p[1], live: p[2], change: p[1] - (k ? points[k - 1][1] : book.capital), n: perDay[p[0]] || 0 })).reverse();
  return `<div class="sec card">${points.length >= 2 ? '<canvas class="chart" id="acctCurve" style="height:110px"></canvas>' : ''}
    <p class="small">${points.length >= 2 ? `${esc(points[0][0])} 起，每个交易日收盘记一个点，灰线是本金。` : '至少两个交易日才有曲线。'}</p></div>
    <div class="sec card">${rows.map(r => `<button class="row" data-day="${r.day}"><div class="grow"><div class="t">${dayTitle(r.day)}${r.live ? ' · 今天，按最新价' : ''}</div><div class="d">${r.n ? `成交 ${r.n} 笔，点开看明细` : '这天没有成交'}</div></div>
      <div class="n">${cents(r.total)}<small class="${cls(r.change)}">${signedCents(r.change)}</small></div></button>`).join('')}</div>`;
}
function drawAccountCurve(v) {
  const canvas = $('acctCurve');
  if (!canvas) return;
  drawSeries(canvas, dayPoints(v).map(p => p[1] / v.book.capital), { zero: 1 });
}

/**
 * 以前的账户：这个币种重置前存下的。
 * Previous accounts: the ones saved before resets in this currency.
 */
function archiveList(market) {
  const own = S.archive.map((a, k) => [a, k]).filter(([a]) => a.market === market);
  const row = ([a, k]) => {
    const pnl = a.final - a.capital;
    return `<button class="row" data-archive="${k}"><div class="grow"><div class="t">${accountName(a.market, a)}</div><div class="d">${a.openedAt ? bjDay(a.openedAt) : '—'} 至 ${bjDay(a.closedAt)} · 本金 ${cents(a.capital, 0)} · ${commas(a.trades.length)} 笔成交</div></div>
      <div class="n">${cents(a.final, 0)}<small class="${cls(pnl)}">${Core.signed(pnl / a.capital * 100)}%</small></div></button>`;
  };
  return own.length ? `<div class="sec"><h4>以前的账户（重置前存下的，记录还能查）</h4><div class="card">${own.map(row).join('')}</div></div>` : '';
}

function rulesNote(st) {
  return `<details class="sec rules" id="acctRules"${st.rulesOpen ? ' open' : ''}><summary>模拟成交按什么规则</summary><div class="card">
    <div class="check"><i>·</i><span>A 股 T+1：今天买的下一交易日才能卖。一手 100 股（科创板最少 200 股）。</span></div>
    <div class="check"><i>·</i><span>费用：佣金万 2.5（最低 5 元）、过户费十万分之一、印花税万分之五（只在卖的时候收）。港股：印花税 0.1%（双边）、交易费和征费合计 0.0085%、佣金万 3。</span></div>
    <div class="check"><i>·</i><span>美股 T+0、最少 1 股、没有涨跌停。佣金约万 1（最低 1 美元）、卖的时候规费约十万分之三，按常见费率估算。行情没有盘口数据，按最新价估算成交，单笔不超过当天成交量的 1%。</span></div>
    <div class="check"><i>·</i><span>A 股、港股按真实五档盘口逐档吃单，超过五档总量的部分不成交。</span></div>
    <div class="check"><i>·</i><span>封涨停没有卖盘买不进，封跌停没有买盘卖不出，停牌不成交。</span></div>
    <div class="check"><i>·</i><span>收盘后下单排队，下一交易时段按真实开盘价成交；一字涨跌停继续排队。</span></div>
  </div></details>`;
}

function bindAccount(st, body) {
  const rerender = (patch = {}) => { Object.assign(st, patch); renderAccountSheet(); };
  body.querySelectorAll('[data-market]').forEach(b => { b.onclick = () => { rerender({ market: b.dataset.market, reset: false, limit: PAGE }); body.scrollTop = 0; fetchHeld(b.dataset.market); }; });
  body.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => rerender({ tab: b.dataset.tab, limit: PAGE, reset: false }); });
  body.querySelectorAll('[data-side]').forEach(b => { b.onclick = () => rerender({ side: b.dataset.side, limit: PAGE }); });
  body.querySelectorAll('[data-status]').forEach(b => { b.onclick = () => rerender({ status: b.dataset.status, limit: PAGE }); });
  body.querySelectorAll('[data-range]').forEach(b => { b.onclick = () => {
    const range = b.dataset.range;
    // 第一次点“按日期”：默认就是今天，改起来方便
    const today = Core.marketDay(st.market, accountView(st).ref);
    rerender(range === 'custom' && !st.from && !st.to ? { range, from: today, to: today, limit: PAGE } : { range, limit: PAGE });
  }; });
  body.querySelectorAll('[data-archive]').forEach(b => { b.onclick = () => openAccount({ market: st.market, archive: Number(b.dataset.archive), tab: 'trades' }, true); });
  body.querySelectorAll('[data-day]').forEach(b => { b.onclick = () => rerender({ tab: 'trades', range: 'custom', from: b.dataset.day, to: b.dataset.day, text: '', side: 'all', limit: PAGE }); });
  body.querySelectorAll('[data-records]').forEach(b => { b.onclick = () => rerender({ tab: 'trades', text: b.dataset.records, side: 'all', range: 'all', limit: PAGE }); });
  const now = $('acctNow');
  if (now) now.onclick = () => {
    // 从现在的账户点进来的就退回去；否则就地换成现在的账户
    const prev = S.sheetStack[S.sheetStack.length - 1];
    if (prev && prev.kind === 'account' && prev.archive === null) sheetBack(); else rerender({ archive: null, reset: false, limit: PAGE });
  };
  const q = $('acctQ');
  if (q) q.oninput = () => { st.text = q.value; st.limit = PAGE; paintResults(st); };
  const from = $('acctFrom'), to = $('acctTo');
  if (from) from.onchange = () => { st.from = from.value; paintResults(st); };
  if (to) to.onchange = () => { st.to = to.value; paintResults(st); };
  const rules = $('acctRules');
  if (rules) rules.ontoggle = () => { st.rulesOpen = rules.open; };
  const reset = $('acctReset');
  if (reset) reset.onclick = () => rerender({ reset: true });
  body.querySelectorAll('[data-capital]').forEach(b => { b.onclick = () => {
    if (!b.dataset.capital) { rerender({ reset: false }); return; }
    const kept = resetBook(st.market, Number(b.dataset.capital));
    rerender({ reset: false, tab: 'hold' });
    if (kept) feedText(`<span class="name">${esc(ACCOUNTS.find(a => a.market === st.market).label)}</span>已重置，旧账户的记录在「以前的账户」里`);
  }; });
  bindResults(st, body);
}

/**
 * 列表里的点击：成交明细、个股、撤单、翻页、切到别的币种账户。搜索和选日期时只重画这一块。
 * Clicks in the lists: trade details, stocks, cancel, paging, switching currency accounts. Searching and picking dates only redraw this part.
 */
function bindResults(st, root) {
  bindRows(root);
  root.querySelectorAll('[data-trade]').forEach(b => { b.onclick = () => openSheet({ kind: 'trade', market: st.market, archive: st.archive, no: Number(b.dataset.trade), at: Number(b.dataset.at) }, true); });
  root.querySelectorAll('[data-cancel]').forEach(b => { b.onclick = () => {
    S.books[st.market] = Sim.cancelPending(S.books[st.market], Number(b.dataset.cancel), Date.now());
    saveBooks(); refreshAccount(); renderPipeline(); renderAccountSheet();
  }; });
  root.querySelectorAll('[data-switch]').forEach(b => { b.onclick = () => { st.market = b.dataset.switch; st.limit = PAGE; renderAccountSheet(); fetchHeld(st.market); }; });
  const more = root.querySelector('#acctMore');
  if (more) more.onclick = () => { st.limit += PAGE; paintResults(st); };
}
function paintResults(st) {
  const box = $('acctResults');
  if (!box) return;
  const v = accountView(st);
  box.innerHTML = st.tab === 'orders' ? orderResults(st, v) : tradeResults(st, v);
  bindResults(st, box);
}

/**
 * 一笔成交的明细。
 * Details of one trade.
 */
function renderTradeSheet() {
  const st = S.sheet;
  const book = st.archive !== null && st.archive !== undefined ? S.archive[st.archive] : S.books[st.market];
  const t = book && book.trades.find(x => (st.no ? x.no === st.no : x.at === st.at));
  const body = $('sheetBody');
  $('sheetTitle').textContent = t ? `${SIDE_WORD[t.side]} · ${t.name}` : '成交明细';
  $('sheetSub').textContent = t ? `${plainCode(t.code)} · ${ACCOUNTS.find(a => a.market === st.market).label} · ${accountName(st.market, book)}` : '';
  if (!t) { body.innerHTML = '<div class="sec card small">这笔记录找不到了，账户可能已经重置。重置前的记录在「以前的账户」里。</div>'; return; }
  const us = t.code.startsWith('us');
  const order = (book.orders || []).find(o => o.no === t.no && t.no);
  const how = t.basis === 'open' ? '收盘后下的单排队，下一交易日按真实开盘价成交' : us ? '按当时的最新价估算（美股行情没有盘口）' : '按当时的真实五档盘口逐档成交';
  const ny = us ? Core.newYork(t.at) : null;
  const nyText = ny ? `（美东 ${ny.day.slice(5)} ${String(Math.floor(ny.minute / 60)).padStart(2, '0')}:${String(ny.minute % 60).padStart(2, '0')}）` : '';
  const fee = t.fee || { commission: 0, stamp: 0, transfer: 0, levy: 0, total: 0 };
  const known = t.realized !== null && t.realized !== undefined;
  const i = S.codeIndex.get(t.code);
  body.innerHTML = `<div class="sec card"><div class="kv">
      <div><span>方向</span><b class="${t.side === 'buy' ? 'up' : 'down'}">${SIDE_WORD[t.side]}</b></div><div><span>成交数量</span><b>${commas(t.qty)} 股</b></div><div><span>成交均价</span><b>${Core.fixed(t.price, 3)}</b></div>
      <div><span>成交金额</span><b>${cents(t.amount)}</b></div><div><span>费用合计</span><b>${cents(fee.total)}</b></div><div><span>${t.side === 'buy' ? '实际付出' : '实际收到'}</span><b>${cents(t.side === 'buy' ? t.amount + fee.total : t.amount - fee.total)}</b></div>
    </div><p class="small" style="margin-top:6px">金额单位：${MONEY_WORD[st.market]}</p></div>
    <div class="sec card lines">
      <div><span>成交时间</span><b>${t.basis === 'open'
        ? `${Core.marketDay(st.market, t.at)} 开盘价（北京时间 ${Core.clock(t.at)} 记账）`
        : `北京时间 ${bjDay(t.at)} ${Core.clock(t.at)}${nyText}`}</b></div>
      <div><span>成交方式</span><b>${how}</b></div>
      <div><span>佣金</span><b>${cents(fee.commission)}</b></div>
      <div><span>印花税</span><b>${cents(fee.stamp)}</b></div>
      <div><span>过户费</span><b>${cents(fee.transfer)}</b></div>
      <div><span>交易费和征费</span><b>${cents(fee.levy)}</b></div>
      ${t.side === 'sell' ? `<div><span>这笔模拟卖出的盈亏</span><b class="${known ? cls(t.realized) : ''}">${known ? signedCents(t.realized) + '（扣过买卖两边的费用）' : '早期记录不全，算不出'}</b></div>` : ''}
      ${t.cashAfter !== undefined ? `<div><span>成交后现金</span><b>${cents(t.cashAfter)}</b></div>` : ''}
      ${order ? `<div><span>委托</span><b>第 ${order.no} 号 · ${order.via === 'queue' ? '排队委托' : '即时委托'} · 委托 ${commas(order.qty)} 股${order.reason ? '，' + esc(order.reason) : ''}</b></div>` : ''}
    </div>
    <div class="actions">${i !== undefined ? '<button class="alt" id="tradeStock">看这只股票</button>' : ''}<button class="alt" id="tradeAll">这只的全部买卖</button></div>
    <p class="small" style="margin-top:12px">模拟成交，不连券商，不涉及真实资金。${NOTE}</p>`;
  const stock = $('tradeStock');
  if (stock) stock.onclick = () => openStock(i);
  $('tradeAll').onclick = () => {
    const prev = S.sheetStack[S.sheetStack.length - 1];
    if (prev && prev.kind === 'account') { Object.assign(prev, { tab: 'trades', text: plainCode(t.code), side: 'all', range: 'all', limit: PAGE }); sheetBack(); }
    else openAccount({ market: st.market, archive: st.archive, tab: 'trades', text: plainCode(t.code) }, true);
  };
}

$('acctBtn').onclick = () => openAccount();
$('acctBox').onclick = () => {
  // 回放规则时这里显示的是规则的回测净值，点开看净值；其他时候是自己的模拟账户
  if (S.mode === 'replay' && S.history && testFor(currentRule())) openStage('净值'); else openAccount();
};

// ---------------------------------------------------------------- 手势 / Gestures

const pointers = new Map();
let gesture = null;
overlay.addEventListener('pointerdown', e => {
  overlay.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) { gesture = { startX: e.clientX, startY: e.clientY, moved: 0, at: performance.now() }; scene.drag.active = true; }
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; gesture = { pinch: Math.hypot(a.x - b.x, a.y - b.y), zoom: S.zoom || 1, moved: 99 }; }
});
overlay.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p || !gesture) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (pointers.size === 2 && gesture.pinch) {
    const [a, b] = [...pointers.values()];
    S.zoom = clamp(gesture.zoom * Math.hypot(a.x - b.x, a.y - b.y) / gesture.pinch, 0.75, 2.2);
    layoutInfo.r = stageRadius(layoutInfo.stage) * S.zoom;
    applyStageFrame(false);
    return;
  }
  gesture.moved += Math.abs(dx) + Math.abs(dy);
  if (gesture.moved > 6) scene.rotateBy(dx * 0.0068, dy * 0.0068);
});
const endPointer = e => {
  pointers.delete(e.pointerId);
  if (pointers.size) return;
  scene.drag.active = false;
  if (gesture && gesture.moved <= 8 && !gesture.pinch) tap(e.clientX, e.clientY);
  gesture = null;
};
overlay.addEventListener('pointerup', endPointer);
overlay.addEventListener('pointercancel', e => { pointers.delete(e.pointerId); scene.drag.active = false; gesture = null; });
overlay.addEventListener('wheel', e => {
  e.preventDefault();
  S.zoom = clamp((S.zoom || 1) * Math.exp(-e.deltaY * 0.001), 0.75, 2.2);
  layoutInfo.r = stageRadius(layoutInfo.stage) * S.zoom;
  applyStageFrame(false);
}, { passive: false });

function tap(x, y) {
  if (S.sheet) { closeSheet(); return; }
  for (const n of nodes.left) if (Math.hypot(n.x - x, n.y + 10 - y) < 26) { openStage('采集'); return; }
  for (const n of nodes.right) if (Math.hypot(n.x - x, n.y + 10 - y) < 26) { openSheet({ kind: 'stage', stage: '信号', rule: n.rule }); return; }
  // 外盘上的涨跌榜标签：点了进个股。点在星云范围内就算点粒子
  const inside = Math.hypot(x - scene.frameCur.cx, y - scene.frameCur.cy) < scene.frameCur.radius * 1.08;
  if (!inside) {
    const label = scene.pickDial(x, y);
    if (label) { openStock(label.index); return; }
  }
  const i = scene.pick(x, y);
  if (i >= 0) openStock(i);
}

window.addEventListener('resize', () => { layout(); });
renderIndices();
renderMarket();
boot().catch(err => { console.error(err); $('modeText').textContent = '暂时用不了，请稍后再试'; });
