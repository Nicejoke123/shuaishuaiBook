import os, json
import pymysql
from flask import Flask, request, jsonify, send_from_directory

APP = Flask(__name__)
BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE, "data")
DATA_FILE = os.path.join(DATA_DIR, "store.json")

# 访问口令：发布时可通过环境变量 APP_PWD 覆盖；缺省使用下方默认值
APP_PWD = os.environ.get("APP_PWD", "kb2026")

# 数据库名：微信云托管不会自动注入库名，默认自建 shuaishuai，可用 MYSQL_DATABASE 覆盖
DB_NAME = os.environ.get("MYSQL_DATABASE", "shuaishuai")

# 只有配置了 MYSQL_ADDRESS 才走数据库；否则退回本地文件（仅兜底，重启会丢）
USE_DB = bool(os.environ.get("MYSQL_ADDRESS"))

# ===== 文件兜底（未配置 MySQL 时使用，数据非持久）=====
if not USE_DB:
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


def persist_file():
    with open(DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(STORE, f, ensure_ascii=False, indent=2)


# ===== MySQL =====
def _conn(no_db=False):
    addr = os.environ.get("MYSQL_ADDRESS", "127.0.0.1")
    if ":" in addr:                       # 兼容  host:port 形式
        host, _, port = addr.rpartition(":")
        port = int(port)
    else:
        host, port = addr, 3306
    return pymysql.connect(
        host=host, port=port,
        user=os.environ.get("MYSQL_USERNAME", "root"),
        password=os.environ.get("MYSQL_PASSWORD", ""),
        database=None if no_db else DB_NAME,
        charset="utf8mb4", autocommit=True, connect_timeout=5,
    )


_seeded = False


def ensure_db():
    """建库建表（幂等），首次成功时把包内的 store.json 灌进库。"""
    global _seeded
    conn = _conn(no_db=True)
    try:
        with conn.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` CHARACTER SET utf8mb4")
            cur.execute(f"USE `{DB_NAME}`")
            cur.execute("""CREATE TABLE IF NOT EXISTS kv_store (
                k VARCHAR(191) PRIMARY KEY,
                v MEDIUMTEXT
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")
    finally:
        conn.close()
    if not _seeded:
        _seed_if_empty()
        _seeded = True


def _seed_if_empty():
    p = os.path.join(BASE, "store.json")
    if not os.path.exists(p):
        return
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return
    conn = _conn()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM kv_store")
            if cur.fetchone()[0] > 0:
                return
            for kk, vv in data.items():
                cur.execute("INSERT IGNORE INTO kv_store (k, v) VALUES (%s, %s)",
                            (kk, json.dumps(vv, ensure_ascii=False)))
    finally:
        conn.close()


@APP.route("/")
def index():
    return send_from_directory(BASE, "index.html")


# 前端 COS 密钥外置文件（部署时把 config/cos.json 放进容器即可启用云同步；文件缺失 → 前端自动降级为纯本地）
@APP.route("/config/<path:fn>")
def config_file(fn):
    return send_from_directory(os.path.join(BASE, "config"), fn)


# ===== CORS：支持网页版从其它域名跨域调用（同源部署则无影响）=====
@APP.after_request
def _cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


@APP.route("/api/all", methods=["GET", "OPTIONS"])
def api_all():
    if request.method == "OPTIONS":
        return ("", 204)
    if not pwd_ok():
        return jsonify(error="unauthorized"), 401
    if USE_DB:
        ensure_db()
        conn = _conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT k, v FROM kv_store")
                rows = cur.fetchall()
            return jsonify({r[0]: json.loads(r[1]) for r in rows})
        finally:
            conn.close()
    return jsonify(STORE)


@APP.route("/api/set", methods=["POST", "OPTIONS"])
def api_set():
    if request.method == "OPTIONS":
        return ("", 204)
    if not pwd_ok():
        return jsonify(error="unauthorized"), 401
    d = request.get_json(silent=True) or {}
    k = d.get("key")
    v = d.get("value")
    if k is None:
        return jsonify(error="missing key"), 400
    if USE_DB:
        ensure_db()
        conn = _conn()
        try:
            with conn.cursor() as cur:
                js = json.dumps(v, ensure_ascii=False)
                cur.execute(
                    "INSERT INTO kv_store (k, v) VALUES (%s, %s) "
                    "ON DUPLICATE KEY UPDATE v=%s",
                    (k, js, js),
                )
        finally:
            conn.close()
        return jsonify(ok=True)
    STORE[k] = v
    try:
        persist_file()
    except Exception as e:
        return jsonify(error=str(e)), 500
    return jsonify(ok=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    APP.run(host="0.0.0.0", port=port)
