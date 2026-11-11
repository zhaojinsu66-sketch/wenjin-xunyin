"""更新股票名单 data/universe.json（看板唯一必需的数据）。只用 Python 标准库。
Update the stock list data/universe.json (the only data the board requires). Python standard library only.

    python tools/update_universe.py                 # A 股全部，港股、美股按成交额各取前若干只 / all A-shares, top HK and US by turnover
    python tools/update_universe.py --hk 600 --us 2100

从公开的行情列表接口取代码、名称、所属行业、成交额。
这个接口有风控：一页一页慢慢取，遇到 403 或断开就停，过 30–60 分钟再试，别并发、别频繁跑（一天一次足够）。
原来的 universe.json 在全部取完以前不会被覆盖。

Fetches code, name, industry and turnover from a public quote-list endpoint.
The endpoint is rate-limited: pages are fetched slowly one by one; on a 403 or a dropped connection the script stops,
so wait 30–60 minutes before retrying. Do not run it in parallel or often (once a day is enough).
The existing universe.json is not overwritten until everything has been fetched.
"""
import argparse
import json
import os
import sys
import time
import urllib.parse as up
import urllib.request as u
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "universe.json"
OPENER = u.build_opener() if os.environ.get("WENJIN_USE_PROXY") == "1" else u.build_opener(u.ProxyHandler({}))
API = "https://push2.eastmoney.com/api/qt/clist/get"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Referer": "https://quote.eastmoney.com/"}
GROUPS = {
    # 沪深京 A 股：上证主板、科创板、深证主板、创业板、北交所
    "CN": "m:1+t:2,m:1+t:23,m:0+t:6,m:0+t:80,m:0+t:81+s:2048",
    "HK": "m:116+t:3,m:116+t:4,m:116+t:1,m:116+t:2",
    "US": "m:105,m:106,m:107",
}
PAGE = 100


def page(fs, pn):
    query = up.urlencode({"pn": pn, "pz": PAGE, "po": 1, "np": 1, "fltt": 2, "invt": 2, "fid": "f6", "fs": fs, "fields": "f6,f12,f13,f14,f100"})
    raw = OPENER.open(u.Request(API + "?" + query, headers=UA), timeout=15).read()
    data = json.loads(raw.decode("utf-8")).get("data") or {}
    return data.get("diff") or [], data.get("total") or 0


def fetch_group(name, fs, limit):
    rows, pn, total = [], 1, None
    while True:
        diff, total_now = page(fs, pn)
        total = total if total is not None else total_now
        rows += diff
        print(f"  {name} 第 {pn} 页 / page {pn}，累计 / so far {len(rows)}/{total}", flush=True)
        if not diff or len(rows) >= total or (limit and len(rows) >= limit):
            break
        pn += 1
        time.sleep(0.6)   # 慢一点，别触发风控
    return rows[:limit] if limit else rows


def quote_code(market, row):
    code = str(row.get("f12") or "").strip()
    if not code:
        return None
    if market == "CN":
        if code.startswith(("6", "9")) and row.get("f13") == 1:
            return "sh" + code
        if code.startswith(("4", "8", "92")):
            return "bj" + code
        return ("sh" if row.get("f13") == 1 else "sz") + code
    if market == "HK":
        return "hk" + code.zfill(5)
    return "us" + code.upper().replace("_", ".")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hk", type=int, default=600, help="港股按成交额取前几只 / how many Hong Kong stocks to take, by turnover")
    ap.add_argument("--us", type=int, default=2100, help="美股按成交额取前几只 / how many US stocks to take, by turnover")
    args = ap.parse_args()
    stocks, industries, index = [], [], {}
    seen = set()
    for market, fs in GROUPS.items():
        limit = {"CN": 0, "HK": args.hk, "US": args.us}[market]
        try:
            rows = fetch_group(market, fs, limit)
        except Exception as error:
            sys.exit(f"{market} 取名单失败（{type(error).__name__}: {error}）。可能触发了风控，过 30–60 分钟再试；原来的 universe.json 没动。\n"
                     f"Fetching the {market} list failed ({type(error).__name__}: {error}). The endpoint may be rate-limiting you: "
                     "wait 30–60 minutes and try again. The existing universe.json was left untouched.")
        for row in rows:
            code = quote_code(market, row)
            name = str(row.get("f14") or "").strip()
            if not code or not name or code in seen or name.startswith(("退市", "*退")):
                continue
            label = str(row.get("f100") or "").strip()
            if not label or label == "-":
                label = {"CN": "A股其他", "HK": "港股其他", "US": "美股其他"}[market]
            if label not in index:
                index[label] = len(industries)
                industries.append(label)
            amount = row.get("f6")
            amount = float(amount) if isinstance(amount, (int, float)) else 0.0
            stocks.append([code, name, index[label], round(amount)])
            seen.add(code)
        time.sleep(1.0)
    if len(stocks) < 1000:
        sys.exit(f"只取到 {len(stocks)} 只，不像完整名单，没有覆盖原来的 universe.json。\n"
                 f"Only {len(stocks)} stocks were fetched, which does not look like a full list; the existing universe.json was not overwritten.")
    as_of = datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    tmp = OUT.with_suffix(".tmp")
    tmp.write_text(json.dumps({"asOf": as_of, "industries": industries, "stocks": stocks}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    tmp.replace(OUT)
    print(f"写入 / wrote {OUT}：{len(stocks)} 只 / stocks，{len(industries)} 个行业 / industries，日期 / as of {as_of}")


if __name__ == "__main__":
    main()
