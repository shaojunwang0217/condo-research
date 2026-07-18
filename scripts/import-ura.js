#!/usr/bin/env node
/**
 * URA Data Service importer for condo-research.
 *
 * Fetches official URA private residential transaction data and project
 * pipeline data, then merges new condos (and optionally inferred buy/sell
 * transaction pairs) into the existing seed-data.json.
 *
 * Usage:
 *   URA_ACCESS_KEY=xxx node scripts/import-ura.js
 *
 * Optional env vars:
 *   URA_MODE=condos-only          (default: only add new condo projects)
 *   URA_MODE=pair-transactions    (also infer buy/sell pairs from transactions)
 *   URA_OUTPUT=public/seed-data.json
 *   URA_EXISTING=public/seed-data.json
 */

const fs = require('fs');
const path = require('path');

const ACCESS_KEY = process.env.URA_ACCESS_KEY;
const MODE = process.env.URA_MODE || 'condos-only';
const OUTPUT = process.env.URA_OUTPUT || path.join(__dirname, '..', 'public', 'seed-data.json');
const EXISTING = process.env.URA_EXISTING || path.join(__dirname, '..', 'public', 'seed-data.json');

const BASE_URL = 'https://eservice.ura.gov.sg/uraDataService';

// Property types considered "condo-like" for this app. URA includes landed
// properties (Detached, Semi-detached, Terrace) in the same dataset; we
// exclude them by default unless you want every private residential project.
const CONDO_LIKE_TYPES = new Set([
  'Condominium',
  'Apartment',
  'Executive Condominium'
]);

// Rough district -> area mapping. URA only gives district numbers, so this
// table is used to populate the human-readable area field.
const DISTRICT_AREA = {
  '01': 'Raffles Place / Marina / Cecil',
  '02': 'Chinatown / Tanjong Pagar',
  '03': 'Alexandra / Commonwealth / Tiong Bahru',
  '04': 'Harbourfront / Telok Blangah / Keppel',
  '05': 'Clementi / Dover / Pasir Panjang / West Coast',
  '06': 'Beach Road / High Street / City Hall',
  '07': 'Golden Mile / Middle Road',
  '08': 'Little India / Farrer Park / Serangoon',
  '09': 'Orchard / River Valley / Cairnhill',
  '10': 'Bukit Timah / Holland / Tanglin',
  '11': 'Newton / Novena / Thomson',
  '12': 'Toa Payoh / Balestier / Serangoon',
  '13': 'MacPherson / Potong Pasir / Braddell',
  '14': 'Paya Lebar / Eunos / Geylang / Sims',
  '15': 'Katong / Joo Chiat / Amber Road / East Coast',
  '16': 'Bedok / Upper East Coast / Siglap / Bayshore',
  '17': 'Changi / Loyang / Flora',
  '18': 'Tampines / Simei / Pasir Ris',
  '19': 'Hougang / Sengkang / Punggol / Serangoon',
  '20': 'Ang Mo Kio / Bishan / Thomson',
  '21': 'Upper Bukit Timah / Clementi Park / Ulu Pandan',
  '22': 'Jurong / Boon Lay / Tuas',
  '23': 'Hillview / Dairy Farm / Bukit Panjang / Choa Chu Kang',
  '24': 'Lim Chu Kang / Tengah / Kranji',
  '25': 'Admiralty / Woodlands',
  '26': 'Upper Thomson / Mandai',
  '27': 'Sembawang / Yishun',
  '28': 'Yio Chu Kang / Seletar'
};

