import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// =====================
// Supabase client
// =====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');
const supabase = createClient(supabaseUrl, supabaseKey);

// =====================
// DDF API config
// =====================
const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// =====================
// Show live progress
// =====================
function showProgress(counters) {
  process.stdout.write(`\rAdded: ${counters.added} | Updated: ${counters.updated} | Deleted: ${counters.deleted}`);
}

// =====================
// Get DDF access token
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
function normalize(value) {
  return value === undefined ? null : value;
}

function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || 'Unknown' : 'Unknown';

    return {
      ListingKey: normalize(property.ListingKey),
      PropertySubType: normalize(property.PropertySubType),
      NumberOfUnitsTotal: normalize(property.NumberOfUnitsTotal),
      LotFeatures: normalize(property.LotFeatures),
      LotSizeArea: normalize(property.LotSizeArea),
      LotSizeDimensions: normalize(property.LotSizeDimensions),
      LotSizeUnits: normalize(property.LotSizeUnits),
      PoolFeatures: normalize(property.PoolFeatures),
      CommunityFeatures: normalize(property.CommunityFeatures),
      Appliances: normalize(property.Appliances),
      TotalActualRent: normalize(property.TotalActualRent),
      AssociationFee: normalize(property.AssociationFee),
      AssociationFeeIncludes: normalize(property.AssociationFeeIncludes),
      OriginalEntryTimestamp: normalize(property.OriginalEntryTimestamp),
      ModificationTimestamp: normalize(property.ModificationTimestamp),
      ListingId: normalize(property.ListingId),
      StatusChangeTimestamp: normalize(property.StatusChangeTimestamp),
      PublicRemarks: normalize(property.PublicRemarks),
      ListPrice: normalize(property.ListPrice),
      OriginatingSystemName: normalize(property.OriginatingSystemName),
      PhotosCount: normalize(property.PhotosCount),
      PhotosChangeTimestamp: normalize(property.PhotosChangeTimestamp),
      CommonInterest: normalize(property.CommonInterest),
      UnparsedAddress: normalize(property.UnparsedAddress),
      PostalCode: normalize(property.PostalCode),
      SubdivisionName: normalize(property.SubdivisionName),
      UnitNumber: normalize(property.UnitNumber),
      City: normalize(property.City),
      Directions: normalize(property.Directions),
      Latitude: normalize(property.Latitude),
      Longitude: normalize(property.Longitude),
      CityRegion: normalize(property.CityRegion),
      ParkingTotal: normalize(property.ParkingTotal),
      YearBuilt: normalize(property.YearBuilt),
      BathroomsPartial: normalize(property.BathroomsPartial),
      BathroomsTotalInteger: normalize(property.BathroomsTotalInteger),
      BedroomsTotal: normalize(property.BedroomsTotal),
      BuildingAreaTotal: normalize(property.BuildingAreaTotal),
      BuildingAreaUnits: normalize(property.BuildingAreaUnits),
      AboveGradeFinishedArea: normalize(property.AboveGradeFinishedArea),
      BelowGradeFinishedArea: normalize(property.BelowGradeFinishedArea),
      LivingArea: normalize(property.LivingArea),
      Flooring: normalize(property.Flooring),
      Roof: normalize(property.Roof),
      Stories: normalize(property.Stories),
      PropertyAttachedYN: normalize(property.PropertyAttachedYN),
      BedroomsAboveGrade: normalize(property.BedroomsAboveGrade),
      BedroomsBelowGrade: normalize(property.BedroomsBelowGrade),
      TaxAnnualAmount: normalize(property.TaxAnnualAmount),
      TaxYear: normalize(property.TaxYear),
      StructureType: normalize(property.StructureType),
      IrrigationSource: normalize(property.IrrigationSource),
      owner_id: normalize(property.owner_id),
      FireplacesTotal: normalize(property.FireplacesTotal),
      Rooms: normalize(property.Rooms),
      Media: normalize(property.Media),
      Utilities: normalize(property.Utilities),
      Sewer: normalize(property.Sewer),
      WaterSource: normalize(property.WaterSource),
      Cooling: normalize(property.Cooling),
      ConstructionMaterials: normalize(property.ConstructionMaterials),
      ParkingFeatures: normalize(property.ParkingFeatures),
      BuildingFeatures: normalize(property.BuildingFeatures),
      ArchitecturalStyle: normalize(property.ArchitecturalStyle),
      Heating: normalize(property.Heating),
      FoundationDetails: normalize(property.FoundationDetails),
      Basement: normalize(property.Basement),
      ExteriorFeatures: normalize(property.ExteriorFeatures),
      OfficeName: officeName,
      ListOfficeKey: officeKey,
      ListingURL: normalize(property.ListingURL),
      CommunityName: normalize(property.Address?.CommunityName || property.City || 'Unknown'),
      Neighbourhood: normalize(property.Neighbourhood),
      PropertyType: normalize(property.PropertyType)
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

    // Upsert on ListingKey
    const { error } = await supabase.from('property').upsert(batch, {
      onConflict: ['ListingKey'],
    });
    if (error) console.error('Error saving batch:', error.message);

    showProgress(counters);
  }
}

// =====================
// Delete non-matching properties
// =====================
async function deleteNonMatchingProperties(listingKeys, counters) {
  try {
    const { data: existingKeys, error: fetchError } = await supabase
      .from('property')
      .select('ListingKey');

    if (fetchError) {
      console.error('Error fetching existing keys for deletion:', fetchError.message);
      return;
    }

    const existingSet = new Set(existingKeys.map(r => r.ListingKey));
    const latestSet = new Set(listingKeys);
    const toDelete = [...existingSet].filter(key => !latestSet.has(key));

    if (!toDelete.length) {
      console.log('No properties to delete.');
      return;
    }

    console.log(`Preparing to delete ${toDelete.length} old properties...`);

    const chunkSize = 500;
    let deletedCount = 0;

    for (let i = 0; i < toDelete.length; i += chunkSize) {
      const chunk = toDelete.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from('property')
        .delete()
        .in('ListingKey', chunk)
        .select('ListingKey');

      if (error) console.error(`Error deleting chunk at ${i}:`, error.message);
      else deletedCount += data.length;
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

      if (!data.value) throw new Error('Missing value array in DDF response');

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
