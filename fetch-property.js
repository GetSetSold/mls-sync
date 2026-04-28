import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ✅ URL hardcoded like original working file — env var caused silent {} errors
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = process.env.DDF_CLIENT_ID || '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET || '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

const BATCH_SIZE = 500;      // ✅ up from 100 — fewer DB round trips
const BATCH_DELAY_MS = 300;  // ✅ pause between batches to reduce Disk IO spikes
const OFFICE_CACHE = {};     // ✅ cache office names — avoids duplicate API calls

// =====================
// Live progress
// =====================
function showProgress(counters) {
  process.stdout.write(`\rAdded: ${counters.added} | Updated: ${counters.updated} | Deleted: ${counters.deleted}`);
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
// Only calls API for keys not yet seen — avoids repeat calls across batches
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)].filter(k => !OFFICE_CACHE[k]);

  if (uniqueKeys.length > 0) {
    await Promise.all(uniqueKeys.map(async key => {
      try {
        const response = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await response.json();
        OFFICE_CACHE[key] = (data.value && data.value[0]?.OfficeName) || 'Unknown';
      } catch (error) {
        console.error(`Error fetching office ${key}:`, error.message);
        OFFICE_CACHE[key] = 'Unknown';
      }
    }));
  }

  const officeDetails = {};
  officeKeys.forEach(key => {
    officeDetails[key] = OFFICE_CACHE[key] || 'Unknown';
  });
  return officeDetails;
}

// =====================
// Map properties — unchanged from working version
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
// Save properties — same working upsert pattern, larger batches + delay
// =====================
async function savePropertiesToSupabase(properties, counters) {
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);

    const keys = batch.map(p => p.ListingKey);
    const { data: existingData } = await supabase
      .from('property')
      .select('ListingKey')
      .in('ListingKey', keys);

    const existingKeys = new Set(existingData?.map(p => p.ListingKey) || []);
    batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

    // ✅ Exact same working upsert pattern as original
    const { error } = await supabase
      .from('property')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (error) console.error('\nError saving batch:', error.message);

    showProgress(counters);

    // ✅ Pause between batches to spread Disk IO load
    if (i + BATCH_SIZE < properties.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
}

// =====================
// Delete non-matching properties
// ✅ Paginated fetch — fixes statement timeout on 54K+ rows
// ✅ Safety guards — prevents accidental mass deletion
// =====================
async function deleteNonMatchingProperties(allFetchedKeys, counters) {
  // ✅ Safety guard — if DDF fetch was incomplete, skip deletion
  if (allFetchedKeys.length < 50000) {
    console.log(`\n⚠️ Only ${allFetchedKeys.length} keys fetched — skipping deletion as safety measure`);
    return;
  }

  console.log('\nFetching existing keys for deletion check (paginated)...');

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
      // ✅ Abort deletion on any read error — never delete on uncertainty
      console.error('\n⚠️ Error fetching keys for deletion — skipping to be safe:', error.message);
      return;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    data.forEach(r => {
      if (!latestSet.has(r.ListingKey)) toDelete.push(r.ListingKey);
    });

    from += pageSize;
    hasMore = data.length === pageSize;
    process.stdout.write(`\rScanned ${from} existing records...`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo properties to delete.');
    return;
  }

  // ✅ Safety guard — never delete more than 10% in one run
  const deletePercent = (toDelete.length / allFetchedKeys.length) * 100;
  if (deletePercent > 10) {
    console.log(`\n⚠️ ${toDelete.length} deletions (${deletePercent.toFixed(1)}%) seems too high — skipping`);
    console.log('If expected (e.g. board change), remove this guard temporarily and re-run.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired properties...`);

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
      console.error('\nDelete error — stopping deletion:', error.message);
      return; // ✅ stop on first error
    }

    deletedCount += data.length;
    await new Promise(r => setTimeout(r, 200));
  }

  counters.deleted = deletedCount;
  console.log(`\n✅ Deleted ${deletedCount} expired properties`);
  showProgress(counters);
}

// =====================
// Fetch & process DDF
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { added: 0, updated: 0, deleted: 0 };
  const token = await getAccessToken();
  let nextLink = `${PROPERTY_URL}?$top=100`;
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();

      if (!data.value) {
        console.error('❌ DDF returned unexpected response:', JSON.stringify(data, null, 2));
        throw new Error('Missing value array in DDF response');
      }

      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);
      const mappedProperties = mapProperties(data.value, officeDetails);

      await savePropertiesToSupabase(mappedProperties, counters);
      allFetchedKeys.push(...mappedProperties.map(p => p.ListingKey));
      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nError fetching properties:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (allFetchedKeys.length > 0) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log('\n✅ DDF property sync complete');
  console.log(`Final counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// =====================
// Main
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
