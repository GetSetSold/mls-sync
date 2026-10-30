import { createClient } from '@supabase/supabase-js';

// ---------------- Supabase Setup ----------------
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

// ---------------- Helpers ----------------
// Semantics mirror supabase/migrations/20261013000001_city_hub_performance.sql
// (the RPCs this table replaces), so the numbers don't change when the site
// switches from RPC reads to table reads.

// Same as normalizeCity in the CMS (src/lib/mls.ts): DDF concatenates
// district info into City ("Toronto (Waterfront Communities)").
function normalizeCity(city) {
  const cleaned = (city || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return cleaned || (city || '').trim();
}

function isUnknown(normalized) {
  return !normalized || normalized.toLowerCase() === 'unknown';
}

// Hood type label: the RPC casts property.StructureType to TEXT, which can
// emit brace/JSON-wrapped values for multi-value types. The site's own
// structureTypeText helper (first element, else the string) is the clean
// display form the detail page already uses — this is the one deliberate
// deviation from the RPC, so labels read "Detached" instead of a wrapped
// form. Counts group by primary type either way only when a row has one
// type; multi-type rows group under their first type here.
function hoodTypeLabel(v) {
  if (Array.isArray(v)) {
    const first = v.filter(Boolean)[0];
    return first ? String(first).trim() || 'Other' : 'Other';
  }
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[')) {
      try {
        const arr = JSON.parse(t);
        if (Array.isArray(arr)) {
          const first = arr.filter(Boolean)[0];
          return first ? String(first).trim() || 'Other' : 'Other';
        }
      } catch { /* not JSON, use raw */ }
    }
    return t || 'Other';
  }
  return 'Other';
}

// City type label: exactly the RPC rule on grid.StructureTypeText.
function cityTypeLabel(v) {
  const t = typeof v === 'string' ? v.trim() : '';
  return t || 'Other';
}

// Postgres percentile_cont(0.5) interpolation: odd -> middle value,
// even -> average of the two middle values.
function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function emptyGroup() {
  return {
    active: 0, sale: 0, lease: 0,
    salePrices: [], leasePrices: [],
    types: new Map(),
  };
}

// Sale and lease counts are INDEPENDENT (COUNT("ListPrice") and
// COUNT("TotalActualRent") in the RPCs): a row with both prices counts
// toward both, and toward both medians.
function addRow(g, listPrice, totalRent, label) {
  g.active += 1;
  if (listPrice != null) {
    g.sale += 1;
    g.salePrices.push(Number(listPrice));
  }
  if (totalRent != null) {
    g.lease += 1;
    g.leasePrices.push(Number(totalRent));
  }
  g.types.set(label, (g.types.get(label) ?? 0) + 1);
}

// RPCs cap the breakdown at 6 labels, ordered by count desc.
function finishGroup(g) {
  g.salePrices.sort((a, b) => a - b);
  g.leasePrices.sort((a, b) => a - b);
  const types = [...g.types.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 6);
  return {
    active_count: g.active,
    sale_count: g.sale,
    lease_count: g.lease,
    median_sale: median(g.salePrices),
    median_lease: median(g.leasePrices),
    type_breakdown: types,
  };
}

async function upsertAll(table, rows, onConflict) {
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(batch, { onConflict });
    if (error) throw new Error(`upsert ${table} failed: ${error.message}`);
  }
}

async function pageScan(table, cols, onRow) {
  let lastKey = null;
  let scanned = 0;
  while (true) {
    let q = supabase.from(table).select(cols).order('ListingKey', { ascending: true }).limit(1000);
    if (lastKey) q = q.gt('ListingKey', lastKey);
    const { data, error } = await q;
    if (error) throw new Error(`${table} scan failed: ${error.message}`);
    if (!data || !data.length) break;
    for (const row of data) {
      scanned += 1;
      onRow(row);
    }
    if (data.length < 1000) break;
    lastKey = data[data.length - 1].ListingKey;
  }
  return scanned;
}

