'use strict';
/*
 * 问金寻银 · 界面语言（中文 / English）。
 * 代码里的界面文字以中文为准，写成 T`…`；英文在 nebula-lang-en.js 里按中文原句对照。没有对照的句子照原样显示中文。
 * 语言怎么定：地址里的 ?lang=en / ?lang=zh 优先，其次是上次选的（存在这个浏览器里），再其次看浏览器语言（中文环境用中文，其余用英文）。
 *
 * Wenjin Xunyin · interface language (Chinese / English).
 * Chinese is the source language in the code, written as T`…`; nebula-lang-en.js maps each Chinese sentence to English. A sentence without a mapping is shown in Chinese.
 * How the language is chosen: ?lang=en / ?lang=zh in the address wins, then the last choice (stored in this browser), then the browser language (Chinese locales get Chinese, everything else English).
 */
(function (root, factory) {
  const en = typeof module === 'object' && module.exports ? require('./nebula-lang-en.js') : root.NebulaLangEn;
  const api = factory(root, en || {});
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.NebulaI18n = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root, EN) {
  const KEY = 'wenjin.lang';

  function pick() {
    try {
      if (!root.document) return 'zh';   // 不在浏览器页面里（比如在 Node 里 require）：固定用中文
      const asked = root.location && /[?&]lang=(en|zh)\b/.exec(root.location.search || '');
      if (asked) return asked[1];
      const saved = root.localStorage && root.localStorage.getItem(KEY);
      if (saved === 'en' || saved === 'zh') return saved;
      const nav = root.navigator && root.navigator.language;
      if (nav) return /^zh\b/i.test(nav) ? 'zh' : 'en';
    } catch (e) { /* 地址或存储读不到：用中文 */ }
    return 'zh';
  }

  const lang = pick();
  const missing = new Set();   // 英文界面下没找到对照的句子，调试时看 NebulaI18n.missing
  const join = (strings, values) => { let s = strings[0]; for (let i = 0; i < values.length; i++) s += values[i] + strings[i + 1]; return s; };

  /**
   * 带标签的模板：T`模拟买入 ${qty} 股`。中文界面原样拼出来；英文界面用“模拟买入 {} 股”去查对照，对照里的 {0}、{1} 换成对应的值（顺序可以和中文不同）。
   * Tagged template: T`模拟买入 ${qty} 股`. Chinese mode returns the string as written; English mode looks up "模拟买入 {} 股" and fills {0}, {1}… with the values (their order may differ from the Chinese).
   */
  function T(strings, ...values) {
    if (lang === 'zh') return join(strings, values);
    const key = strings.join('{}');
    const found = EN[key];
    if (found === undefined) { missing.add(key); return join(strings, values); }
    return found.replace(/\{(\d+)\}/g, (whole, n) => (Number(n) < values.length ? values[Number(n)] : whole));
  }

  /**
   * 整句查对照：给变量里存着的固定词用（比如流程条上的“采集”“清洗”），也给数据里带来的名字用（行业名），查不到就原样返回。
   * Whole-string lookup: for fixed words held in variables (pipeline stage names) and for names that come with the data (industries). Returns the input when there is no mapping.
   */
  function tr(text) {
    if (lang === 'zh' || typeof text !== 'string') return text;
    const found = EN[text];
    return found === undefined ? text : found;
  }

  /**
   * 换语言：记住选择，去掉地址里的 lang 参数后重新载入页面。
   * Switch language: remember the choice, drop the lang parameter from the address and reload.
   */
  function setLang(next) {
    let saved = false;
    try { root.localStorage.setItem(KEY, next); saved = root.localStorage.getItem(KEY) === next; } catch (e) { /* 存不了：把语言写进地址，只对这一次生效 */ }
    const url = new URL(root.location.href);
    url.searchParams.delete('lang');
    if (!saved) url.searchParams.set('lang', next);
    root.location.replace(url.toString());
  }

  // 模拟交易引擎给出的原因里带数字的那几种句式（引擎只产出中文，账本里存的也是中文，显示时才翻）
  const REASONS = ['港股这只每手 {} 股，请按整手', 'T+1：今天模拟买入的 {} 股要下一个交易日才能卖，现在可卖 {} 股', '可卖只有 {} 股',
    '超过当天成交量的 1%，{} 股没成交', '五档盘口不够，{} 股没成交', '{}，委托取消'];
  const literal = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reasonPatterns = REASONS.map(key => ({ key, re: new RegExp('^' + key.split('{}').map(literal).join('(.+?)') + '$') }));

  /**
   * 翻译模拟交易引擎返回的原因（下单被拒、没成交完、撤单）。引擎和账本里一律是中文，所以换语言后旧记录也能跟着换。
   * 先整句查对照；查不到再按上面几种带数字的句式去套；都对不上就原样返回。
   * Translate a reason returned by the simulated trading engine (order rejected, partly filled, cancelled). The engine and the saved
   * books always hold Chinese, so old records follow the language switch. Whole-string lookup first, then the few templates above that carry numbers; otherwise the input is returned.
   */
  function trMsg(text) {
    if (lang === 'zh' || typeof text !== 'string') return text;
    if (EN[text] !== undefined) return EN[text];
    for (const { key, re } of reasonPatterns) {
      const found = re.exec(text);
      if (found && EN[key] !== undefined) return EN[key].replace(/\{(\d+)\}/g, (whole, n) => (Number(n) < found.length - 1 ? trMsg(found[Number(n) + 1]) : whole));
    }
    return text;
  }

  /**
   * 页面里写死的文字（标签、按钮、无障碍说明）在英文界面下换成英文。
   * Translate the text written directly in the page (labels, buttons, accessibility labels) when the interface is English.
   */
  function applyStatic(doc) {
    doc.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    if (lang === 'zh') return;
    doc.title = tr(doc.title);
    const walker = doc.createTreeWalker(doc.body, 4);   // 4 = 只看文字节点
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const node of texts) {
      const raw = node.nodeValue, text = raw.trim();
      if (text && /[一-鿿]/.test(text)) node.nodeValue = raw.replace(text, tr(text));
    }
    for (const el of doc.body.querySelectorAll('[aria-label],[title],[placeholder]')) {
      for (const name of ['aria-label', 'title', 'placeholder']) if (el.hasAttribute(name)) el.setAttribute(name, tr(el.getAttribute(name)));
    }
  }

  return { lang, T, tr, trMsg, setLang, applyStatic, missing };
}));
