const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');

// Seed on startup — loads 85 condos + 1798 txns from bundled JSON
console.log('Checking for seed data...');
require('./seed-startup');

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all condos with aggregated stats
app.get('/api/condos', (req, res) => {
  const db = getDb();
  const { district, area, sortBy, sortDir, search, minTxn } = req.query;

  let sql = `
    SELECT c.id, c.name, c.district, c.area, c.tenure, c.year_completed, c.total_units,
           c.developer, c.mrt_station, c.mrt_distance,
           ps.total_txns, ps.avg_annualized, ps.max_annualized, ps.min_annualized, ps.current_avg_psf
    FROM condos c
    LEFT JOIN project_stats ps ON c.id = ps.condo_id
    WHERE 1=1
  `;
  const params = [];

  if (district) {
    sql += ' AND c.district = ?';
    params.push(district);
  }
  if (area) {
    sql += ' AND c.area = ?';
    params.push(area);
  }
  if (search) {
    sql += ' AND LOWER(c.name) LIKE ?';
    params.push(`%${search.toLowerCase()}%`);
  }
  if (minTxn) {
    sql += ' AND ps.total_txns >= ?';
    params.push(parseInt(minTxn));
  }

  // Default sort by annualized return descending
  const validSorts = ['avg_annualized', 'total_txns', 'name', 'current_avg_psf', 'year_completed', 'district'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'avg_annualized';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const sortTable = ['name', 'year_completed', 'district'].includes(sort) ? 'c' : 'ps';
  sql += ` ORDER BY ${sortTable}.${sort} ${dir} NULLS LAST`;

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// Get districts
app.get('/api/districts', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT district FROM condos ORDER BY district').all();
  res.json(rows.map(r => r.district));
});

// Get areas
app.get('/api/areas', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT DISTINCT area FROM condos ORDER BY area').all();
  res.json(rows.map(r => r.area));
});

// Get single condo details with transaction history
// Reseed from seed-data.json (drops existing data and re-imports)
app.post('/api/reseed', (req, res) => {
  const db = getDb();
  const fs = require('fs');
  const filePath = path.join(__dirname, 'public', 'seed-data.json');
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'No seed-data.json found' });
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  const tx = db.transaction(() => {
    // Drop existing data
    db.exec('DELETE FROM transactions');
    db.exec('DELETE FROM project_stats');
    db.exec('DELETE FROM condos');
    
    // Insert condos
    const insertCondo = db.prepare('INSERT INTO condos (id, name, district, area, tenure, year_completed, total_units, developer, mrt_station, mrt_distance) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const c of data.condos) {
      insertCondo.run(c.id, c.name, c.district, c.area, c.tenure, c.year_completed, c.total_units, c.developer, c.mrt_station, c.mrt_distance);
    }
    
    // Insert stats
    const insertStat = db.prepare('INSERT INTO project_stats (condo_id, total_txns, avg_annualized, max_annualized, min_annualized, current_avg_psf, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const s of data.project_stats) {
      insertStat.run(s.condo_id, s.total_txns, s.avg_annualized, s.max_annualized, s.min_annualized, s.current_avg_psf, s.updated_at);
    }
    
    // Insert transactions
    const insertTxn = db.prepare('INSERT INTO transactions (id, condo_id, buy_date, sell_date, buy_price, sell_price, size_sqft, unit_type, floor_level, annualized_return, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of data.transactions) {
      insertTxn.run(t.id, t.condo_id, t.buy_date, t.sell_date, t.buy_price, t.sell_price, t.size_sqft, t.unit_type, t.floor_level, t.annualized_return, t.created_at);
    }
  });
  
  tx();
  console.log(`Reseeded: ${data.condos.length} condos, ${data.transactions.length} txns`);
  res.json({ success: true, condos: data.condos.length, transactions: data.transactions.length });
});

app.get('/api/condos/:id', (req, res) => {
  const db = getDb();
  const condo = db.prepare(`
    SELECT c.*, ps.*
    FROM condos c
    LEFT JOIN project_stats ps ON c.id = ps.condo_id
    WHERE c.id = ?
  `).get(req.params.id);

  if (!condo) return res.status(404).json({ error: 'Not found' });

  const txns = db.prepare('SELECT * FROM transactions WHERE condo_id = ? ORDER BY sell_date DESC').all(req.params.id);

  res.json({ ...condo, transactions: txns });
});

app.listen(PORT, () => {
  console.log(`🏢 Condo Research app running at http://localhost:${PORT}`);
});
