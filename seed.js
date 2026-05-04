const { getDb } = require('./db');
const d12 = require('./seed-d12');
const d19 = require('./seed-d19');
const d18 = require('./seed-d18');
const sengkang = require('./seed-sengkang');
const punggol = require('./seed-punggol');
const pasirris = require('./seed-pasirris');
const changi = require('./seed-changi');

function seed() {
  const db = getDb();

  // Clear all data
  db.exec('DELETE FROM project_stats');
  db.exec('DELETE FROM transactions');
  db.exec('DELETE FROM condos');

  const insertCondo = db.prepare(`INSERT OR IGNORE INTO condos (name, district, area, tenure, year_completed, total_units, developer, mrt_station, mrt_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const all = [...d12, ...d19, ...d18, ...sengkang, ...punggol, ...pasirris, ...changi];

  const txn = db.transaction(() => {
    for (const proj of all) {
      insertCondo.run(proj.condo, proj.district, proj.area, proj.tenure || '99-year Leasehold', proj.year, proj.units, proj.dev, proj.mrt, proj.mrtDist);
    }
  });

  txn();
  console.log(`Seeded ${all.length} condo projects with no transaction data. Add real data via seed files.`);
}

seed();