async function getToken(accessKey) {
  const res = await fetch(`${BASE_URL}/insertNewToken/v1`, {
    headers: { AccessKey: accessKey }
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.Status !== 'Success') throw new Error(`Token error: ${json.Message || json.Status}`);
  return json.Result;
}

async function fetchTransactions(token, batch) {
  const res = await fetch(`${BASE_URL}/invokeUraDS/v1?service=PMI_Resi_Transaction&batch=${batch}`, {
    headers: { AccessKey: ACCESS_KEY, Token: token }
  });
  if (!res.ok) throw new Error(`Batch ${batch} failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.Status !== 'Success') throw new Error(`Batch ${batch} error: ${json.Message || json.Status}`);
  return json.Result || [];
}

async function fetchPipeline(token) {
  const res = await fetch(`${BASE_URL}/invokeUraDS/v1?service=PMI_Resi_Pipeline`, {
    headers: { AccessKey: ACCESS_KEY, Token: token }
  });
  if (!res.ok) throw new Error(`Pipeline failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.Status !== 'Success') throw new Error(`Pipeline error: ${json.Message || json.Status}`);
  return json.Result || [];
}

function parseTenure(tenure) {
  if (!tenure) return { tenure: 'Unknown', year: null };
  const t = tenure.trim();
  if (/freehold/i.test(t)) return { tenure: 'Freehold', year: null };
  const m = t.match(/(\d+)\s*yrs?\s*lease\s*commencing\s*from\s*(\d{4})/i);
  if (m) {
    return {
      tenure: `${parseInt(m[1], 10)}-year Leasehold`,
      year: parseInt(m[2], 10)
    };
  }
  return { tenure: '99-year Leasehold', year: null };
}

function parseContractDate(mmyy) {
  const month = mmyy.substring(0, 2);
  const year = mmyy.substring(2);
  const fullYear = parseInt(year, 10) < 50 ? `20${year}` : `19${year}`;
  return `${fullYear}-${month}-01`;
}

function computeAnnualizedReturn(buyPrice, sellPrice, years) {
  if (years <= 0 || buyPrice <= 0) return null;
  return Math.pow(sellPrice / buyPrice, 1 / years) - 1;
}

function sqmToSqft(sqm) {
  return Math.round(parseFloat(sqm) * 10.7639);
}

function unitTypeFromArea(areaSqft) {
  if (areaSqft < 500) return '1-bed';
  if (areaSqft < 800) return '2-bed';
  if (areaSqft < 1100) return '3-bed';
  if (areaSqft < 1400) return '4-bed';
  return '5-bed';
}

function existingKey(c) {
  return `${c.name.toUpperCase().trim()}|${c.district}`;
}

function buildCondoKey(projectName, district) {
  return `${projectName.toUpperCase().trim()}|${district}`;
}

function nowString() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

async function main() {
  if (!ACCESS_KEY) {
    console.error('Please set the URA_ACCESS_KEY environment variable.');
    console.error('Register for a free key at https://eservice.ura.gov.sg/maps/api/reg.html');
    process.exit(1);
  }

  const existingData = fs.existsSync(EXISTING)
    ? JSON.parse(fs.readFileSync(EXISTING, 'utf8'))
    : { condos: [], transactions: [], project_stats: [] };

  const existingMap = new Map(existingData.condos.map(c => [existingKey(c), c]));

  // Split existing data into verified (curated) and previously inferred.
  // URA-inferred transactions are regenerated on each run, so we drop the old
  // ones and keep the verified ones. This keeps the output idempotent.
  const verifiedTransactions = existingData.transactions.filter(t => t.source !== 'URA-inferred');
  const verifiedCondoIds = new Set(verifiedTransactions.map(t => t.condo_id));
  const inferredOnlyCondoIds = new Set(
    existingData.transactions
      .filter(t => t.source === 'URA-inferred' && !verifiedCondoIds.has(t.condo_id))
      .map(t => t.condo_id)
  );
  const verifiedStats = existingData.project_stats.filter(s => !inferredOnlyCondoIds.has(s.condo_id));

  // Track which existing condos already have curated transactions. We will only
  // generate URA-inferred transactions for condos that have no verified data,
  // to avoid mixing verified records with algorithmic estimates.
  const existingTxnCounts = new Map();
  for (const t of verifiedTransactions) {
    existingTxnCounts.set(t.condo_id, (existingTxnCounts.get(t.condo_id) || 0) + 1);
  }

  console.log('Requesting URA token...');
  const token = await getToken(ACCESS_KEY);
  console.log('Token obtained.');

  console.log('Fetching transactions (batches 1-4) and pipeline...');
  const [txBatches, pipeline] = await Promise.all([
    Promise.all([1, 2, 3, 4].map(b => fetchTransactions(token, b))),
    fetchPipeline(token)
  ]);
  const projects = txBatches.flat();
  console.log(`Fetched ${projects.length} projects with transaction history.`);

  const pipelineMap = new Map();
  for (const p of pipeline) {
    const key = buildCondoKey(p.project, `D${p.district.padStart(2, '0')}`);
    pipelineMap.set(key, p);
  }

  const newCondos = [];
  const newTransactions = [];
  const newStats = [];

  let nextCondoId = Math.max(0, ...existingData.condos.map(c => c.id || 0)) + 1;
  let nextTxnId = Math.max(0, ...existingData.transactions.map(t => t.id || 0)) + 1;

  const projectGroups = new Map();

  for (const project of projects) {
    const projectName = project.project.trim().toUpperCase();
    const rawTransactions = project.transaction || [];
    if (rawTransactions.length === 0) continue;

    // Only keep projects that have at least one condo-like transaction.
    const condoLikeTxns = rawTransactions.filter(t =>
      CONDO_LIKE_TYPES.has(t.propertyType)
    );
    if (condoLikeTxns.length === 0) continue;

    // Group transactions by district (the project object itself does not have a
    // district field; the district lives on each transaction record).
    const byDistrict = new Map();
    for (const t of condoLikeTxns) {
      const district = `D${String(t.district).padStart(2, '0')}`;
      if (!byDistrict.has(district)) {
        byDistrict.set(district, { transactions: [], tenure: t.tenure, area: t.area });
      }
      byDistrict.get(district).transactions.push(t);
    }

    for (const [district, info] of byDistrict) {
      const key = buildCondoKey(projectName, district);
      let condo = existingMap.get(key);

      // Create a new condo record if this project+district is not already known.
      if (!condo) {
        const pipe = pipelineMap.get(key);
        const tenureInfo = parseTenure(project.tenure || info.tenure || info.transactions[0]?.tenure);
        const topYear =
          (pipe && pipe.expectedTOPYear && pipe.expectedTOPYear !== 'na' && parseInt(pipe.expectedTOPYear, 10)) ||
          tenureInfo.year ||
          null;

        condo = {
          id: nextCondoId++,
          name: projectName,
          district,
          area: DISTRICT_AREA[district.replace('D', '')] || 'Unknown',
          tenure: tenureInfo.tenure,
          year_completed: topYear,
          total_units: pipe && pipe.totalUnits ? parseInt(pipe.totalUnits, 10) : null,
          developer: pipe && pipe.developerName ? pipe.developerName : null,
          mrt_station: null,
          mrt_distance: null,
          created_at: nowString()
        };

        newCondos.push(condo);
        existingMap.set(key, condo);
      }

      // Only generate URA-inferred transactions for condos that have no
      // existing verified transactions. This keeps manually curated data
      // separate from algorithmic estimates.
      if (!existingTxnCounts.has(condo.id)) {
        if (!projectGroups.has(key)) projectGroups.set(key, { condo, transactions: [] });
        const pg = projectGroups.get(key);
        for (const t of info.transactions) {
          pg.transactions.push(t);
        }
      }
    }
  }

  // In pair-transactions mode, we infer buy/sell pairs by chaining consecutive
  // transactions of the same inferred unit (same area/floor range/property type).
  // This is an approximation, so the resulting annualized returns are estimates.
  if (MODE === 'pair-transactions') {
    for (const pg of projectGroups.values()) {
      const byUnit = {};
      for (const t of pg.transactions) {
        const unitKey = `${t.propertyType}|${t.typeOfArea}|${t.area}|${t.floorRange}|${t.noOfUnits}`;
        if (!byUnit[unitKey]) byUnit[unitKey] = [];
        byUnit[unitKey].push(t);
      }

      for (const unitKey of Object.keys(byUnit)) {
        const sorted = byUnit[unitKey].sort((a, b) =>
          parseContractDate(a.contractDate).localeCompare(parseContractDate(b.contractDate))
        );
        for (let i = 0; i < sorted.length - 1; i++) {
          const buy = sorted[i];
          const sell = sorted[i + 1];
          const buyDate = parseContractDate(buy.contractDate);
          const sellDate = parseContractDate(sell.contractDate);
          const holdYears = (new Date(sellDate) - new Date(buyDate)) / (365.25 * 24 * 60 * 60 * 1000);
          if (holdYears <= 0) continue;

          const buyPrice = parseFloat(buy.price);
          const sellPrice = parseFloat(sell.price);

          // Skip bulk/multiple-unit transactions and very short hold periods.
          if (parseInt(buy.noOfUnits, 10) > 1 || parseInt(sell.noOfUnits, 10) > 1) continue;
          if (holdYears < 1.0) continue;

          const annReturn = computeAnnualizedReturn(buyPrice, sellPrice, holdYears);
          if (annReturn === null) continue;

          const sizeSqft = sqmToSqft(buy.area);
          newTransactions.push({
            id: nextTxnId++,
            condo_id: pg.condo.id,
            buy_date: buyDate,
            sell_date: sellDate,
            buy_price: buyPrice,
            sell_price: sellPrice,
            size_sqft: sizeSqft,
            unit_type: unitTypeFromArea(sizeSqft),
            floor_level: buy.floorRange,
            annualized_return: annReturn,
            source: 'URA-inferred',
            created_at: nowString()
          });
        }
      }
    }
  }

  // Compute project_stats for newly added condos.
  const txnByCondo = new Map();
  for (const t of newTransactions) {
    if (!txnByCondo.has(t.condo_id)) txnByCondo.set(t.condo_id, []);
    txnByCondo.get(t.condo_id).push(t);
  }
  for (const [condoId, txns] of txnByCondo) {
    const returns = txns.map(t => t.annualized_return).filter(r => r != null);
    const avg = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : null;
    const max = returns.length ? Math.max(...returns) : null;
    const min = returns.length ? Math.min(...returns) : null;
    const avgPsf = txns.length
      ? txns.reduce((sum, t) => sum + (t.sell_price / t.size_sqft), 0) / txns.length
      : null;
    newStats.push({
      condo_id: condoId,
      total_txns: txns.length,
      avg_annualized: avg,
      max_annualized: max,
      min_annualized: min,
      current_avg_psf: avgPsf,
      updated_at: nowString()
    });
  }

  // Avoid duplicate project_stats when a condo that previously had a 0-txn
  // stat row now has inferred transactions.
  const newStatsIds = new Set(newStats.map(s => s.condo_id));
  const mergedStats = [
    ...verifiedStats.filter(s => !newStatsIds.has(s.condo_id)),
    ...newStats
  ];

  const merged = {
    condos: [...existingData.condos, ...newCondos],
    transactions: [...verifiedTransactions, ...newTransactions],
    project_stats: mergedStats
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(merged, null, 2));
  console.log(`\nWrote ${OUTPUT}`);
  console.log(`  New condos:        ${newCondos.length}`);
  console.log(`  New transactions:  ${newTransactions.length}`);
  console.log(`  New project stats: ${newStats.length}`);
  console.log(`  Total condos:      ${merged.condos.length}`);
  console.log(`  Total transactions:${merged.transactions.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
