// ddf-sync.js — Combined incremental DDF sync with dead-row prevention
// OPTIMIZED: Pre-loads all hashes once per run (reduces ~7,900 DB queries/day → ~14)
// OPTIMIZED (2): Office details are now cached once per run — previously re-fetched per page
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import crypto from 'crypto';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

// CREA DDF API — credentials come from env (GitHub secrets), never hardcoded.
// The old hardcoded values are in git history of this public repo: rotate them with CREA.
const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) throw new Error('Missing DDF_CLIENT_ID / DDF_CLIENT_SECRET environment variables');
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

const SYNC_STATE_TABLE = 'sync_state';

const DDF_PAGE_SIZE = 100; // CREA DDF hard cap per page
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
// Fetch ALL ListingKeys for a table, paginated.
// A bare .select() is capped by PostgREST (default 1,000 rows) while these tables hold
// ~56k — without pagination the deletion check silently misses stale rows past the cap.
// =====================
async function fetchAllKeys(table) {
  const keys = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('ListingKey')
      .range(from, from + HASH_FETCH_BATCH - 1);
    if (error) {
      console.error(`Error fetching ${table} keys:`, error.message);
      return null;
    }
    if (!data || data.length === 0) break;
    for (const r of data) keys.push(r.ListingKey);
    if (data.length < HASH_FETCH_BATCH) break;
    from += HASH_FETCH_BATCH;
  }
  return keys;
}

// =====================
// Fetch office details (individual — DDF doesn't support batch or filters)
// Now backed by a cache that's shared across the whole run (passed in from main()),
// so each distinct office is looked up at most once per sync instead of once per page.
// =====================
async function fetchOfficeDetails(token, officeKeys, cache) {
  const uniqueKeys = [...new Set(officeKeys)].filter(Boolean).filter(key => !cache.has(key));

  // One retry before caching 'Unknown': a transient Office API blip would otherwise flip
  // OfficeName for every one of that office's listings, churning their change-hashes and
  // causing a mass rewrite on an otherwise quiet run.
  async function lookupOffice(key) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        return (data.value && data.value[0]?.OfficeName) || 'Unknown';
      } catch (error) {
        if (attempt === 2) {
          console.error(`Error fetching office ${key}:`, error.message);
          return 'Unknown';
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  // Bound concurrency: early full-sync pages can hold hundreds of distinct offices.
  const OFFICE_CONCURRENCY = 10;
  for (let i = 0; i < uniqueKeys.length; i += OFFICE_CONCURRENCY) {
    const chunk = uniqueKeys.slice(i, i + OFFICE_CONCURRENCY);
    const names = await Promise.all(chunk.map(lookupOffice));
    chunk.forEach((k, idx) => cache.set(k, names[idx]));
  }

  return cache;
}

// =====================
// Map for property table
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

// =====================
// Map for grid table (lightweight)
// =====================
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
// NOTE: run the migration below once before deploying this version —
//   alter table grid add column if not exists "ListOfficeKey" text,
//                     add column if not exists "OfficeName" text;
// Old rows will have these as null until their next sync (hash will differ, so
// they'll pick up the new columns on the very next run automatically).

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
      const existingKeys = await fetchAllKeys(table);
      if (!existingKeys) continue; // error already logged above

      const toDelete = existingKeys
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
    let token = await getAccessToken();
    let tokenFetchedAt = Date.now();
    const lastSync = await getLastSyncTime();

    // Shared office-name cache for the whole run — populated as new offices are seen,
    // reused across every page so each office is looked up at most once per sync.
    const officeCache = new Map();

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
    let syncIncomplete = false; // set true if any page fails to load cleanly
    const MAX_RETRIES_PER_PAGE = 5;

    while (nextLink) {
      let retries = 0;
      let pageSucceeded = false;

      while (!pageSucceeded) {
        try {
          pageCount++;
          console.log(`  Page ${pageCount}...`);

          // Full syncs can run long — refresh the DDF token before it expires (~1h)
          // so later pages don't start 401ing and mark the run incomplete.
          if (Date.now() - tokenFetchedAt > 50 * 60 * 1000) {
            console.log('  Refreshing DDF access token...');
            token = await getAccessToken();
            tokenFetchedAt = Date.now();
          }

          const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
          const data = await response.json();

          if (!data.value) {
            // Log the FULL body (not just 300 chars) so rate-limit/auth errors are diagnosable
            console.error('DDF returned unexpected response:', JSON.stringify(data));
            syncIncomplete = true;
            nextLink = null; // stop paginating — we cannot trust anything past this point
            pageSucceeded = true; // exit inner retry loop, outer while(nextLink) will end too
            break;
          }

          if (data.value.length > 0) {
            const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
            const officeDetails = await fetchOfficeDetails(token, officeKeys, officeCache);

            const propertyRows = mapForProperty(data.value, officeDetails);
            const gridRows = mapForGrid(data.value, officeDetails);

            // Pass pre-loaded hash maps (full sync) or null (incremental — queries per batch)
            await smartUpsert('property', propertyRows, counters, preloadedHashes?.property ?? null);
            await smartUpsert('grid', gridRows, counters, preloadedHashes?.grid ?? null);
          }

          allFetchedKeys.push(...data.value.map(p => p.ListingKey));
          nextLink = data['@odata.nextLink'] || null;
          pageSucceeded = true;
        } catch (error) {
          retries++;
          console.error(`\nError on page ${pageCount} (attempt ${retries}/${MAX_RETRIES_PER_PAGE}):`, error.message);
          if (retries >= MAX_RETRIES_PER_PAGE) {
            console.error(`  Giving up on page ${pageCount} after ${MAX_RETRIES_PER_PAGE} attempts — marking sync incomplete.`);
            syncIncomplete = true;
            nextLink = null;
            pageSucceeded = true; // stop retrying this page
            break;
          }
          console.log('  Retrying in 5 seconds...');
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
    }

    // Full deletion check — only during daily full sync, and ONLY if every page of the
    // DDF feed was fetched successfully. Deleting based on a partial fetch would wipe out
    // real, still-active listings that simply weren't reached before a transient failure.
    if (isFullSync && !syncIncomplete && allFetchedKeys.length > 0) {
      await runFullDeletionCheck(allFetchedKeys, counters);
    } else if (isFullSync && syncIncomplete) {
      console.warn('\n⚠️  Skipping deletion check — this sync did not complete cleanly (see errors above). ' +
        'No listings were deleted this run to avoid removing valid data based on a partial fetch.');
    }

    // Only advance the checkpoint on a clean run. Saving it after a partial run would make
    // the next incremental sync skip listings modified in the failed window (until the next
    // full sync) — instead the next run re-scans from the previous good checkpoint.
    if (!syncIncomplete) {
      await saveLastSyncTime();
    } else {
      console.warn('\n⚠️  Not updating last_sync — this run did not complete cleanly. ' +
        'The next incremental sync will re-scan from the previous checkpoint.');
    }

    console.log('\n✅ Sync complete!');
    console.log(`  Property: ${counters.property.added} new, ${counters.property.updated} changed, ${counters.property.unchanged} unchanged (skipped)`);
    console.log(`  Grid:     ${counters.grid.added} new, ${counters.grid.updated} changed, ${counters.grid.unchanged} unchanged (skipped)`);
    console.log(`  Deleted:  ${counters.deleted}`);
    console.log(`  Office lookups cached: ${officeCache.size}`);
    console.log(`  Pages:    ${pageCount}`);

    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
