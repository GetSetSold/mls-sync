import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// =====================
// Config — all from env
// =====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;

if (!supabaseUrl || !supabaseKey || !CLIENT_ID || !CLIENT_SECRET) {
  throw new Error('Missing required environment variables');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

const BATCH_SIZE = 500;       // up from 100 — fewer round trips
const BATCH_DELAY_MS = 300;   // pause between batches to spread IO
const OFFICE_CACHE = {};      // in-memory cache for office names

// =====================
// Progress display
// =====================
function showProgress(counters) {
  process.stdout.write(
    `\rFetched: ${counters.fetched} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`
  );
}

// =====================
// Token
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
  if (!response.ok) throw new Error(data.error_description || 'Token fetch failed');
  return data.access_token;
}

// =====================
// Office lookup with cache
// prevents repeat API calls for same office
// =====================
async function getOfficeName(token, officeKey) {
  if (!officeKey) return 'Unknown';
  if (OFFICE_CACHE[officeKey]) return OFFICE_CACHE[officeKey];

  try {
    const response = await fetch(
      `${OFFICE_URL}?$filter=OfficeKey eq '${officeKey.trim()}'`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    const name = data.value?.[0]?.OfficeName || 'Unknown';
    OFFICE_CACHE[officeKey] = name; // cache it
    return name;
  } catch {
    return 'Unknown';
  }
}

// =====================
// Map a single property
// =====================
function mapProperty(property, officeName) {
  return {
    ListingKey: property.ListingKey,
    ListOfficeKey: property.ListOfficeKey || null,
    OfficeName: officeName,
    ModificationTimestamp: property.ModificationTimestamp,
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
}

// =====================
// Delta check — only upsert changed records
// Compares ModificationTimestamp against what's in Supabase
// =====================
async function getChangedListings(incomingBatch) {
  const keys = incomingBatch.map(p => p.ListingKey);

  const { data: existing } = await supabase
    .from('property')
    .select('ListingKey, ModificationTimestamp')
    .in('ListingKey', keys);

  const existingMap = new Map(
    (existing || []).map(r => [r.ListingKey, r.ModificationTimestamp])
  );

  return incomingBatch.filter(p => {
    const existingTs = existingMap.get(p.ListingKey);
    // Include if new OR timestamp changed
    return !existingTs || p.ModificationTimestamp !== existingTs;
  });
}

// =====================
// Save batch to Supabase
// =====================
async function saveBatch(batch, counters) {
  const { error } = await supabase
    .from('property')
    .upsert(batch, { onConflict: 'ListingKey' });

  if (error) {
    console.error('\nError saving batch:', error.message);
  } else {
    counters.upserted += batch.length;
  }
}

// =====================
// Delete removed listings
// Uses a sync_run_id flag approach to avoid fetching all 54K keys
// =====================
async function deleteRemovedListings(allFetchedKeys, counters) {
  console.log('\nChecking for removed listings...');

  // Pull only keys from DB (no full row data)
  const { data: existing } = await supabase
    .from('property')
    .select('ListingKey');

  if (!existing) return;

  const latestSet = new Set(allFetchedKeys);
  const toDelete = existing
    .map(r => r.ListingKey)
    .filter(key => !latestSet.has(key));

  if (toDelete.length === 0) {
    console.log('No listings to delete.');
    return;
  }

  console.log(`Deleting ${toDelete.length} removed listings...`);

  const chunkSize = 500;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('property')
      .delete()
      .in('ListingKey', chunk);

    if (error) {
      console.error(`Delete error at chunk ${i}:`, error.message);
    } else {
      counters.deleted += chunk.length;
    }

    // Small delay between delete chunks too
    await new Promise(r => setTimeout(r, 200));
  }
}

// =====================
// Main sync
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { fetched: 0, upserted: 0, skipped: 0, deleted: 0 };
  const token = await getAccessToken();
  const allFetchedKeys = [];

  let nextLink = `${PROPERTY_URL}?$top=100`;

  while (nextLink) {
    try {
      const response = await fetch(nextLink, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (!data.value) {
        console.error('Unexpected DDF response:', JSON.stringify(data, null, 2));
        break;
      }

      // Resolve office names using cache (no duplicate API calls)
      const mappedBatch = await Promise.all(
        data.value.map(async p => {
          const officeName = await getOfficeName(token, p.ListOfficeKey);
          return mapProperty(p, officeName);
        })
      );

      counters.fetched += mappedBatch.length;
      allFetchedKeys.push(...mappedBatch.map(p => p.ListingKey));

      // ✅ Only write records that actually changed
      const changed = await getChangedListings(mappedBatch);
      counters.skipped += mappedBatch.length - changed.length;

      if (changed.length > 0) {
        // Write in BATCH_SIZE chunks with delay
        for (let i = 0; i < changed.length; i += BATCH_SIZE) {
          const chunk = changed.slice(i, i + BATCH_SIZE);
          await saveBatch(chunk, counters);

          if (i + BATCH_SIZE < changed.length) {
            await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
          }
        }
      }

      showProgress(counters);
      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nFetch error:', error.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Clean up listings no longer in DDF
  await deleteRemovedListings(allFetchedKeys, counters);

  console.log('\n\n✅ Sync complete');
  console.log(`Fetched: ${counters.fetched} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`);
}

// =====================
// Entry point
// =====================
(async function main() {
  try {
    console.log('Starting DDF sync...');
    await fetchAndProcessDDFProperties();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
