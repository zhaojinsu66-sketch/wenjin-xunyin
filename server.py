"""问金寻银 · 本机服务（只用 Python 标准库，不装依赖）。
Wenjin Xunyin · local server (Python standard library only, nothing to install).

    python server.py            # 默认 / default: http://127.0.0.1:8765/
    python server.py 8800       # 换端口 / another port

提供 / Routes:
- /            看板页面（web/ 目录） / the board page (web/)
- /data/*      data/ 目录里的数据：universe.json（股票名单，必需），history.json + history.bin（收盘回放，可选），rules.json（规则信号，可选）
               files in data/: universe.json (stock list, required), history.json + history.bin (replay, optional), rules.json (rule signals, optional)
- /proxy/qt     实时报价（转发公开行情接口，代码白名单校验，GBK 转 UTF-8） / live quotes (forwarded, codes whitelisted, GBK → UTF-8)
- /proxy/minute 分时 / intraday
- /proxy/kline  日 K（前复权，最近 120 天） / daily K-lines (forward-adjusted, last 120 days)

只监听 127.0.0.1，别人访问不到你的电脑。行情接口在国内：系统设了代理时默认直连（WENJIN_USE_PROXY=1 改为走代理）。
Listens on 127.0.0.1 only, so nobody else can reach your machine. The quote endpoints are in mainland China: a system proxy is
bypassed by default (set WENJIN_USE_PROXY=1 to go through it).

数据来自公开网络，可能延迟或有误，仅供研究，不构成任何投资建议。
Data comes from the public internet and may be delayed or wrong. For research only, not investment advice.
"""
import http.server
import json
import os
import re
import socketserver
import sys
import urllib.parse as up
import urllib.request as u
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB = ROOT / "web"
DATA = ROOT / "data"
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
TYPES = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
         ".json": "application/json; charset=utf-8", ".bin": "application/octet-stream", ".txt": "text/plain; charset=utf-8",
         ".svg": "image/svg+xml"}
# 可选数据：没有时回 204（空内容），页面照常跳过回放和规则信号，浏览器控制台里也不会留一条 404
OPTIONAL = {"history.json", "history.bin", "rules.json"}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
CODE = re.compile(r"(s_)?((sh|sz|bj|hk)[A-Za-z0-9.]{3,8}|us[A-Z0-9.]{1,10})")
# 静态文件的相对路径只放行普通文件名：先按字符串拦掉 ..、反斜杠、盘符、连续斜杠（网络路径）和隐藏文件，再去碰磁盘
SAFE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*")
# 只认本机地址发来的请求：别的域名即使解析到 127.0.0.1 也不服务
HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}"} | ({"127.0.0.1", "localhost"} if PORT == 80 else set())
OPENER = u.build_opener() if os.environ.get("WENJIN_USE_PROXY") == "1" else u.build_opener(u.ProxyHandler({}))
# 页面只用到这些外部能力：不联别的网站、不跑别处的脚本，也不允许被别的网页嵌进去
CSP = ("default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")


def fetch(url, headers=None, timeout=12):
    return OPENER.open(u.Request(url, headers=dict(UA, **(headers or {}))), timeout=timeout).read()


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def reply(self, status, body, ctype="text/plain; charset=utf-8", cache="no-store"):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        if ctype.startswith("text/html"):
            self.send_header("Content-Security-Policy", CSP)
        self.end_headers()
        self.wfile.write(body)

    def codes(self, query, most):
        codes = up.parse_qs(query).get("q", up.parse_qs(query).get("code", [""]))[0].split(",")
        return codes if 0 < len(codes) <= most and all(CODE.fullmatch(c) for c in codes) else None

    def do_GET(self):
        url = up.urlparse(self.path)
        path = url.path
        try:
            if self.headers.get("Host", "").lower() not in HOSTS:
                return self.reply(403, b"forbidden")
            if path == "/proxy/qt":
                codes = self.codes(url.query, 70)
                if not codes:
                    return self.reply(400, b"bad codes")
                data = fetch("https://qt.gtimg.cn/q=" + ",".join(codes))
                return self.reply(200, data.decode("gbk", "replace").encode("utf-8"))
            if path == "/proxy/minute":
                codes = self.codes(url.query, 1)
                if not codes:
                    return self.reply(400, b"bad code")
                code = codes[0]
                route = "UsMinute" if code.startswith("us") else "minute"
                data = fetch(f"https://web.ifzq.gtimg.cn/appstock/app/{route}/query?code={code}", {"Referer": "https://gu.qq.com/"})
                return self.reply(200, data, "application/json; charset=utf-8")
            if path == "/proxy/kline":
                codes = self.codes(url.query, 1)
                if not codes:
                    return self.reply(400, b"bad code")
                code = codes[0]
                wire, route = code, "hkfqkline" if code.startswith("hk") else "fqkline"
                if code.startswith("us"):
                    # 美股日 K 要带交易所后缀（usAAPL.OQ），先从报价里取
                    route = "usfqkline"
                    text = fetch("https://qt.gtimg.cn/q=" + code).decode("gbk", "replace")
                    found = re.search(r'="[^~]*~[^~]*~([^~]*)~', text)
                    wire = "us" + found.group(1) if found else code
                data = fetch(f"https://web.ifzq.gtimg.cn/appstock/app/{route}/get?param={wire},day,,,120,qfq", {"Referer": "https://gu.qq.com/"})
                node = (json.loads(data).get("data") or {}).get(wire) or {}
                rows = node.get("qfqday") or node.get("day") or []
                body = [[r[0], float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])] for r in rows if len(r) >= 6]
                return self.reply(200, json.dumps(body).encode("utf-8"), "application/json; charset=utf-8")
            if path.startswith("/data/"):
                rel = path[len("/data/"):]
                if len(rel) > 200 or not SAFE.fullmatch(rel):
                    return self.reply(404, b"not found")
                file = (DATA / rel).resolve()
                if file.is_file() and file.is_relative_to(DATA.resolve()):
                    return self.reply(200, file.read_bytes(), TYPES.get(file.suffix, "application/octet-stream"), "max-age=60")
                if file.name in OPTIONAL and file.parent == DATA.resolve():
                    return self.reply(204, b"")
                return self.reply(404, b"not found")
            name = "index.html" if path in ("/", "") else path[1:]
            if len(name) > 200 or not SAFE.fullmatch(name):
                return self.reply(404, b"not found")
            file = (WEB / name).resolve()
            if file.is_file() and file.is_relative_to(WEB.resolve()) and file.suffix in TYPES:
                return self.reply(200, file.read_bytes(), TYPES[file.suffix], "no-cache")
            return self.reply(404, b"not found")
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:   # 上游接口出错：告诉页面这一下没取到，页面会重试
            try:
                self.reply(502, ("upstream: " + type(error).__name__).encode("utf-8"))
            except Exception:
                pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


if __name__ == "__main__":
    if not (DATA / "universe.json").is_file():
        sys.exit("缺少 data/universe.json：先运行 python tools/update_universe.py\n"
                 "data/universe.json is missing: run python tools/update_universe.py first")
    print("问金寻银 / Wenjin Xunyin: http://127.0.0.1:%d/  （Ctrl+C 停止 / to stop）" % PORT, flush=True)
    Server(("127.0.0.1", PORT), Handler).serve_forever()
