// sync-ddf.js — Combined incremental DDF sync for both property & grid
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

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

// Sync state table — tracks last successful sync timestamp
const SYNC_STATE_TABLE = 'sync_state';

// =====================
// Helpers
// =====================
function showProgress(counters) {
  process.stdout.write(
    `\r  Property: +${counters.property.added} ~${counters.property.updated} | ` +
    `Grid: +${counters.grid.added} ~${counters.grid.updated} | ` +
    `Deleted: ${counters.deleted}`
  );
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
// Get last sync timestamp
// =====================
async function getLastSyncTime() {
  const { data, error } = await supabase
    .from(SYNC_STATE_TABLE)
    .select('last_sync')
    .eq('id', 1)
    .single();

  if (error || !data?.last_sync) {
    console.log('No previous sync found — running full sync this time.');
    return null; // null = full sync
  }
  console.log(`Last sync: ${data.last_sync} — running incremental sync.`);
  return data.last_sync;
}

// =====================
// Save last sync timestamp
// =====================
async function saveLastSyncTime() {
  const now = new Date().toISOString();
  await supabase
    .from(SYNC_STATE_TABLE)
    .upsert({ id: 1, last_sync: now }, { onConflict: ['id'] });
  console.log(`\nSync state saved: ${now}`);
}

// =====================
// Fetch office details (batched — one call per unique office)
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)].filter(Boolean);
  if (uniqueKeys.length === 0) return {};

  const officeDetails = {};

  // DDF supports $filter with 'or' — batch offices to reduce API calls
  const batchSize = 20;
  for (let i = 0; i < uniqueKeys.length; i += batchSize) {
    const chunk = uniqueKeys.slice(i, i + batchSize);
    const filter = chunk.map(k => `OfficeKey eq '${k.trim()}'`).join(' or ');

    try {
      const response = await fetch(`${OFFICE_URL}?$filter=${encodeURIComponent(filter)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.value) {
        data.value.forEach(o => { officeDetails[o.OfficeKey] = o.OfficeName || 'Unknown'; });
      }
    } catch (error) {
      console.error(`Error fetching office batch at ${i}:`, error.message);
      chunk.forEach(k => { officeDetails[k] = 'Unknown'; });
    }
  }

  return officeDetails;
}

// =====================
// Map for property table (full data)
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
// Map for grid table (lightweight — first photo only)
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
// Upsert batch — no existence check, just direct upsert
// =====================
async function upsertBatch(table, batch) {
  const { error } = await supabase.from(table).upsert(batch, { onConflict: ['ListingKey'] });
  if (error) {
    console.error(`\nError upserting to ${table}:`, error.message);
    return false;
  }
  return true;
}

// =====================
// Process a page of DDF results
// =====================
async function processPage(properties, token, counters) {
  if (properties.length === 0) return;

  // Office details (only for property table)
  const officeKeys = properties.map(p => p.ListOfficeKey).filter(Boolean);
  const officeDetails = await fetchOfficeDetails(token, officeKeys);

  // Map for both tables
  const propertyRows = mapForProperty(properties, officeDetails);
  const gridRows = mapForGrid(properties);

  // Upsert in larger batches (500 instead of 100)
  const batchSize = 500;

  for (let i = 0; i < propertyRows.length; i += batchSize) {
    const propBatch = propertyRows.slice(i, i + batchSize);
    const gridBatch = gridRows.slice(i, i + batchSize);

    // Count new vs updated (by checking ModificationTimestamp against sync_state)
    // New property = no existing record — we'll count after first full sync
    // For simplicity: approximate — all inserts in incremental sync are updates
    const propCount = propBatch.length;
    counters.property.updated += propCount;

    await upsertBatch('property', propBatch);
    counters.grid.updated += Math.min(gridBatch.length, propCount);
    await upsertBatch('grid', gridBatch);

    showProgress(counters);
  }
}

// =====================
// Full deletion check (only run during daily full sync at 9 AM)
// =====================
async function runFullDeletionCheck(allFetchedKeys, counters) {
  console.log('\n  Running full deletion check...');

  for (const table of ['property', 'grid']) {
    try {
      const { data: existingKeys, error } = await supabase
        .from(table)
        .select('ListingKey');

      if (error) {
        console.error(`Error fetching ${table} keys:`, error.message);
        continue;
      }

      const existingSet = new Set(existingKeys.map(r => r.ListingKey));
      const latestSet = new Set(allFetchedKeys);
      const toDelete = [...existingSet].filter(key => !latestSet.has(key));

      if (toDelete.length === 0) {
        console.log(`  ${table}: nothing to delete.`);
        continue;
      }

      const chunkSize = 500;
      let deleted = 0;
      for (let i = 0; i < toDelete.length; i += chunkSize) {
        const chunk = toDelete.slice(i, i + chunkSize);
        const { data, error } = await supabase
          .from(table)
          .delete()
          .in('ListingKey', chunk)
          .select('ListingKey');

        if (error) console.error(`  ${table} delete error:`, error.message);
        else deleted += data?.length || 0;
      }
      counters.deleted += deleted;
      console.log(`  ${table}: deleted ${deleted} removed listings.`);
    } catch (err) {
      console.error(`Fatal ${table} deletion error:`, err.message);
    }
  }
}

// =====================
// Main sync
// =====================
async function main() {
  try {
    const counters = { property: { added: 0, updated: 0 }, grid: { added: 0, updated: 0 }, deleted: 0 };
    const isFullSync = process.env.FULL_SYNC === 'true';
    const token = await getAccessToken();

    // Get last sync time for incremental filter
    const lastSync = await getLastSyncTime();

    // Build DDF URL — use ModificationTimestamp filter for incremental sync
    let ddfUrl;
    if (lastSync && !isFullSync) {
      // Incremental: only fetch properties modified since last sync
      // Add 1-minute buffer to avoid edge cases
      const filterTime = new Date(new Date(lastSync).getTime() - 60000).toISOString();
      ddfUrl = `${PROPERTY_URL}?$top=500&$filter=ModificationTimestamp gt '${filterTime}'&$orderby=ModificationTimestamp`;
    } else {
      // Full sync: fetch everything
      ddfUrl = `${PROPERTY_URL}?$top=500&$orderby=ModificationTimestamp`;
    }

    console.log(`\nStarting ${isFullSync ? 'FULL' : 'incremental'} DDF sync...`);
    console.log(`URL: ${ddfUrl}\n`);

    let nextLink = ddfUrl;
    const allFetchedKeys = [];
    let pageCount = 0;

    while (nextLink) {
      try {
        pageCount++;
        console.log(`  Page ${pageCount}: ${nextLink.substring(0, 120)}...`);

        const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json();

        if (!data.value) {
          console.error('DDF returned unexpected response:', JSON.stringify(data).substring(0, 300));
          break;
        }

        await processPage(data.value, token, counters);
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

    // Save sync timestamp (always — so incremental works next time)
    await saveLastSyncTime();

    // Final summary
    console.log('\n✅ Sync complete!');
    console.log(`  Property: ${counters.property.updated} upserted`);
    console.log(`  Grid: ${counters.grid.updated} upserted`);
    console.log(`  Deleted: ${counters.deleted}`);
    console.log(`  Total pages fetched: ${pageCount}`);

    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
}

main();