// ---------------- Main ----------------
async function main() {
  const runStarted = new Date().toISOString();
  console.log(`update-stats: run started ${runStarted}`);

  // ---- Hood stats: from property (same source as the hood RPCs). ----
  // Hood match is OR-based in the RPCs (TRIM(CityRegion) = hood OR
  // TRIM(SubdivisionName) = hood): a row with two different non-empty
  // values counts toward BOTH hoods' pages, once each.
  const hoodGroups = new Map(); // "city|||hood" -> group
  const unknownByHood = new Map(); // hood -> group (unknown-city rows)
  const hoodCityCounts = new Map(); // hood -> Map(city -> known count)

  const hoodRow = (row) => {
    const normalized = normalizeCity(row.City || '');
    const hoods = [...new Set(
      [row.CityRegion, row.SubdivisionName]
        .map((v) => (typeof v === 'string' ? v.trim() : ''))
        .filter(Boolean)
    )];
    if (isUnknown(normalized)) {
      // Unknown-city rows never get their own city page. For hood stats
      // they fold into that hood's primary city below (same rule as the
      // site's neighbourhood scan); city stats exclude them entirely.
      for (const hood of hoods) {
        let g = unknownByHood.get(hood);
        if (!g) unknownByHood.set(hood, (g = emptyGroup()));
        addRow(g, row.ListPrice, row.TotalActualRent, hoodTypeLabel(row.StructureType));
      }
      return;
    }
    for (const hood of hoods) {
      const key = normalized + '|||' + hood;
      let hg = hoodGroups.get(key);
      if (!hg) hoodGroups.set(key, (hg = emptyGroup()));
      addRow(hg, row.ListPrice, row.TotalActualRent, hoodTypeLabel(row.StructureType));
      let cm = hoodCityCounts.get(hood);
      if (!cm) hoodCityCounts.set(hood, (cm = new Map()));
      cm.set(normalized, (cm.get(normalized) ?? 0) + 1);
    }
  };

  const propertyScanned = await pageScan(
    'property',
    'ListingKey,City,CityRegion,SubdivisionName,ListPrice,TotalActualRent,StructureType',
    hoodRow
  );
  console.log(`update-stats: scanned ${propertyScanned} property rows`);

  // Fold unknown-city rows into each hood's primary city (most known
  // listings). Hoods with only unknown rows are skipped — no primary city.
  for (const [hood, g] of unknownByHood) {
    const cm = hoodCityCounts.get(hood);
    if (!cm || cm.size === 0) continue;
    const topCity = [...cm.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const hg = hoodGroups.get(topCity + '|||' + hood);
    if (!hg) continue;
    hg.active += g.active;
    hg.sale += g.sale;
    hg.lease += g.lease;
    hg.salePrices.push(...g.salePrices);
    hg.leasePrices.push(...g.leasePrices);
    for (const [label, count] of g.types) {
      hg.types.set(label, (hg.types.get(label) ?? 0) + count);
    }
  }

  // ---- City stats: from grid (same source as the city RPCs). ----
  const cityGroups = new Map(); // normalized city -> group
  const gridScanned = await pageScan(
    'grid',
    'ListingKey,City,ListPrice,TotalActualRent,StructureTypeText',
    (row) => {
      const normalized = normalizeCity(row.City || '');
      if (isUnknown(normalized)) return;
      let cg = cityGroups.get(normalized);
      if (!cg) cityGroups.set(normalized, (cg = emptyGroup()));
      addRow(cg, row.ListPrice, row.TotalActualRent, cityTypeLabel(row.StructureTypeText));
    }
  );
  console.log(`update-stats: scanned ${gridScanned} grid rows`);

  const hoodRows = [...hoodGroups.entries()].map(([key, g]) => {
    const sep = key.indexOf('|||');
    return {
      city: key.slice(0, sep),
      hood: key.slice(sep + 3),
      ...finishGroup(g),
      updated_at: runStarted,
    };
  });
  const cityRows = [...cityGroups.entries()].map(([city, g]) => ({
    city,
    ...finishGroup(g),
    updated_at: runStarted,
  }));

  await upsertAll('hood_stats', hoodRows, ['city', 'hood']);
  await upsertAll('city_stats', cityRows, ['city']);
  console.log(`update-stats: upserted ${hoodRows.length} hood rows, ${cityRows.length} city rows`);

  // Drop rows for hoods/cities that no longer exist (all current groups
  // were just upserted with this run's timestamp).
  for (const table of ['hood_stats', 'city_stats']) {
    const { error } = await supabase.from(table).delete().lt('updated_at', runStarted);
    if (error) throw new Error(`stale cleanup ${table} failed: ${error.message}`);
  }
  console.log('update-stats: stale rows cleaned, done');
}

main().catch((err) => {
  console.error('update-stats FAILED:', err);
  process.exit(1);
});
