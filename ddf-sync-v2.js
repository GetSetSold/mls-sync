// ddf-sync-v2.js — Replication-based DDF sync (DRAFT — test before replacing ddf-sync.js)
//
// Uses the documented replication endpoint as the source of truth:
//   GET /odata/v1/Property/PropertyReplication()  ->  [{ListingKey, ModificationTimestamp}] (~57k, one page)
//
// Each run:
//   1. Fetch all replication identifiers (cheap: key + timestamp only).
//   2. Diff against DB -> new keys, changed keys (timestamp differs), deleted keys.
//   3. Fetch FULL Property records ONLY for new+changed keys (batched $filter).
//   4. Upsert into property + grid; delete keys missing from the replication set.
//
// This replaces BOTH modes of ddf-sync.js (full + incremental): every run is a
// cheap full diff. Do NOT run concurrently with ddf-sync.js / fetch-grid.js —
// they write the same tables.
//
// NOTE: test via workflow_dispatch before switching the schedules over.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');
const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing DDF_CLIENT_ID / DDF_CLIENT_SECRET environment variables');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const REPLICATION_URL = 'https://ddfapi.realtor.ca/odata/v1/Property/PropertyReplication()';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// How many ListingKeys per batched $filter when pulling full records
const FETCH_BATCH_SIZE = 50;
// Upsert write batch size
const UPSERT_BATCH_SIZE = 500;
// DB range-scan page size
const DB_SCAN_BATCH = 1000;
// Office lookup concurrency
const OFFICE_CONCURRENCY = 10;

let token = null;
let tokenFetchedAt = 0;

async function getAccessToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'DDFApi_Read',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'Failed to fetch DDF token');
  token = data.access_token;
  tokenFetchedAt = Date.now();
  return token;
}

async function authHeaders() {
  // DDF tokens live 60 min — refresh before expiry on long runs
  if (!token || Date.now() - tokenFetchedAt > 50 * 60 * 1000) {
    console.log('  (refreshing DDF access token...)');
    await getAccessToken();
  }
  return { Authorization: `Bearer ${token}` };
}

// =====================
// 1. Fetch all replication identifiers {ListingKey, ModificationTimestamp}
// =====================
async function fetchReplicationIdentifiers() {
  console.log('Fetching replication identifiers...');
  const identifiers = [];
  let url = REPLICATION_URL;
  let page = 0;
  while (url) {
    page++;
    const res = await fetch(url, { headers: await authHeaders() });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.value)) {
      throw new Error(`Replication fetch failed (page ${page}): HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    }
    for (const r of data.value) {
      if (r.ListingKey) identifiers.push({ key: r.ListingKey, ts: r.ModificationTimestamp || null });
    }
    console.log(`  page ${page}: ${identifiers.length} identifiers so far...`);
    url = data['@odata.nextLink'] || null;
  }
  console.log(`Replication identifiers: ${identifiers.length}`);
  return identifiers;
}

// =====================
// 2. Scan DB keys + their stored ModificationTimestamp (property table has it)
// =====================
async function fetchDbState(table, withTimestamp) {
  const cols = withTimestamp ? 'ListingKey, ModificationTimestamp' : 'ListingKey';
  const map = new Map();
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(from, from + DB_SCAN_BATCH - 1);
    if (error) throw new Error(`DB scan failed for ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const r of data) map.set(r.ListingKey, withTimestamp ? (r.ModificationTimestamp || null) : true);
    if (data.length < DB_SCAN_BATCH) break;
    from += DB_SCAN_BATCH;
  }
  return map;
}

