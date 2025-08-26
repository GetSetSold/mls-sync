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

// Fetch DDF access token
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
    if (!response.ok) {
      console.error('DDF token fetch failed:', data);
      throw new Error(data.error_description || 'Failed to fetch DDF token');
    }
    return data.access_token;
  } catch (err) {
    console.error('Error fetching DDF token:', err.message);
    throw err;
  }
}

// Fetch office details
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
  const officeDetails = {};
  if (uniqueKeys.length === 0) return officeDetails;

  try {
    const filter = uniqueKeys.map(k => `OfficeKey eq '${k}'`).join(' or ');
    const response = await fetch(`${OFFICE_URL}?$filter=${filter}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('Office details fetch failed:', data);
      return officeDetails;
    }
    data.value?.forEach(office => {
      officeDetails[office.OfficeKey] = office.OfficeName;
    });
  } catch (err) {
    console.error('Error fetching office details:', err.message);
  }

  return officeDetails;
}

// Map properties
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || null : null;
    return {
      ListingKey: property.ListingKey,
      ListOfficeKey: officeKey,
      OfficeName: officeName,
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

// Save properties with precise counters and progress
async function savePropertiesToSupabase(properties, counters, progress) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const keys = batch.map(p => p.ListingKey);

    try {
      // Fetch existing keys
      const { data: existingData, error: fetchError } = await supabase
        .from('property')
        .select('ListingKey')
        .in('ListingKey', keys);

      if (fetchError) throw fetchError;

      const existingKeys = new Set(existingData.map(p => p.ListingKey));

      // Count added vs updated
      batch.forEach(p => {
        if (existingKeys.has(p.ListingKey)) counters.updated++;
        else counters.added++;
      });

      // Upsert batch
      const { error: upsertError } = await supabase
        .from('property')
        .upsert(batch, { onConflict: ['ListingKey'] });

      if (upsertError) throw upsertError;

      // Update progress
      progress.fetched += batch.length;
      progress.batches++;
      console.log(`Batch ${progress.batches} saved (${batch.length} properties). Total fetched: ${progress.fetched}`);
      console.log(`Current counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
    } catch (err) {
      console.error(`Error processing batch ${i / batchSize + 1}:`, err.message);
    }
  }
}

// Delete properties no longer in DDF
async function deleteNonMatchingProperties(listingKeys, counters) {
  try {
    const { data, error } = await supabase
      .from('property')
      .delete()
      .not('ListingKey', 'in', listingKeys)
      .select('ListingKey');

    if (error) throw error;

    counters.deleted = data.length;
    console.log(`Deleted ${data.length} properties not in the latest fetch`);
  } catch (err) {
    console.error('Error deleting non-matching properties:', err.message);
  }
}

