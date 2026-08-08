const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');

// Apply the geocode artifact after seeding. This keeps condo coordinates
// reproducible across fresh Docker volumes and Render/VPS redeploys without
// having to call OneMap during app startup.
function applyGeocodes() {
  const filePath = path.join(__dirname, 'public', 'condo-geocodes.json');
  if (!fs.existsSync(filePath)) {
    console.log('No condo geocode artifact found, skipping geocode apply');
    return;
  }

  const rows = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const db = getDb();
  const updateById = db.prepare(`
    UPDATE condos
    SET address = ?, postal = ?, lat = ?, lng = ?,
        geocode_status = ?, geocode_source = ?, geocode_confidence = ?,
        geocode_query = ?, geocoded_at = ?
    WHERE id = ?
  `);
  const updateByName = db.prepare(`
    UPDATE condos
    SET address = ?, postal = ?, lat = ?, lng = ?,
        geocode_status = ?, geocode_source = ?, geocode_confidence = ?,
        geocode_query = ?, geocoded_at = ?
    WHERE name = ? AND district = ?
  `);

  let applied = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const values = [
        row.address || null,
        row.postal || null,
        row.lat,
        row.lng,
        row.geocode_status || 'matched',
        row.geocode_source || 'artifact',
        row.geocode_confidence || null,
        row.geocode_query || null,
        row.geocoded_at || null,
        row.id
      ];
      const result = updateById.run(...values);
      if (result.changes > 0) {
        applied += result.changes;
      } else {
        applied += updateByName.run(
          row.address || null,
          row.postal || null,
          row.lat,
          row.lng,
          row.geocode_status || 'matched',
          row.geocode_source || 'artifact',
          row.geocode_confidence || null,
          row.geocode_query || null,
          row.geocoded_at || null,
          row.name,
          row.district
        ).changes;
      }
    }
  });
  tx();
  console.log(`Applied ${applied} condo geocodes from artifact`);
}

if (require.main === module) {
  applyGeocodes();
}

module.exports = { applyGeocodes };
