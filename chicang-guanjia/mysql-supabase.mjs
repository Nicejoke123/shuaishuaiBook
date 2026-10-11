// Minimal supabase-js-compatible query layer on top of a mysql2-style pool.
// Implements exactly the chain used by functions/handler.mjs:
//   from(table).select(cols).eq(k,v).in(k,arr).order(col,{ascending}).limit(n)
//   from(table).insert(row)
//   from(table).update(patch).eq(...)            [.select(cols).maybeSingle()]
//   from(table).delete().eq(...)                 [.select(cols).maybeSingle()]
// Every awaited call resolves to { data, error } like supabase-js.
//
// Conventions kept from the Supabase version:
// - numeric fields and dates are stored as validated text strings;
// - JSON columns (positions.overrides, advices.detail, settings.data,
//   run_state.value) are stringified on write and parsed on read;
// - duplicate-key inserts are reported as success so snapshot writes stay
//   idempotent across CloudRun instances.

const JSON_COLUMNS = {
  positions: ["overrides"],
  advices: ["detail"],
  settings: ["data"],
  run_state: ["value"],
};

const ident = (name) => {
  const clean = String(name).trim().replace(/[^A-Za-z0-9_]/g, "");
  if (!clean) throw new Error("invalid_identifier");
  return "`" + clean + "`";
};

const colList = (cols) =>
  cols == null || cols === "*"
    ? "*"
    : String(cols)
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean)
        .map(ident)
        .join(", ");

const encode = (table, key, value) => {
  if (value === undefined || value === null) return null;
  if ((JSON_COLUMNS[table] ?? []).includes(key)) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  return value;
};

const decodeRow = (table, row) => {
  const js = JSON_COLUMNS[table] ?? [];
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    let val = v;
    if (js.includes(k) && typeof val === "string") {
      try { val = JSON.parse(val); } catch { /* keep raw text */ }
    }
    out[k] = val;
  }
  return out;
};

class Builder {
  constructor(pool, table) {
    this.pool = pool;
    this.table = table;
    this.verb = null;
    this.returnCols = null;
    this.filters = [];
    this._order = null;
    this._limit = null;
    this._payload = null;
    this._rowMode = null;
  }

  select(cols) { this.verb ??= "select"; this.returnCols = cols ?? "*"; return this; }
  eq(k, v) { this.filters.push({ op: "eq", k, v }); return this; }
  in(k, arr) { this.filters.push({ op: "in", k, v: arr }); return this; }
  order(col, opts) { this._order = { col, asc: opts?.ascending !== false }; return this; }
  limit(n) { this._limit = Math.max(0, Number(n) || 0); return this; }
  insert(row) { this.verb = "insert"; this._payload = row ?? {}; return this; }
  update(patch) { this.verb = "update"; this._payload = patch ?? {}; return this; }
  delete() { this.verb = "delete"; return this; }
  single() { this._rowMode = "single"; return this; }
  maybeSingle() { this._rowMode = "maybeSingle"; return this; }

  then(onFulfilled, onRejected) {
    return this.run().then(onFulfilled, onRejected);
  }

  _where() {
    if (!this.filters.length) return { sql: "", params: [] };
    const parts = [];
    const params = [];
    for (const f of this.filters) {
      if (f.op === "in") {
        const arr = Array.isArray(f.v) ? f.v : [f.v];
        if (!arr.length) return { sql: " WHERE 1 = 0", params: [] };
        parts.push(`${ident(f.k)} IN (${arr.map(() => "?").join(", ")})`);
        params.push(...arr);
      } else {
        parts.push(`${ident(f.k)} = ?`);
        params.push(f.v);
      }
    }
    return { sql: " WHERE " + parts.join(" AND "), params };
  }

  _tail() {
    let sql = "";
    if (this._order) sql += ` ORDER BY ${ident(this._order.col)} ${this._order.asc ? "ASC" : "DESC"}`;
    if (this._limit) sql += ` LIMIT ${this._limit}`;
    return sql;
  }

  async _query(sql, params) {
    const res = await this.pool.query(sql, params);
    return res?.[0] ?? res;
  }

  async run() {
    const verb = this.verb ?? "select";
    try {
      if (verb === "select") {
        const w = this._where();
        const sql = `SELECT ${colList(this.returnCols)} FROM ${ident(this.table)}${w.sql}${this._tail()}`;
        const rows = await this._query(sql, w.params);
        return { data: (rows ?? []).map((r) => decodeRow(this.table, r)), error: null };
      }

      if (verb === "insert") {
        const entries = Object.entries(this._payload).filter(([, v]) => v !== undefined);
        if (!entries.length) return { data: null, error: { message: "empty_insert" } };
        const cols = entries.map(([k]) => ident(k)).join(", ");
        const values = entries.map(([k, v]) => encode(this.table, k, v));
        const sql = `INSERT INTO ${ident(this.table)} (${cols}) VALUES (${values.map(() => "?").join(", ")})`;
        await this._query(sql, values);
        return { data: null, error: null };
      }

      if (verb === "update" || verb === "delete") {
        if (!this.filters.length) return { data: null, error: { message: "unscoped_write" } };
        const w = this._where();

        // Emulate `.update/.delete().select().maybeSingle()`: fetch matched rows first.
        let matched = null;
        if (this._rowMode) {
          const fetchSql = `SELECT ${colList(this.returnCols)} FROM ${ident(this.table)}${w.sql} LIMIT 2`;
          matched = (await this._query(fetchSql, w.params) ?? []).map((r) => decodeRow(this.table, r));
          if (!matched.length) {
            if (this._rowMode === "single") {
              return { data: null, error: { message: "no_rows_updated", code: "PGRST116" } };
            }
            return { data: null, error: null };
          }
        }

        if (verb === "update") {
          const entries = Object.entries(this._payload).filter(([, v]) => v !== undefined);
          if (!entries.length) return { data: null, error: { message: "empty_update" } };
          const setSql = entries.map(([k]) => `${ident(k)} = ?`).join(", ");
          const setParams = entries.map(([k, v]) => encode(this.table, k, v));
          await this._query(
            `UPDATE ${ident(this.table)} SET ${setSql}${w.sql}`,
            [...setParams, ...w.params],
          );
        } else {
          await this._query(`DELETE FROM ${ident(this.table)}${w.sql}`, w.params);
        }

        if (this._rowMode) {
          const first = matched[0];
          if (verb === "update") {
            const wanted = this.returnCols === "*" ? null : String(this.returnCols).split(",").map((s) => s.trim());
            for (const [k, v] of Object.entries(this._payload)) {
              if (v !== undefined && (wanted === null || wanted.includes(k))) first[k] = v;
            }
          }
          return { data: first, error: null };
        }
        return { data: null, error: null };
      }

      return { data: null, error: { message: "unsupported_verb" } };
    } catch (err) {
      if (err && err.code === "ER_DUP_ENTRY" && verb === "insert") {
        return { data: null, error: null }; // idempotent duplicate write
      }
      return {
        data: null,
        error: { message: err?.sqlMessage ?? err?.message ?? "db_error", code: err?.code ?? "db_error" },
      };
    }
  }
}

export function createMysqlSupabase(pool) {
  return {
    from(table) {
      return new Builder(pool, String(table));
    },
  };
}
