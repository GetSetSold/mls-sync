import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ✅ URL hardcoded — env var caused silent {} errors
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = process.env.DDF_CLIENT_ID || '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET || '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

const BATCH_SIZE = 500;
const OFFICE_CACHE = {};

// =====================
// Detect sync mode
// Full sync runs once daily at 2am UTC — fetches all 56K, handles deletions
// Delta sync runs every other 4hr slot — only fetches changed records (~200-800)
// =====================
function getSyncMode() {
  const utcHour = new Date().getUTCHours();
  const isFullSync = utcHour === 2; // 2am UTC = ~10pm ET
  return isFullSync ? 'full' : 'delta';
}

function buildStartUrl(mode) {
  if (mode === 'full') {
    console.log('🔄 MODE: Full sync — fetching all listings (deletions will be checked)');
    return `${PROPERTY_URL}?$top=100`;
  }

  // Delta: go back 4.5 hours — 30 min overlap ensures no records are missed
  const since = new Date(Date.now() - 4.5 * 60 * 60 * 1000).toISOString();
  console.log(`⚡ MODE: Delta sync — fetching records modified since ${since}`);
  return `${PROPERTY_URL}?$filter=ModificationTimestamp gt ${since}&$top=100`;
}

// =====================
// Live progress
// =====================
function showProgress(counters) {
  process.stdout.write(`\rFetched: ${counters.fetched} | Saved: ${counters.saved} | Deleted: ${counters.deleted}`);
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
// Fetch office details with cache
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uncached = [...new Set(officeKeys)].filter(k => !OFFICE_CACHE[k]);

  if (uncached.length > 0) {
    await Promise.all(uncached.map(async key => {
      try {
        const response = await fetch(
          `${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await response.json();
        OFFICE_CACHE[key] = data.value?.[0]?.OfficeName || 'Unknown';
      } catch {
        OFFICE_CACHE[key] = 'Unknown';
      }
    }));
  }

  const result = {};
  officeKeys.forEach(k => { result[k] = OFFICE_CACHE[k] || 'Unknown'; });
  return result;
}

// =====================
// Map properties
// =====================
function mapProperties(properties, officeDetails) {
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
// Save to Supabase
// No pre-check SELECT — upsert handles insert vs update internally
// =====================
async function savePropertiesToSupabase(properties, counters) {
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('property')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (error) console.error('\nError saving batch:', error.message);
    else counters.saved += batch.length;

    showProgress(counters);
  }
}

// =====================
// Delete expired listings — only runs on full sync
// Paginated to avoid statement timeout on 56K rows
// =====================
async function deleteNonMatchingProperties(allFetchedKeys, counters) {
  if (allFetchedKeys.length === 0) {
    console.log('\n⚠️ No keys from DDF — skipping deletion');
    return;
  }

  console.log(`\nChecking for expired listings (${allFetchedKeys.length} DDF keys)...`);

  const latestSet = new Set(allFetchedKeys);
  const toDelete = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('property')
      .select('ListingKey')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('\n⚠️ Error scanning for deletions — skipping:', error.message);
      return;
    }

    if (!data || data.length === 0) { hasMore = false; break; }

    data.forEach(r => {
      if (!latestSet.has(r.ListingKey)) toDelete.push(r.ListingKey);
    });

    from += pageSize;
    hasMore = data.length === pageSize;
    process.stdout.write(`\rScanning for deletions... ${from} checked`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo expired listings found.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired listings...`);

  const chunkSize = 500;
  let deletedCount = 0;

  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('property')
      .delete()
      .in('ListingKey', chunk)
      .select('ListingKey');

    if (error) {
      console.error('\nDelete error:', error.message);
      return;
    }

    deletedCount += data.length;
    await new Promise(r => setTimeout(r, 200));
  }

  counters.deleted = deletedCount;
  console.log(`\n✅ Deleted ${deletedCount} expired listings`);
  showProgress(counters);
}

// =====================
// Main fetch and sync
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { fetched: 0, saved: 0, deleted: 0 };
  const mode = getSyncMode();
  const token = await getAccessToken();

  let nextLink = buildStartUrl(mode);
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      const response = await fetch(nextLink, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (!data.value) {
        console.error('❌ Unexpected DDF response:', JSON.stringify(data, null, 2));
        throw new Error('Missing value array in DDF response');
      }

      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);
      const mapped = mapProperties(data.value, officeDetails);

      counters.fetched += mapped.length;
      allFetchedKeys.push(...mapped.map(p => p.ListingKey));

      await savePropertiesToSupabase(mapped, counters);

      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nFetch error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // ✅ Only check deletions on full sync — delta won't have all keys
  if (mode === 'full' && allFetchedKeys.length > 0) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log('\n✅ Property sync complete');
  console.log(`Mode: ${mode.toUpperCase()} | Fetched: ${counters.fetched} | Saved: ${counters.saved} | Deleted: ${counters.deleted}`);
}

// =====================
// Entry point
// =====================
(async function main() {
  try {
    console.log('Starting DDF property sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
