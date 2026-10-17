// Map-compatible stores backed by Durable Object SQLite storage. The synchronous
// SQL API keeps update-particulars' check-and-claim steps atomic, as with Maps.

export const STATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS state (
  store TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (store, key)
)`;

class SqlMapStore {
  constructor(sql, store) {
    this.sql = sql;
    this.store = store;
  }

  get(key) {
    const [row] = this.sql
      .exec('SELECT value FROM state WHERE store = ? AND key = ?', this.store, key)
      .toArray();
    return row ? JSON.parse(row.value) : undefined;
  }

  set(key, value) {
    this.sql.exec(
      `INSERT INTO state (store, key, value) VALUES (?, ?, ?)
       ON CONFLICT (store, key) DO UPDATE SET value = excluded.value`,
      this.store,
      key,
      JSON.stringify(value)
    );
    return this;
  }

  delete(key) {
    this.sql.exec('DELETE FROM state WHERE store = ? AND key = ?', this.store, key);
    return true;
  }

  clear() {
    this.sql.exec('DELETE FROM state WHERE store = ?', this.store);
  }

  * entries() {
    const rows = this.sql
      .exec('SELECT key, value FROM state WHERE store = ?', this.store)
      .toArray();
    for (const row of rows) yield [row.key, JSON.parse(row.value)];
  }

  get size() {
    return this.sql
      .exec('SELECT COUNT(*) AS count FROM state WHERE store = ?', this.store)
      .one().count;
  }
}

export const createSqlStores = (sql) => {
  sql.exec(STATE_TABLE_SQL);
  return {
    otp: new SqlMapStore(sql, 'otp'),
    sessions: new SqlMapStore(sql, 'sessions'),
    cooldowns: new SqlMapStore(sql, 'cooldowns'),
    ipRequests: new SqlMapStore(sql, 'ipRequests')
  };
};

export const countStoredRows = (sql) =>
  sql.exec('SELECT COUNT(*) AS count FROM state').one().count;