// =====================
// 3. Fetch full Property records for a batch of keys.
//    Tries a batched $filter first; on failure, splits in half recursively
//    down to single-record lookups so one bad key can't kill the batch.
// =====================
async function fetchFullRecords(keys) {
  if (keys.length === 0) return [];
  if (keys.length === 1) {
    // Single-record lookup, function-style per DDF docs
    const url = `${PROPERTY_URL}('${encodeURIComponent(keys[0])}')`;
    const res = await fetch(url, { headers: await authHeaders() });
    const data = await res.json();
    if (!res.ok) {
      console.error(`  Single fetch failed for ${keys[0]}: HTTP ${res.status}`);
      return [];
    }
    return data.value ? data.value : [data];
  }
  const filter = keys.map(k => `ListingKey eq '${k.replace(/'/g, "''")}'`).join(' or ');
  const url = `${PROPERTY_URL}?$top=${keys.length * 2}&$filter=${encodeURIComponent(filter)}`;
  try {
    const res = await fetch(url, { headers: await authHeaders() });
    const data = await res.json();
    if (!res.ok || !Array.isArray(data.value)) throw new Error(`HTTP ${res.status}`);
    return data.value;
  } catch (e) {
    console.error(`  Batched fetch failed (${keys.length} keys): ${e.message} — splitting`);
    const mid = Math.ceil(keys.length / 2);
    const a = await fetchFullRecords(keys.slice(0, mid));
    const b = await fetchFullRecords(keys.slice(mid));
    return [...a, ...b];
  }
}

// =====================
// Office details (cached per run, chunked, one retry)
// =====================
async function fetchOfficeDetails(officeKeys, cache) {
  const uniqueKeys = [...new Set(officeKeys)].filter(Boolean).filter(k => !cache.has(k));
  async function lookup(key) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, { headers: await authHeaders() });
        const data = await res.json();
        return (data.value && data.value[0]?.OfficeName) || 'Unknown';
      } catch (e) {
        if (attempt === 2) { console.error(`  Office lookup failed for ${key}: ${e.message}`); return 'Unknown'; }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }
  for (let i = 0; i < uniqueKeys.length; i += OFFICE_CONCURRENCY) {
    const chunk = uniqueKeys.slice(i, i + OFFICE_CONCURRENCY);
    const names = await Promise.all(chunk.map(lookup));
    chunk.forEach((k, idx) => cache.set(k, names[idx]));
  }
  return cache;
}

