// ddf-sync.js — Combined incremental DDF sync with dead-row prevention
// OPTIMIZED: Pre-loads all hashes once per run (reduces ~7,900 DB queries/day → ~14)
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import crypto from 'crypto';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

// CREA DDF API
const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

const SYNC_STATE_TABLE = 'sync_state';

// For full sync: fetch all 56k listings per page (max allowed by CREA DDF)
const DDF_PAGE_SIZE = 100; // CREA DDF hard cap
// Hash-check SELECT batch size when NOT using pre-loaded map (incremental fallback)
const HASH_FETCH_BATCH = 1000;
// Upsert write batch size
const UPSERT_BATCH_SIZE = 500;

// =====================
// Helpers
// =====================
function showProgress(counters) {
  process.stdout.write(
    `\r  Prop: +${counters.property.added} ~${counters.property.unchanged} Δ${counters.property.updated} | ` +
    `Grid: Δ${counters.grid.updated} skip:${counters.grid.unchanged} | ` +
    `Del: ${counters.deleted}`
  );
}

// Hash only the data columns (not _data_hash itself)
function computeHash(row) {
  const { _data_hash, ...rest } = row;
  return crypto.createHash('md5').update(JSON.stringify(rest)).digest('hex');
}

// =====================
// Fetch DDF access token
// =====================
async function getAccessToken() {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'DDFApi_Read',
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Failed to fetch DDF token');
  return data.access_token;
}

// =====================
// Sync state management
// =====================
async function getLastSyncTime() {
  const { data, error } = await supabase
    .from(SYNC_STATE_TABLE)
    .select('last_sync')
    .eq('id', 1)
    .single();

  if (error || !data?.last_sync) {
    console.log('No previous sync found — running full sync.');
    return null;
  }
  console.log(`Last sync: ${data.last_sync} — incremental.`);
  return data.last_sync;
}

async function saveLastSyncTime() {
  const now = new Date().toISOString();
  await supabase
    .from(SYNC_STATE_TABLE)
    .upsert({ id: 1, last_sync: now }, { onConflict: ['id'] });
  console.log(`Sync timestamp saved: ${now}`);
}

// =====================
// PRE-LOAD all hashes for a table in one pass
// Replaces per-page hash SELECTs — called once before the page loop
// Cost: ~57 queries total (56k rows / 1000 per page) vs ~1,134 per sync before
// =====================
async function fetchAllHashes(table) {
  console.log(`  Pre-loading ${table} hashes...`);
  const allHashes = new Map();
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('ListingKey, _data_hash')
      .range(from, from + HASH_FETCH_BATCH - 1);

    if (error) throw new Error(`Failed to pre-load hashes for ${table}: ${error.message}`);
    if (!data || data.length === 0) break;

    data.forEach(r => allHashes.set(r.ListingKey, r._data_hash));
    process.stdout.write(`\r    ${table}: loaded ${allHashes.size} hashes...`);

    if (data.length < HASH_FETCH_BATCH) break;
    from += HASH_FETCH_BATCH;
  }

  console.log(`\n  ${table}: ${allHashes.size} hashes loaded.`);
  return allHashes;
}

// =====================
// Fetch office details (individual — DDF doesn't support batch or filters)
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)].filter(Boolean);
  if (uniqueKeys.length === 0) return {};

  const officeDetails = {};

  await Promise.all(uniqueKeys.map(async key => {
    try {
      const response = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      officeDetails[key] = (data.value && data.value[0]?.OfficeName) || 'Unknown';
    } catch (error) {
      console.error(`Error fetching office ${key}:`, error.message);
      officeDetails[key] = 'Unknown';
    }
  }));

  return officeDetails;
}

