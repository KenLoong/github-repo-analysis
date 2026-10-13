#!/usr/bin/env python3
"""静态文件服务 + /api/config(从 config.json 读取密钥,config.json 本身不对外提供)。仅监听本机。"""
import json, os, sys, urllib.request, urllib.error
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, "config.json")
PUBLIC = {"index.html", "app.js", "style.css"}


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as e:
        print(f"config.json 格式错误: {e}", file=sys.stderr)
        return {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/config":
            cfg = load_config()
            cfg["deepseek_configured"] = bool(cfg.pop("deepseek_api_key", ""))  # 不把 DeepSeek 密钥发给浏览器
            body = json.dumps(cfg).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        name = "index.html" if path == "/" else path.lstrip("/")
        if name not in PUBLIC:
            self.send_error(404)
            return
        self.path = "/" + name
        super().do_GET()


def _do_post(self):
    if self.path != "/api/llm":
        self.send_error(404)
        return
    payload = self.rfile.read(int(self.headers.get("Content-Length", 0)))
    code, body = proxy_llm(self, payload)
    self.send_response(code)
    self.send_header("Content-Type", "application/json")
    self.send_header("Content-Length", str(len(body)))
    self.end_headers()
    self.wfile.write(body)


Handler.do_POST = _do_post


def proxy_llm(handler, payload):
    key = load_config().get("deepseek_api_key", "")
    if not key:
        return 400, b'{"error":"config.json missing deepseek_api_key"}'
    req = urllib.request.Request(
        "https://api.deepseek.com/chat/completions", data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + key})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:
        return 502, json.dumps({"error": str(e)}).encode()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8000))
    print(f"打开 http://127.0.0.1:{port}  (Ctrl+C 停止)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
