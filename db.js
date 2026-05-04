const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'condo.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS condos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      district TEXT NOT NULL,
      area TEXT NOT NULL,
      tenure TEXT DEFAULT '99-year Leasehold',
      year_completed INTEGER,
      total_units INTEGER,
      developer TEXT,
      mrt_station TEXT,
      mrt_distance TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(name, district)
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      condo_id INTEGER NOT NULL,
      buy_date TEXT NOT NULL,
      sell_date TEXT,
      buy_price REAL NOT NULL,
      sell_price REAL,
      size_sqft REAL NOT NULL,
      unit_type TEXT,
      floor_level TEXT,
      annualized_return REAL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (condo_id) REFERENCES condos(id)
    );

    CREATE TABLE IF NOT EXISTS project_stats (
      condo_id INTEGER PRIMARY KEY,
      total_txns INTEGER DEFAULT 0,
      avg_annualized REAL,
      max_annualized REAL,
      min_annualized REAL,
      current_avg_psf REAL,
      rental_yield REAL,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (condo_id) REFERENCES condos(id)
    );

    CREATE INDEX IF NOT EXISTS idx_trans_condo ON transactions(condo_id);
    CREATE INDEX IF NOT EXISTS idx_condo_district ON condos(district);
    CREATE INDEX IF NOT EXISTS idx_condo_area ON condos(area);
  `);
}

module.exports = { getDb };