// =====================
// Map for property table
// =====================
function mapForProperty(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || 'Unknown' : 'Unknown';

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

// =====================
// Map for grid table (lightweight)
// =====================
function mapForGrid(properties) {
  return properties.map(p => {
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
      TotalActualRent: p.TotalActualRent,
      OriginalEntryTimestamp: p.OriginalEntryTimestamp,
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

// =====================
// Smart upsert — only writes rows that actually changed
// Accepts a pre-loaded hash map (full sync) or fetches per batch (incremental)
// =====================
async function smartUpsert(table, rows, counters, preloadedHashMap = null) {
  if (rows.length === 0) return;

  // 1. Compute hashes for incoming data
  const incoming = rows.map(row => ({
    ...row,
    _data_hash: computeHash(row),
  }));

  let existingMap;

  if (preloadedHashMap) {
    // FULL SYNC: use the pre-loaded map — zero extra DB queries
    existingMap = preloadedHashMap;
  } else {
    // INCREMENTAL: fetch hashes only for the keys we just pulled
    const keys = incoming.map(r => r.ListingKey);
    const { data: existing, error: fetchErr } = await supabase
      .from(table)
      .select('ListingKey, _data_hash')
      .in('ListingKey', keys);

    if (fetchErr) {
      console.error(`\nError fetching hashes for ${table}:`, fetchErr.message);
      // Fallback: upsert all
      const { error } = await supabase.from(table).upsert(incoming, { onConflict: ['ListingKey'] });
      if (error) console.error(`Fallback upsert error (${table}):`, error.message);
      counters[table].updated += incoming.length;
      return;
    }

    existingMap = new Map((existing || []).map(r => [r.ListingKey, r._data_hash]));
  }

  // 2. Split into: new inserts vs changed updates vs unchanged skips
  const toWrite = [];

  for (const row of incoming) {
    const existingHash = existingMap.get(row.ListingKey);
    if (!existingHash) {
      counters[table].added++;
      toWrite.push(row);
    } else if (existingHash !== row._data_hash) {
      counters[table].updated++;
      toWrite.push(row);
      // Update the in-memory map so subsequent pages reflect the new hash
      if (preloadedHashMap) preloadedHashMap.set(row.ListingKey, row._data_hash);
    } else {
      counters[table].unchanged++;
    }
  }

  if (toWrite.length === 0) return;

  // 3. Batch upsert only changed rows
  for (let i = 0; i < toWrite.length; i += UPSERT_BATCH_SIZE) {
    const batch = toWrite.slice(i, i + UPSERT_BATCH_SIZE);
    const { error } = await supabase.from(table).upsert(batch, { onConflict: ['ListingKey'] });
    if (error) console.error(`\nUpsert error (${table}):`, error.message);
    showProgress(counters);
  }
}

// =====================
// Full deletion check (daily only)
// =====================
async function runFullDeletionCheck(allFetchedKeys, counters) {
  console.log('\n  Running full deletion check...');
  const latestSet = new Set(allFetchedKeys);

  for (const table of ['property', 'grid']) {
    try {
      const { data: existingKeys, error } = await supabase
        .from(table)
        .select('ListingKey');

      if (error) {
        console.error(`Error fetching ${table} keys:`, error.message);
        continue;
      }

      const toDelete = (existingKeys || [])
        .map(r => r.ListingKey)
        .filter(key => !latestSet.has(key));

      if (toDelete.length === 0) {
        console.log(`  ${table}: nothing to delete.`);
        continue;
      }

      console.log(`  ${table}: deleting ${toDelete.length} removed listings...`);

      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += UPSERT_BATCH_SIZE) {
        const chunk = toDelete.slice(i, i + UPSERT_BATCH_SIZE);
        const { data, error } = await supabase
          .from(table)
          .delete()
          .in('ListingKey', chunk)
          .select('ListingKey');

        if (error) console.error(`  ${table} delete error:`, error.message);
        else deleted += data?.length || 0;
      }
      counters.deleted += deleted;
      console.log(`  ${table}: deleted ${deleted}.`);
    } catch (err) {
      console.error(`Fatal ${table} deletion error:`, err.message);
    }
  }
}

// =====================
// Main
// =====================
async function main() {
  try {
    const counters = {
      property: { added: 0, updated: 0, unchanged: 0 },
      grid: { added: 0, updated: 0, unchanged: 0 },
      deleted: 0,
    };

    const isFullSync = process.env.FULL_SYNC === 'true';
    const token = await getAccessToken();
    const lastSync = await getLastSyncTime();

    // -------------------------------------------------------
    // FULL SYNC: pre-load all hashes once before the page loop
    // This replaces ~1,134 per-page hash SELECTs with ~57 total
    // INCREMENTAL: skip pre-load — only a handful of pages expected
    // -------------------------------------------------------
    let preloadedHashes = null;
    if (isFullSync || !lastSync) {
      console.log('\nPre-loading hash maps (avoids per-page DB queries)...');
      preloadedHashes = {
        property: await fetchAllHashes('property'),
        grid: await fetchAllHashes('grid'),
      };
    }

    // Build DDF URL
    let ddfUrl;
    if (lastSync && !isFullSync) {
      const filterTime = new Date(new Date(lastSync).getTime() - 60000).toISOString();
      ddfUrl = `${PROPERTY_URL}?$top=${DDF_PAGE_SIZE}&$filter=ModificationTimestamp gt ${filterTime}&$orderby=ModificationTimestamp`;
    } else {
      ddfUrl = `${PROPERTY_URL}?$top=${DDF_PAGE_SIZE}&$orderby=ModificationTimestamp`;
    }

    console.log(`\nStarting ${isFullSync ? 'FULL' : 'incremental'} DDF sync...\n`);

    let nextLink = ddfUrl;
    const allFetchedKeys = [];
    let pageCount = 0;

    while (nextLink) {
      try {
        pageCount++;
        console.log(`  Page ${pageCount}...`);

        const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json();

        if (!data.value) {
          console.error('DDF returned unexpected response:', JSON.stringify(data).substring(0, 300));
          break;
        }

        if (data.value.length > 0) {
          const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
          const officeDetails = await fetchOfficeDetails(token, officeKeys);

          const propertyRows = mapForProperty(data.value, officeDetails);
          const gridRows = mapForGrid(data.value);

          // Pass pre-loaded hash maps (full sync) or null (incremental — queries per batch)
          await smartUpsert('property', propertyRows, counters, preloadedHashes?.property ?? null);
          await smartUpsert('grid', gridRows, counters, preloadedHashes?.grid ?? null);
        }

        allFetchedKeys.push(...data.value.map(p => p.ListingKey));
        nextLink = data['@odata.nextLink'] || null;
      } catch (error) {
        console.error(`\nError on page ${pageCount}:`, error.message);
        console.log('  Retrying in 5 seconds...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // Full deletion check — only during daily full sync
    if (isFullSync && allFetchedKeys.length > 0) {
      await runFullDeletionCheck(allFetchedKeys, counters);
    }

    await saveLastSyncTime();

    console.log('\n✅ Sync complete!');
    console.log(`  Property: ${counters.property.added} new, ${counters.property.updated} changed, ${counters.property.unchanged} unchanged (skipped)`);
    console.log(`  Grid:     ${counters.grid.added} new, ${counters.grid.updated} changed, ${counters.grid.unchanged} unchanged (skipped)`);
    console.log(`  Deleted:  ${counters.deleted}`);
    console.log(`  Pages:    ${pageCount}`);

    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
