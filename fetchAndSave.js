import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

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
// Fetch office details
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
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
// Map properties for Supabase
// =====================
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || 'Unknown' : 'Unknown';

    return {
      ListingKey: property.ListingKey, // ✅ primary key
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

      // ✅ Flattened Address fields
      UnparsedAddress: property.Address?.UnparsedAddress || property.UnparsedAddress || null,
      City: property.Address?.City || property.City || 'Unknown',
      UnitNumber: property.Address?.UnitNumber || property.UnitNumber || null,
      PostalCode: property.Address?.PostalCode || property.PostalCode || null,
      SubdivisionName: property.SubdivisionName,
      Directions: property.Directions,
      Latitude: property.Latitude,
      Longitude: property.Longitude,
      CityRegion: property.CityRegion,

      // ✅ Property details
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
// Save properties with counters
// =====================
async function savePropertiesToSupabase(properties, counters) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);

    // Check existing
    const keys = batch.map(p => p.ListingKey);
    const { data: existingData } = await supabase
      .from('property')
      .select('ListingKey')
      .in('ListingKey', keys);

    const existingKeys = new Set(existingData?.map(p => p.ListingKey) || []);
    batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

    // ✅ upsert on ListingKey (primary key)
    const { error } = await supabase.from('property').upsert(batch, {
      onConflict: ['ListingKey'],
    });
    if (error) console.error('Error saving batch:', error.message);

    showProgress(counters);
  }
}


// =====================
// Delete non-matching (fixed with chunking)
// =====================
async function deleteNonMatchingProperties(listingKeys, counters) {
  try {
    // 1. Fetch existing keys from Supabase
    const { data: existingKeys, error: fetchError } = await supabase
      .from('property')
      .select('ListingKey');

    if (fetchError) {
      console.error('Error fetching existing keys for deletion:', fetchError.message);
      return;
    }

    const existingSet = new Set(existingKeys.map(r => r.ListingKey));
    const latestSet = new Set(listingKeys);

    // 2. Find which keys need deletion
    const toDelete = [...existingSet].filter(key => !latestSet.has(key));

    if (toDelete.length === 0) {
      console.log('No properties to delete.');
      return;
    }

    console.log(`Preparing to delete ${toDelete.length} old properties...`);

    // 3. Delete in chunks (avoid Postgres parameter limit ~65k)
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
        console.error(`Error deleting chunk at ${i}:`, error.message);
      } else {
        deletedCount += data.length;
        console.log(`Deleted ${data.length} records (chunk ${i / chunkSize + 1})`);
      }
    }

    counters.deleted = deletedCount;
    console.log(`\n✅ Deleted total: ${deletedCount} properties not in latest fetch`);

    showProgress(counters);
  } catch (err) {
    console.error('Fatal deletion error:', err.message);
  }
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
      console.log(`\nFetching properties: ${nextLink}`);
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
      console.error('Error fetching properties:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (allFetchedKeys.length > 0) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log('\n✅ DDF incremental sync complete');
  console.log(`Final counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// =====================
// Main
// =====================
(async function main() {
  try {
    console.log('Starting incremental DDF property sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
