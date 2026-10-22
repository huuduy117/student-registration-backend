/**
 * Minimal in-memory stand-in for the Supabase JS client.
 *
 * It implements only the chain used by this codebase:
 *   from(table).select(cols, opts).eq(...).order(...).limit(n).maybeSingle()
 *   from(table).insert(row | rows)
 *   from(table).update(patch).eq(...)
 *   from(table).delete().eq(...)
 *
 * Rows are plain objects, so nested selects such as `*, courses(prerequisite)`
 * must be pre-shaped in the fixture (that is exactly what PostgREST returns).
 */

const createFakeSupabase = () => {
  const state = {};
  const failInsert = {};
  const selectLog = [];
  let rpcImpl = async () => ({
    data: null,
    error: {
      code: "PGRST202",
      message: "Could not find the function public.enroll_student in the schema cache",
    },
  });

  class Query {
    constructor(table) {
      this.table = table;
      this.op = "select";
      this.filters = [];
      this.ltFilters = [];
      this.payload = null;
      this.countMode = false;
      this.singleMode = null;
      this.limitN = null;
      this.orders = [];
    }

    select(_cols, opts = {}) {
      if (this.op === "select") {
        this.countMode = Boolean(opts.count);
        selectLog.push({ table: this.table, columns: _cols });
      }
      return this;
    }

    insert(payload) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }

    upsert(payload) {
      this.op = "upsert";
      this.payload = payload;
      return this;
    }

    update(payload) {
      this.op = "update";
      this.payload = payload;
      return this;
    }

    delete() {
      this.op = "delete";
      return this;
    }

    eq(column, value) {
      this.filters.push([column, value]);
      return this;
    }

    lt(column, value) {
      this.ltFilters.push([column, value]);
      return this;
    }

    order(column, opts = {}) {
      this.orders.push([column, opts.ascending !== false]);
      return this;
    }

    limit(n) {
      this.limitN = n;
      return this;
    }

    maybeSingle() {
      this.singleMode = "maybe";
      return this;
    }

    single() {
      this.singleMode = "single";
      return this;
    }

    _match() {
      const rows = state[this.table] || [];
      return rows.filter(
        (row) =>
          this.filters.every(([column, value]) => row[column] === value) &&
          this.ltFilters.every(([column, value]) => row[column] < value),
      );
    }

    _exec() {
      const rows = (state[this.table] = state[this.table] || []);

      if (this.op === "insert") {
        if (failInsert[this.table]) {
          return { data: null, error: { message: `insert failed on ${this.table}` } };
        }
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        rows.push(...list.map((row) => ({ ...row })));
        return { data: list, error: null };
      }

      if (this.op === "upsert") {
        if (failInsert[this.table]) {
          return { data: null, error: { message: `upsert failed on ${this.table}` } };
        }
        const list = Array.isArray(this.payload) ? this.payload : [this.payload];
        for (const row of list) {
          const key = row.jti ?? row.id;
          const existing = key
            ? rows.find((candidate) => (candidate.jti ?? candidate.id) === key)
            : null;
          if (existing) Object.assign(existing, row);
          else rows.push({ ...row });
        }
        return { data: list, error: null };
      }

      if (this.op === "update") {
        const matched = this._match();
        matched.forEach((row) => Object.assign(row, this.payload));
        return { data: matched, error: null };
      }

      if (this.op === "delete") {
        const matched = this._match();
        for (const row of matched) rows.splice(rows.indexOf(row), 1);
        return { data: null, error: null };
      }

      let matched = this._match();
      if (this.limitN !== null) matched = matched.slice(0, this.limitN);

      if (this.countMode) return { count: matched.length, data: null, error: null };

      if (this.singleMode) {
        if (matched.length === 0) {
          return this.singleMode === "maybe"
            ? { data: null, error: null }
            : { data: null, error: { code: "PGRST116", message: "no rows" } };
        }
        return { data: { ...matched[0] }, error: null };
      }

      return { data: matched.map((row) => ({ ...row })), error: null };
    }

    then(resolve, reject) {
      return Promise.resolve()
        .then(() => this._exec())
        .then(resolve, reject);
    }
  }

  return {
    state,
    failInsert,
    selectLog,
    supabase: {
      from: (table) => new Query(table),
      rpc: (fn, args) => Promise.resolve(rpcImpl(fn, args)),
    },
    setRpc(impl) {
      rpcImpl = impl;
    },
    reset() {
      for (const key of Object.keys(state)) delete state[key];
      for (const key of Object.keys(failInsert)) delete failInsert[key];
      selectLog.length = 0;
      rpcImpl = async () => ({
        data: null,
        error: {
          code: "PGRST202",
          message:
            "Could not find the function public.enroll_student in the schema cache",
        },
      });
    },
  };
};

module.exports = { createFakeSupabase };
