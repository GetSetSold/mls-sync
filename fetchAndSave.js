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
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// Fetch access token
async function getAccessToken() {
  try {
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
  } catch (error) {
    console.error('Error fetching access token:', error.message);
    throw error;
  }
}

// Fetch unique office details
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
      } else {
        console.warn(`No office details found for OfficeKey: ${key}`);
      }
    } catch (error) {
      console.error(`Error fetching office details for OfficeKey ${key}:`, error.message);
    }
  });

  await Promise.all(fetchPromises);
  return officeDetails;
}





// Fetch and process DDF properties
async function fetchAndProcessDDFProperties() {
  const token = await getAccessToken();
  const batchSize = 50;

  // Filter for all Ontario residential properties
const provinceFilter = `(Province eq 'ON') and (PropertySubType eq 'Single Family' or PropertySubType eq 'Multi-family')`;
let nextLink = `${PROPERTY_URL}?$filter=${encodeURIComponent(provinceFilter)}&$top=${batchSize}`;


  console.log('Deleting all existing properties in the database...');
  await deleteAllProperties();

  while (nextLink) {
    try {
      console.log(`Fetching properties from ${nextLink}...`);
      const response = await fetch(nextLink, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Error fetching data: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`Fetched ${data.value.length} properties. Processing...`);

      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);

      const mappedProperties = mapProperties(data.value, officeDetails);

      console.log('Saving properties to database...');
      await savePropertiesToSupabase(mappedProperties);

      nextLink = data['@odata.nextLink'] || null;
    } catch (error) {
      console.error(`Error during city fetch: ${error.message}. Retrying in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // --- 2️⃣ Fetch Haldimand County by CommunityName ---
  const haldimandFilter = `(CommunityName eq 'Haldimand') and ${propertySubTypeFilter}`;
  nextLink = `${PROPERTY_URL}?$filter=${encodeURIComponent(haldimandFilter)}&$top=${batchSize}`;

  while (nextLink) {
    try {
      console.log(`Fetching Haldimand County properties by CommunityName...`);
      const response = await fetch(nextLink, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        throw new Error(`Error fetching Haldimand CommunityName: ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`Fetched ${data.value.length} Haldimand properties. Processing...`);

      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);

      const mappedProperties = mapProperties(data.value, officeDetails);

      console.log('Saving Haldimand properties to database...');
      await savePropertiesToSupabase(mappedProperties);

      nextLink = data['@odata.nextLink'] || null;
    } catch (error) {
      console.error(`Error during Haldimand fetch: ${error.message}. Retrying in 5 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  console.log('✅ Data synchronization completed for all properties.');
}








// Map properties with OfficeName
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null; // Use null if missing
    const officeName = officeKey && officeDetails[officeKey]
      ? officeDetails[officeKey]
      : null; // null if no office

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

// Save properties to Supabase in batches
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;

  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    try {
      const { error } = await supabase.from('property').upsert(batch);
      if (error) throw error;
      console.log(`Saved batch ${i / batchSize + 1} (${batch.length} properties).`);
    } catch (error) {
      console.error(`Error saving batch: ${error.message}`);
    }
  }
}

// Delete all properties in the database
async function deleteAllProperties() {
  try {
    const { error } = await supabase.from('property').delete().neq('ListingKey', '');
    if (error) throw error;
    console.log('Deleted all existing properties.');
  } catch (error) {
    console.error('Error deleting properties:', error.message);
  }
}

// Main function
(async function main() {
  try {
    console.log('Starting data synchronization...');
    await fetchAndProcessDDFProperties();
    console.log('Data synchronization completed.');
  } catch (error) {
    console.error('Error in processing:', error.message);
  }
})();
