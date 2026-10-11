// Local-testing only pool backed by node:sqlite, exposing the same
// `async query(sql, params) -> [rows]` surface that mysql2/promise provides.
// It runs the same MySQL-style schema.sql (ENGINE clauses stripped) so the
// container server can be exercised end-to-end without a database.
// NEVER use this in production: DB_DEV=memory is a smoke-test mode only.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function createMemoryPool({ file = ":memory:" } = {}) {
  const db = new DatabaseSync(file);
  const ddl = fs
    .readFileSync(path.join(here, "schema.sql"), "utf8")
    .replace(/^\s*--.*$/gm, "")
    .replace(/ENGINE\s*=\s*\w+(\s+DEFAULT\s+CHARSET\s*=\s*\w+)?/g, "")
    .replace(/UNIQUE\s+KEY\s+\w+\s*\(/g, "UNIQUE (")
    .replace(/,\s*KEY\s+\w+\s*\([^)]*\)/g, "");
  db.exec(ddl);

  return {
    async query(sql, params = []) {
      const args = params.map((p) => {
        if (p === undefined) return null;
        if (typeof p === "boolean") return p ? 1 : 0;
        return p;
      });
      const stmt = db.prepare(sql);
      try {
        if (/^\s*(select|with|pragma)/i.test(sql)) return [stmt.all(...args)];
        stmt.run(...args);
        return [{}];
      } catch (err) {
        if (/UNIQUE constraint failed/.test(String(err?.message))) {
          const e = new Error(err.message);
          e.code = "ER_DUP_ENTRY";
          throw e;
        }
        throw err;
      }
    },
    async end() {
      try { db.close(); } catch { /* already closed */ }
    },
  };
}
