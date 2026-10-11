// 持仓管家 · 微信云托管服务入口
// 单容器同时提供：静态前端（dist/）+ 业务 API（/functions/v1/app，复用 functions/handler.mjs）。
// 存储使用 MySQL（mysql2 连接池）；DB_DEV=memory 为本地冒烟模式（node:sqlite，勿上线）。
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMysqlSupabase } from "./mysql-supabase.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 80);
const MAX_BODY = 1024 * 1024;

function resolveFirst(candidates) {
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

async function loadHandler() {
  const candidates = [
    process.env.HANDLER_PATH && path.resolve(here, process.env.HANDLER_PATH),
    path.resolve(here, "../../functions/handler.mjs"), // repo layout: deploy/cloudrun/
    path.resolve(here, "functions/handler.mjs"),       // docker layout: /app/
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const mod = await import(pathToFileUrl(c));
      if (mod?.handleApp) return mod.handleApp;
    } catch { /* try next */ }
  }
  throw new Error("handler_not_found: set HANDLER_PATH");
}

function resolveStaticDir() {
  const dir = resolveFirst([
    process.env.STATIC_DIR,
    path.resolve(here, "../../dist"),
    path.resolve(here, "dist"),
  ]);
  if (!dir) throw new Error("dist_not_found: build the frontend first (npm run build)");
  return dir;
}

const pathToFileUrl = (p) => new URL(`file://${p}`).href;

async function initDb() {
  if (process.env.DB_DEV === "memory") {
    const { createMemoryPool } = await import(pathToFileUrl(path.join(here, "memory-pool.mjs")));
    const file = process.env.DB_DEV_FILE ?? ":memory:";
    console.log(`[db] DEV memory mode (node:sqlite, file=${file}) — not for production`);
    return { pool: createMemoryPool({ file }), mode: "memory" };
  }
  // WeChat CloudRun injects WX_MYSQL_* when the built-in MySQL is enabled;
  // explicit DB_* variables always win.
  const wxAddr = (process.env.WX_MYSQL_ADDRESS ?? "").split(":");
  const host = process.env.DB_HOST || wxAddr[0] || "";
  const port = Number(process.env.DB_PORT || wxAddr[1] || 3306);
  const user = process.env.DB_USER || process.env.WX_MYSQL_USER || "";
  const password = process.env.DB_PASSWORD || process.env.DB_PASS || process.env.WX_MYSQL_PWD || "";
  const database = process.env.DB_NAME || process.env.WX_MYSQL_DATABASE || "";
  if (!host || !user || !password || !database) {
    throw new Error("db_env_missing: set DB_HOST/DB_USER/DB_PASSWORD/DB_NAME (or use cloud MySQL WX_MYSQL_*), or DB_DEV=memory for local smoke");
  }
  const mysql = (await import("mysql2/promise")).default;
  const pool = mysql.createPool({
    host, port, user, password, database,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
    charset: "utf8mb4",
  });
  console.log(`[db] mysql ${host}:${port}/${database}`);
  return { pool, mode: "mysql" };
}

// ---------- static files ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(staticDir, req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.includes("\0")) { res.writeHead(400).end("bad path"); return; }
  let file = path.normalize(path.join(staticDir, rel));
  if (!file.startsWith(path.normalize(staticDir + path.sep))) {
    res.writeHead(403).end("forbidden"); return;
  }
  let stat = fs.existsSync(file) ? fs.statSync(file) : null;
  if (stat?.isDirectory()) {
    file = path.join(file, "index.html");
    stat = fs.existsSync(file) ? fs.statSync(file) : null;
  }
  if (!stat) {
    // SPA fallback for extension-less routes; otherwise 404
    if (!path.extname(rel)) {
      file = path.join(staticDir, "index.html");
      stat = fs.existsSync(file) ? fs.statSync(file) : null;
    }
    if (!stat) { res.writeHead(404).end("not found"); return; }
  }
  const ext = path.extname(file).toLowerCase();
  const cache = ext === ".html"
    ? "no-cache"
    : /(^|\/)assets\//.test(rel) ? "public, max-age=31536000, immutable" : "public, max-age=300";
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": stat.size,
    "cache-control": cache,
  });
  fs.createReadStream(file).pipe(res);
}

// ---------- node http <-> web Request/Response bridge ----------
async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      const err = new Error("body_too_large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

function sendWebResponse(res, webRes) {
  const headers = {};
  webRes.headers.forEach((v, k) => { headers[k] = v; });
  return webRes.text().then((text) => {
    if (text) headers["content-length"] = Buffer.byteLength(text);
    else delete headers["content-length"];
    res.writeHead(webRes.status, headers).end(text || (webRes.status === 204 ? undefined : ""));
  });
}

const MAIN = (async () => {
  const handleApp = await loadHandler();
  const staticDir = resolveStaticDir();
  const { pool, mode } = await initDb();
  const supabase = createMysqlSupabase(pool);

  const server = http.createServer((req, res) => {
    const run = async () => {
      const u = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      if (u.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, mode }));
        return;
      }
      if (u.pathname === "/functions/v1/app") {
        if (req.method !== "GET" && req.method !== "POST") {
          res.writeHead(405, { "content-type": "application/json" });
          res.end('{"ok":false,"error":"method_not_allowed"}');
          return;
        }
        const headers = {};
        for (let i = 0; i < req.rawHeaders.length; i += 2) headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
        const body = req.method === "GET" ? undefined : await readRequestBody(req);
        const webReq = new Request(u.href, {
          method: req.method,
          headers,
          body: body && body.length ? body : (req.method === "POST" ? Buffer.alloc(0) : undefined),
        });
        const webRes = await handleApp({ request: webReq, supabase });
        await sendWebResponse(res, webRes);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(404).end("not found");
        return;
      }
      serveStatic(staticDir, req, res, u.pathname);
    };
    run().catch((err) => {
      console.error("[server]", err?.message ?? err);
      if (!res.headersSent) {
        res.writeHead(err?.statusCode ?? 500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ ok: false, error: err?.statusCode === 413 ? "body_too_large" : "server_error" }));
    });
  });

  server.listen(PORT, () => {
    console.log(`[server] listening on :${PORT} (db=${mode}, static=${staticDir})`);
  });

  const shutdown = () => {
    server.close();
    pool.end?.().catch(() => {});
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((err) => {
  console.error("[fatal]", err?.message ?? err);
  process.exit(1);
});

export { MAIN };