// Main DDF sync
async function fetchAndProcessDDFProperties() {
  const counters = { added: 0, updated: 0, deleted: 0 };
  const progress = { fetched: 0, batches: 0 };
  let allFetchedKeys = [];

  try {
    const token = await getAccessToken();
    let nextLink = `${PROPERTY_URL}?$top=100`;

    while (nextLink) {
      try {
        console.log(`Fetching properties: ${nextLink}`);
        const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
        const data = await response.json();

        if (!response.ok) {
          console.error('Property fetch failed:', data);
          break;
        }

        console.log(`Fetched ${data.value.length} properties from this page`);
        const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
        const officeDetails = await fetchOfficeDetails(token, officeKeys);
        const mappedProperties = mapProperties(data.value, officeDetails);

        await savePropertiesToSupabase(mappedProperties, counters, progress);
        allFetchedKeys.push(...mappedProperties.map(p => p.ListingKey));

        nextLink = data['@odata.nextLink'] || null;
      } catch (err) {
        console.error('Error processing batch:', err.message);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    if (allFetchedKeys.length > 0) await deleteNonMatchingProperties(allFetchedKeys, counters);

    console.log('✅ DDF incremental sync complete');
    console.log(`Final counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
  } catch (err) {
    console.error('Fatal sync error:', err.message);
    throw err;
  }
}

// Run main
(async function main() {
  try {
    console.log('Starting incremental DDF property sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (err) {
    console.error('Process exited with error:', err.message);
    process.exit(1);
  }
})();

  if (uniqueKeys.length === 0) return officeDetails;

  try {
    // Batch request for multiple offices at once
    const filter = uniqueKeys.map(k => `OfficeKey eq '${k}'`).join(' or ');
    const response = await fetch(`${OFFICE_URL}?$filter=${filter}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (data.value) {
      data.value.forEach(office => {
        officeDetails[office.OfficeKey] = office.OfficeName;
      });
    }
  } catch (error) {
    console.error('Error fetching office details:', error.message);
  }

  return officeDetails;
}

// Map properties for Supabase
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || null : null;
    return {
      ListingKey: property.ListingKey,
      ListOfficeKey: officeKey,
      OfficeName: officeName,
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

// Save properties in Supabase with counters
async function savePropertiesToSupabase(properties, counters) {
  const batchSize = 100;

  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);

    // Upsert with ListingKey as unique key
    const { data, error } = await supabase
      .from('property')
      .upsert(batch, { onConflict: ['ListingKey'] })
      .select();

    if (error) {
      console.error('Error saving batch:', error.message);
    } else {
      // Count new vs updated
      data.forEach(item => {
        const existing = properties.find(p => p.ListingKey === item.ListingKey);
        if (existing) counters.updated++;
        else counters.added++;
      });
      console.log(`Saved batch ${i / batchSize + 1} (${batch.length} properties)`);
    }
  }
}

// Delete Supabase properties not in the latest fetch
async function deleteNonMatchingProperties(listingKeys, counters) {
  const { data, error } = await supabase
    .from('property')
    .delete()
    .not('ListingKey', 'in', listingKeys)
    .select('ListingKey');

  if (error) console.error('Error deleting non-matching properties:', error.message);
  else {
    counters.deleted = data.length;
    console.log(`Deleted ${data.length} properties not in the latest fetch`);
  }
}

// Fetch and process DDF properties incrementally
async function fetchAndProcessDDFProperties() {
  const counters = { added: 0, updated: 0, deleted: 0 };
  const token = await getAccessToken();
  let nextLink = `${PROPERTY_URL}?$top=100`;
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      console.log(`Fetching properties: ${nextLink}`);
      const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Failed to fetch properties: ${response.statusText}`);

      const data = await response.json();
      console.log(`Fetched ${data.value.length} properties`);

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

  // Delete properties no longer in DDF
  if (allFetchedKeys.length > 0) await deleteNonMatchingProperties(allFetchedKeys, counters);

  console.log('✅ DDF incremental sync complete');
  console.log(`Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// Main
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
  const officeDetails = {};

  await Promise.all(uniqueKeys.map(async key => {
    try {
      const response = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();
      if (data.value && data.value.length > 0) officeDetails[key] = data.value[0].OfficeName;
    } catch (error) {
      console.error(`Error fetching office ${key}:`, error.message);
    }
  }));

  return officeDetails;
}

// Map properties for Supabase
function mapProperties(properties, officeDetails) {
  return properties.map(property => {
    const officeKey = property.ListOfficeKey || null;
    const officeName = officeKey ? officeDetails[officeKey] || null : null;

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

// Save properties in Supabase
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const { error } = await supabase.from('property').upsert(batch);
    if (error) console.error('Error saving batch:', error.message);
    else console.log(`Saved batch ${i / batchSize + 1} (${batch.length} properties)`);
  }
}

// Delete Supabase properties not in the latest fetch
async function deleteNonMatchingProperties(listingKeys) {
  const { error } = await supabase
    .from('property')
    .delete()
    .not('ListingKey', 'in', listingKeys);
  if (error) console.error('Error deleting non-matching properties:', error.message);
  else console.log('Deleted properties not in the latest fetch');
}

// Fetch and process DDF properties incrementally
async function fetchAndProcessDDFProperties() {
  const token = await getAccessToken();
  let nextLink = `${PROPERTY_URL}?$top=100`;
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      console.log(`Fetching properties: ${nextLink}`);
      const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error(`Failed to fetch properties: ${response.statusText}`);

      const data = await response.json();
      console.log(`Fetched ${data.value.length} properties`);

      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);

      const mappedProperties = mapProperties(data.value, officeDetails);
      await savePropertiesToSupabase(mappedProperties);

      // Track ListingKeys for deletion logic
      allFetchedKeys.push(...mappedProperties.map(p => `'${p.ListingKey}'`));

      nextLink = data['@odata.nextLink'] || null;
    } catch (error) {
      console.error('Error fetching properties:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // Delete properties that are no longer in DDF
  if (allFetchedKeys.length > 0) await deleteNonMatchingProperties(allFetchedKeys);

  console.log('✅ DDF incremental sync complete');
}

// Main
(async function main() {
  try {
    console.log('Starting incremental DDF property sync...');
    await fetchAndProcessDDFProperties();

    console.log('Sync complete. Exiting process.');
    process.exit(0); // Explicitly terminate Node.js
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1); // Exit with error code
  }
})();
