import os, json
from flask import Flask, request, jsonify, send_from_directory

APP = Flask(__name__)
BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
DATA_FILE = os.path.join(DATA_DIR, "store.json")

# 访问口令：发布时可通过环境变量 APP_PWD 覆盖；缺省使用下方默认值
APP_PWD = os.environ.get("APP_PWD", "kb2026")

# 启动时加载已有数据
os.makedirs(DATA_DIR, exist_ok=True)
STORE = {}
if os.path.exists(DATA_FILE):
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as f:
            STORE = json.load(f)
    except Exception:
        STORE = {}


def pwd_ok():
    p = request.args.get("pwd")
    if p is None:
        try:
            p = (request.get_json(silent=True) or {}).get("pwd")
        except Exception:
            p = None
    return p == APP_PWD


def persist():
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(STORE, f, ensure_ascii=False, indent=2)


@APP.route("/")
def index():
    return send_from_directory(BASE, "index.html")


@APP.route("/api/all")
def api_all():
    if not pwd_ok():
        return jsonify(error="unauthorized"), 401
    return jsonify(STORE)


@APP.route("/api/set", methods=["POST"])
def api_set():
    if not pwd_ok():
        return jsonify(error="unauthorized"), 401
    d = request.get_json(silent=True) or {}
    k = d.get("key")
    v = d.get("value")
    if k is None:
        return jsonify(error="missing key"), 400
    STORE[k] = v
    try:
        persist()
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    APP.run(host="0.0.0.0", port=port)
