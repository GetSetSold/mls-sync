import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

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

const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 300;
const OFFICE_CACHE = {};

function showProgress(counters) {
  process.stdout.write(
    `\rFetched: ${counters.fetched} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`
  );
}

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
    OFFICE_CACHE[officeKey] = name;
    return name;
  } catch {
    return 'Unknown';
  }
}

function mapProperty(property, officeName) {
  return {
    ListingKey: property.ListingKey,
    ListOfficeKey: property.ListOfficeKey || null,
    OfficeName: officeName,
    // Normalize timestamp — strip timezone variance for consistent comparison
    ModificationTimestamp: property.ModificationTimestamp
      ? new Date(property.ModificationTimestamp).toISOString()
      : null,
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
// Delta check with better error logging
// =====================
async function filterChanged(batch) {
  const keys = batch.map(p => p.ListingKey);

  const { data: existing, error } = await supabase
    .from('property')
    .select('ListingKey, ModificationTimestamp')
    .in('ListingKey', keys);

  if (error) {
    // Log full error and fall back to upserting entire batch
    console.error('\nDelta check error (upserting full batch as fallback):', JSON.stringify(error));
    return batch;
  }

  const existingMap = new Map(
    (existing || []).map(r => [
      r.ListingKey,
      // Normalize stored timestamp too
      r.ModificationTimestamp ? new Date(r.ModificationTimestamp).toISOString() : null
    ])
  );

  const changed = batch.filter(p => {
    const storedTs = existingMap.get(p.ListingKey);
    return !storedTs || p.ModificationTimestamp !== storedTs;
  });

  return changed;
}

// =====================
// Upsert with full error logging
// =====================
async function saveBatch(batch, counters) {
  const { error } = await supabase
    .from('property')
    .upsert(batch, { onConflict: 'ListingKey' });

  if (error) {
    // Log the full error object — not just .message
    console.error('\nUpsert error:', JSON.stringify(error));
  } else {
    counters.upserted += batch.length;
  }
}

// =====================
// Delete in pages to avoid statement timeout
// Pulls existing keys in chunks instead of all at once
// =====================
async function deleteRemovedListings(allFetchedKeys, counters) {
  console.log('\nFetching existing keys for deletion check (paginated)...');

  const latestSet = new Set(allFetchedKeys);
  const toDelete = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  // Paginate through all existing keys — avoids timeout from single large query
  while (hasMore) {
    const { data, error } = await supabase
      .from('property')
      .select('ListingKey')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('\nError fetching keys for deletion:', JSON.stringify(error));
      break;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    // Collect keys not in latest DDF fetch
    data.forEach(r => {
      if (!latestSet.has(r.ListingKey)) toDelete.push(r.ListingKey);
    });

    from += pageSize;
    hasMore = data.length === pageSize;
    process.stdout.write(`\rScanned ${from} existing records for deletion...`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo listings to delete.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired listings...`);

  const chunkSize = 500;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('property')
      .delete()
      .in('ListingKey', chunk);

    if (error) {
      console.error(`\nDelete error at chunk ${i}:`, JSON.stringify(error));
    } else {
      counters.deleted += chunk.length;
    }

    await new Promise(r => setTimeout(r, 200));
    showProgress(counters);
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
        console.error('\nUnexpected DDF response:', JSON.stringify(data));
        break;
      }

      const mappedBatch = await Promise.all(
        data.value.map(async p => {
          const officeName = await getOfficeName(token, p.ListOfficeKey);
          return mapProperty(p, officeName);
        })
      );

      counters.fetched += mappedBatch.length;
      allFetchedKeys.push(...mappedBatch.map(p => p.ListingKey));

      const changed = await filterChanged(mappedBatch);
      counters.skipped += mappedBatch.length - changed.length;

      for (let i = 0; i < changed.length; i += BATCH_SIZE) {
        const chunk = changed.slice(i, i + BATCH_SIZE);
        await saveBatch(chunk, counters);
        if (i + BATCH_SIZE < changed.length) {
          await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      showProgress(counters);
      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nFetch error:', error.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  await deleteRemovedListings(allFetchedKeys, counters);

  console.log('\n\n✅ Sync complete');
  console.log(`Fetched: ${counters.fetched} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`);
}

(async function main() {
  try {
    console.log('Starting DDF property sync...');
    await fetchAndProcessDDFProperties();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