// =====================
// Mapping (same shapes as ddf-sync.js v1)
// =====================
function mapForProperty(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails.get(officeKey) || 'Unknown' : 'Unknown';
    return {
      ListingKey: property.ListingKey,
      ListOfficeKey: officeKey,
      OfficeName: officeName,
      PropertySubType: property.PropertySubType,
      TotalActualRent: property.TotalActualRent,
      NumberOfUnitsTotal: property.NumberOfUnitsTotal,
      LotFeatures: property.LotFeatures,
      LotSizeArea: property.LotSizeArea,
      LotSizeDimensions: property.LotSizeDimensions,
      LotSizeUnits: property.LotSizeUnits,
      PoolFeatures: property.PoolFeatures,
      CommunityFeatures: property.CommunityFeatures,
      Appliances: property.Appliances,
      AssociationFee: property.AssociationFee,
      AssociationFeeIncludes: property.AssociationFeeIncludes,
      OriginalEntryTimestamp: property.OriginalEntryTimestamp,
      ModificationTimestamp: property.ModificationTimestamp,
      ListingId: property.ListingId,
      StatusChangeTimestamp: property.StatusChangeTimestamp,
      PublicRemarks: property.PublicRemarks,
      ListPrice: property.ListPrice,
      OriginatingSystemName: property.OriginatingSystemName,
      PhotosCount: property.PhotosCount,
      PhotosChangeTimestamp: property.PhotosChangeTimestamp,
      CommonInterest: property.CommonInterest,
      UnparsedAddress: property.Address?.UnparsedAddress || property.UnparsedAddress || null,
      City: property.Address?.City || property.City || 'Unknown',
      UnitNumber: property.Address?.UnitNumber || property.UnitNumber || null,
      Province: property.Address?.Province || property.Province || 'ON',
      PostalCode: property.Address?.PostalCode || property.PostalCode || null,
      SubdivisionName: property.SubdivisionName,
      Directions: property.Directions,
      Latitude: property.Latitude,
      Longitude: property.Longitude,
      CityRegion: property.CityRegion,
      ParkingTotal: property.ParkingTotal,
      YearBuilt: property.YearBuilt,
      BathroomsPartial: property.BathroomsPartial,
      BathroomsTotalInteger: property.BathroomsTotalInteger,
      BedroomsTotal: property.BedroomsTotal,
      BuildingAreaTotal: property.BuildingAreaTotal,
      BuildingAreaUnits: property.BuildingAreaUnits,
      BuildingFeatures: property.BuildingFeatures,
      AboveGradeFinishedArea: property.AboveGradeFinishedArea,
      BelowGradeFinishedArea: property.BelowGradeFinishedArea,
      LivingArea: property.LivingArea,
      FireplacesTotal: property.FireplacesTotal,
      ArchitecturalStyle: property.ArchitecturalStyle,
      Heating: property.Heating,
      FoundationDetails: property.FoundationDetails,
      Basement: property.Basement,
      ExteriorFeatures: property.ExteriorFeatures,
      Flooring: property.Flooring,
      ParkingFeatures: property.ParkingFeatures,
      Cooling: property.Cooling,
      WaterSource: property.WaterSource,
      Utilities: property.Utilities,
      Sewer: property.Sewer,
      Roof: property.Roof,
      ConstructionMaterials: property.ConstructionMaterials,
      Stories: property.Stories,
      BedroomsAboveGrade: property.BedroomsAboveGrade,
      BedroomsBelowGrade: property.BedroomsBelowGrade,
      TaxAnnualAmount: property.TaxAnnualAmount,
      TaxYear: property.TaxYear,
      Media: property.Media,
      Rooms: property.Rooms,
      StructureType: property.StructureType,
      ListingURL: property.ListingURL,
    };
  });
}

function mapForGrid(properties, officeDetails) {
  return properties.map(p => {
    const officeKey = p.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails.get(officeKey) || 'Unknown' : 'Unknown';
    let firstPhoto = null;
    if (Array.isArray(p.Media)) {
      const photo = p.Media.find(m => m.Order === 1);
      if (photo) firstPhoto = photo.MediaURL;
    }
    let structureTypeText = null;
    if (Array.isArray(p.StructureType) && p.StructureType.length > 0) {
      structureTypeText = p.StructureType[0];
    } else if (typeof p.StructureType === 'string') {
      structureTypeText = p.StructureType;
    }
    return {
      ListingKey: p.ListingKey,
      ListOfficeKey: officeKey,
      OfficeName: officeName,
      TotalActualRent: p.TotalActualRent,
      OriginalEntryTimestamp: p.OriginalEntryTimestamp,
      ModificationTimestamp: p.ModificationTimestamp,
      ListPrice: p.ListPrice,
      PhotosCount: p.PhotosCount,
      Media: firstPhoto,
      UnparsedAddress: p.Address?.UnparsedAddress || p.UnparsedAddress || null,
      City: p.Address?.City || p.City || 'Unknown',
      UnitNumber: p.Address?.UnitNumber || p.UnitNumber || null,
      Province: p.Address?.Province || p.Province || 'ON',
      PostalCode: p.Address?.PostalCode || p.PostalCode || null,
      Latitude: p.Latitude,
      Longitude: p.Longitude,
      ParkingTotal: p.ParkingTotal,
      BathroomsTotalInteger: p.BathroomsTotalInteger,
      BedroomsTotal: p.BedroomsTotal,
      AboveGradeFinishedArea: p.AboveGradeFinishedArea,
      StructureTypeText: structureTypeText,
    };
  });
}
// NOTE: mapForGrid now includes ModificationTimestamp. Run once before switching:
//   alter table grid add column if not exists "ModificationTimestamp" text;

