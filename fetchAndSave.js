import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) {
  throw new Error('Missing SUPABASE_KEY environment variable');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const MASTER_LIST_URL = 'https://ddfapi.realtor.ca/odata/v1/Property/PropertyReplication';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// ------------------- 1️⃣ Get access token -------------------
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

// ------------------- 2️⃣ Fetch office details -------------------
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
  const officeDetails = {};

  const fetchPromises = uniqueKeys.map(async (key) => {
    try {
      const response = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.value && data.value.length > 0) {
        officeDetails[key] = data.value[0].OfficeName;
      }
    } catch (err) {
      console.error(`Error fetching office ${key}:`, err.message);
    }
  });

  await Promise.all(fetchPromises);
  return officeDetails;
}

// ------------------- 3️⃣ Map properties -------------------
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey && officeDetails[officeKey] ? officeDetails[officeKey] : null;

    return {
      ListOfficeKey: officeKey,
      OfficeName: officeName,
      ListingKey: property.ListingKey,
      PropertyType: property.PropertyType,
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
      UnparsedAddress: property.UnparsedAddress,
      PostalCode: property.PostalCode,
      SubdivisionName: property.SubdivisionName,
      CommunityName: property.Address?.CommunityName || property.City || 'Unknown',
      Neighbourhood: property.Neighbourhood,
      UnitNumber: property.UnitNumber,
      City: property.City,
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
      IrrigationSource: property.IrrigationSource,
      WaterSource: property.WaterSource,
      Utilities: property.Utilities,
      Sewer: property.Sewer,
      Roof: property.Roof,
      ConstructionMaterials: property.ConstructionMaterials,
      Stories: property.Stories,
      PropertyAttachedYN: property.PropertyAttachedYN,
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

// ------------------- 4️⃣ Save properties to Supabase -------------------
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const { error } = await supabase.from('property').upsert(batch);
    if (error) console.error('Error saving batch:', error.message);
    else console.log(`Saved batch ${i / batchSize + 1} (${batch.length})`);
  }
}

// ------------------- 5️⃣ Delete all properties -------------------
async function deleteAllProperties() {
  const { error } = await supabase.from('property').delete().neq('ListingKey', '');
  if (error) console.error('Error deleting properties:', error.message);
  else console.log('Deleted all existing properties.');
}

// ------------------- 6️⃣ Fetch Master List -------------------
async function fetchMasterList() {
  const token = await getAccessToken();
  await deleteAllProperties();

  let nextLink = `${MASTER_LIST_URL}?$filter=Province eq 'Ontario'&$top=100`;

  while (nextLink) {
    try {
      console.log(`Fetching Master List: ${nextLink}`);
      const response = await fetch(nextLink, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) throw new Error(`Fetch error: ${response.statusText}`);
      const data = await response.json();

      // Get office names
      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);

      // Map properties
      const mapped = mapProperties(data.value, officeDetails);

      // Save to Supabase
      await savePropertiesToSupabase(mapped);

      nextLink = data['@odata.nextLink'] || null;
    } catch (err) {
      console.error('Error fetching Master List:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log('✅ All Ontario properties synchronized!');
}

// ------------------- 7️⃣ Run -------------------
(async function main() {
  try {
    console.log('Starting data sync from Master List...');
    await fetchMasterList();
    console.log('Data sync completed.');
  } catch (err) {
    console.error('Fatal error:', err.message);
  }
})();
