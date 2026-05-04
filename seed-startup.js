const { getDb } = require("./db");
const fs = require("fs");
const path = require("path");

function seed() {
  const db = getDb();

  // Check if data exists
  const count = db.prepare("SELECT COUNT(*) as c FROM condos").get();
  if (count.c > 0) {
    console.log(`DB already has ${count.c} condos, skipping seed`);
    return;
  }

  const filePath = path.join(__dirname, "seed-data.json");
  if (!fs.existsSync(filePath)) {
    console.log("No seed-data.json found, starting empty");
    return;
  }

  const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  console.log(`Seeding ${data.condos.length} condos, ${data.transactions.length} txns...`);

  const insertCondo = db.prepare(`INSERT INTO condos (id, name, district, area, tenure, year_completed, total_units, developer, mrt_station, mrt_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertStat = db.prepare(`INSERT INTO project_stats (condo_id, total_txns, avg_annualized, max_annualized, min_annualized, current_avg_psf, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(condo_id) DO UPDATE SET total_txns = excluded.total_txns, avg_annualized = excluded.avg_annualized, max_annualized = excluded.max_annualized, min_annualized = excluded.min_annualized, current_avg_psf = excluded.current_avg_psf, updated_at = excluded.updated_at`);
  const insertTxn = db.prepare(`INSERT INTO transactions (id, condo_id, buy_date, sell_date, buy_price, sell_price, size_sqft, unit_type, floor_level, annualized_return, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    for (const c of data.condos) {
      insertCondo.run(c.id, c.name, c.district, c.area, c.tenure, c.year_completed, c.total_units, c.developer, c.mrt_station, c.mrt_distance);
    }
    for (const s of data.project_stats) {
      insertStat.run(s.condo_id, s.total_txns, s.avg_annualized, s.max_annualized, s.min_annualized, s.current_avg_psf, s.updated_at);
    }
    for (const t of data.transactions) {
      insertTxn.run(t.id, t.condo_id, t.buy_date, t.sell_date, t.buy_price, t.sell_price, t.size_sqft, t.unit_type, t.floor_level, t.annualized_return, t.created_at);
    }
  });

  tx();
  console.log("Seed complete");
}

seed();