async function upsertBatch(table, rows) {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict: ['ListingKey'] });
    if (error) {
      // One bad row shouldn't nuke the batch: fall back to row-by-row for this chunk
      console.error(`  Upsert batch failed (${table}, ${batch.length} rows): ${error.message} — retrying row-by-row`);
      for (const row of batch) {
        const { error: rowErr } = await supabase.from(table).upsert(row, { onConflict: ['ListingKey'] });
        if (rowErr) console.error(`  Row ${row.ListingKey} failed permanently: ${rowErr.message}`);
      }
    }
  }
}

async function deleteKeys(table, keys) {
  let deleted = 0;
  for (let i = 0; i < keys.length; i += UPSERT_BATCH_SIZE) {
    const chunk = keys.slice(i, i + UPSERT_BATCH_SIZE);
    const { data, error } = await supabase.from(table).delete().in('ListingKey', chunk).select('ListingKey');
    if (error) console.error(`  Delete failed (${table}): ${error.message}`);
    else deleted += data?.length || 0;
  }
  return deleted;
}

// =====================
// Main
// =====================
async function main() {
  const t0 = Date.now();
  const counters = { added: 0, updated: 0, deleted: 0, fetched: 0 };
  try {
    await getAccessToken();

    // 1. Replication identifiers = source of truth
    const identifiers = await fetchReplicationIdentifiers();
    const liveKeys = new Set(identifiers.map(r => r.key));
    const liveTs = new Map(identifiers.map(r => [r.key, r.ts]));

    // 2. Current DB state
    console.log('Scanning DB keys...');
    const dbProperty = await fetchDbState('property', true);   // key -> ModificationTimestamp
    const dbGridKeys = await fetchDbState('grid', false);       // key -> true
    console.log(`  DB: ${dbProperty.size} property rows, ${dbGridKeys.size} grid rows`);

    // 3. Diff
    const toFetch = [];
    for (const { key, ts } of identifiers) {
      if (!dbProperty.has(key)) { counters.added++; toFetch.push(key); }
      else if (dbProperty.get(key) !== ts) { counters.updated++; toFetch.push(key); }
    }
    const toDeleteProp = [...dbProperty.keys()].filter(k => !liveKeys.has(k));
    const toDeleteGrid = [...dbGridKeys.keys()].filter(k => !liveKeys.has(k));
    console.log(`Diff: ${counters.added} new, ${counters.updated} changed, ${toDeleteProp.length} to delete`);

    // 4. Fetch full records only for new/changed, then upsert both tables
    const officeCache = new Map();
    for (let i = 0; i < toFetch.length; i += FETCH_BATCH_SIZE) {
      const batchKeys = toFetch.slice(i, i + FETCH_BATCH_SIZE);
      const records = await fetchFullRecords(batchKeys);
      counters.fetched += records.length;
      if (records.length === 0) continue;
      await fetchOfficeDetails(records.map(r => r.ListOfficeKey), officeCache);
      await upsertBatch('property', mapForProperty(records, officeCache));
      await upsertBatch('grid', mapForGrid(records, officeCache));
      process.stdout.write(`\r  Fetched+upserted ${counters.fetched}/${toFetch.length}...`);
    }
    console.log('');

    // 5. Delete keys gone from the feed (exact — no full-scan guessing)
    if (toDeleteProp.length) counters.deleted += await deleteKeys('property', toDeleteProp);
    if (toDeleteGrid.length) await deleteKeys('grid', toDeleteGrid);

    const mins = ((Date.now() - t0) / 60000).toFixed(1);
    console.log('\n✅ Replication sync complete');
    console.log(`  New: ${counters.added}, Changed: ${counters.updated}, Deleted: ${counters.deleted}`);
    console.log(`  Full records fetched: ${counters.fetched} (vs ${identifiers.length} identifiers)`);
    console.log(`  Took ${mins} min`);
    process.exit(0);
  } catch (e) {
    console.error('Fatal error:', e.message);
    process.exit(1);
  }
}

main();
