const express = require('express');
const cors = require('cors');
const path = require('path');
const { getDb } = require('./db');

// Seed on startup from bundled JSON, then apply geocode artifact.
console.log('Checking for seed data...');
require('./seed-startup');
require('./apply-geocodes').applyGeocodes();

const app = express();
const PORT = process.env.PORT || 3456;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Get all condos with aggregated stats
function buildCondosWhere(req) {
  const { district, area, search, minTxn } = req.query;
  let sql = `
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

  return { sql, params };
}

app.get('/api/condos', (req, res) => {
  const db = getDb();
  const { sortBy, sortDir } = req.query;
  const { sql: whereSql, params } = buildCondosWhere(req);

  const validSorts = ['avg_annualized', 'total_txns', 'name', 'current_avg_psf', 'year_completed', 'district'];
  const sort = validSorts.includes(sortBy) ? sortBy : 'avg_annualized';
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const sortTable = ['name', 'year_completed', 'district'].includes(sort) ? 'c' : 'ps';
  const orderSql = ` ORDER BY ${sortTable}.${sort} ${dir} NULLS LAST`;

  const selectCols = `
    c.id, c.name, c.district, c.area, c.tenure, c.year_completed, c.total_units,
    c.developer, c.mrt_station, c.mrt_distance, c.address, c.postal, c.lat, c.lng,
    c.geocode_status, c.geocode_source, c.geocode_confidence,
    ps.total_txns, ps.avg_annualized, ps.max_annualized, ps.min_annualized, ps.current_avg_psf
  `;

  const page = parseInt(req.query.page, 10) || 0;
  const limit = parseInt(req.query.limit, 10) || 0;

  // Backwards-compatible: if no pagination requested, return full array
  if (page <= 0 || limit <= 0) {
    const rows = db.prepare(`SELECT ${selectCols} ${whereSql} ${orderSql}`).all(...params);
    return res.json(rows);
  }

  const countRow = db.prepare(`SELECT COUNT(*) as total ${whereSql}`).get(...params);
  const total = countRow.total;
  const pages = Math.ceil(total / limit) || 1;
  const offset = (page - 1) * limit;

  const rows = db.prepare(`SELECT ${selectCols} ${whereSql} ${orderSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  const summaryRow = db.prepare(`
    SELECT COUNT(*) as count, AVG(ps.avg_annualized) as avg_return, SUM(ps.total_txns) as total_txns
    ${whereSql}
  `).get(...params);

  const topRow = db.prepare(`
    SELECT c.name, ps.avg_annualized
    ${whereSql}
    ORDER BY ps.avg_annualized DESC NULLS LAST
    LIMIT 1
  `).get(...params);

  res.json({
    condos: rows,
    total,
    page,
    limit,
    pages,
    summary: {
      count: summaryRow.count,
      avg_return: summaryRow.avg_return,
      total_txns: summaryRow.total_txns,
      top_performer: topRow || null
    }
  });
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

// Geocode coverage status
app.get('/api/geocode-status', (req, res) => {
  const db = getDb();
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN lat IS NOT NULL AND lng IS NOT NULL THEN 1 ELSE 0 END) AS geocoded,
      SUM(CASE WHEN geocode_status = 'matched' THEN 1 ELSE 0 END) AS matched,
      SUM(CASE WHEN geocode_status = 'review' THEN 1 ELSE 0 END) AS review,
      SUM(CASE WHEN geocode_status = 'ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
      SUM(CASE WHEN geocode_status = 'unmatched' THEN 1 ELSE 0 END) AS unmatched,
      SUM(CASE WHEN geocode_status = 'error' THEN 1 ELSE 0 END) AS errors
    FROM condos
  `).get();
  const bySource = db.prepare(`
    SELECT COALESCE(geocode_source, 'none') AS source, COUNT(*) AS count
    FROM condos
    WHERE lat IS NOT NULL AND lng IS NOT NULL
    GROUP BY COALESCE(geocode_source, 'none')
    ORDER BY count DESC
  `).all();
  res.json({ ...totals, bySource });
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
    const insertTxn = db.prepare('INSERT INTO transactions (id, condo_id, buy_date, sell_date, buy_price, sell_price, size_sqft, unit_type, floor_level, annualized_return, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const t of data.transactions) {
      insertTxn.run(t.id, t.condo_id, t.buy_date, t.sell_date, t.buy_price, t.sell_price, t.size_sqft, t.unit_type, t.floor_level, t.annualized_return, t.source || 'verified', t.created_at);
    }
  });
  
  tx();
  require('./apply-geocodes').applyGeocodes();
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
