const { getDb } = require("./db");
const fs = require("fs");
const path = require("path");

function seed() {
  const db = getDb();

  // Always attempt to seed from the bundled data file
  const filePath = path.join(__dirname, "public", "seed-data.json");
  if (!fs.existsSync(filePath)) {
    console.log("No seed-data.json found, starting empty");
    return;
  }

  // Check if already seeded
  const count = db.prepare("SELECT COUNT(*) as c FROM condos").get();
  if (count.c > 0) {
    console.log(`DB already has ${count.c} condos, skipping seed`);
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log(`Seeding ${data.condos.length} condos, ${data.transactions.length} txns...`);

  const insertCondo = db.prepare(`INSERT OR IGNORE INTO condos (id, name, district, area, tenure, year_completed, total_units, developer, mrt_station, mrt_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertStat = db.prepare(`INSERT OR IGNORE INTO project_stats (condo_id, total_txns, avg_annualized, max_annualized, min_annualized, current_avg_psf, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertTxn = db.prepare(`INSERT OR IGNORE INTO transactions (id, condo_id, buy_date, sell_date, buy_price, sell_price, size_sqft, unit_type, floor_level, annualized_return, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    for (const c of data.condos) {
      insertCondo.run(c.id, c.name, c.district, c.area, c.tenure, c.year_completed, c.total_units, c.developer, c.mrt_station, c.mrt_distance);
    }
    for (const s of data.project_stats) {
      insertStat.run(s.condo_id, s.total_txns, s.avg_annualized, s.max_annualized, s.min_annualized, s.current_avg_psf, s.updated_at);
    }
    for (const t of data.transactions) {
      insertTxn.run(t.id, t.condo_id, t.buy_date, t.sell_date, t.buy_price, t.sell_price, t.size_sqft, t.unit_type, t.floor_level, t.annualized_return, t.source || 'verified', t.created_at);
    }
  });

  tx();
  console.log("Seed complete:", data.condos.length, "condos,", data.transactions.length, "txns");
}

seed();
