import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_KEY environment variable');
}

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// -------------------- Fetch access token --------------------
async function getAccessToken() {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: 'DDFApi_Read',
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || 'Failed to fetch DDF token');
    return data.access_token;
  } catch (err) {
    console.error('Error fetching access token:', err.message);
    throw err;
  }
}

// -------------------- Fetch unique office details --------------------
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
  const officeDetails = {};

  await Promise.all(uniqueKeys.map(async (key) => {
    try {
      const res = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'&$format=xml`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await res.text();
      const parser = new XMLParser({ ignoreAttributes: false });
      const xmlData = parser.parse(text);
      // Navigate to the OfficeName in the XML structure
      const officeName = xmlData?.feed?.entry?.content?.Office?.OfficeName || null;
      if (officeName) officeDetails[key] = officeName;
    } catch (err) {
      console.error(`Error fetching office ${key}: ${err.message}`);
    }
  }));

  return officeDetails;
}

// -------------------- Map properties --------------------
function mapProperties(properties, officeDetails) {
  return properties.map(p => ({
    ListOfficeKey: p.ListOfficeKey || null,
    OfficeName: officeDetails[p.ListOfficeKey] || null,
    ListingKey: p.ListingKey,
    ListingId: p.ListingId,
    PropertyType: p.PropertyType,
    PropertySubType: p.PropertySubType,
    PublicRemarks: p.PublicRemarks,
    ListPrice: p.ListPrice,
    City: p.City || p.Address?.City || 'Unknown',
    CommunityName: p.Address?.CommunityName || p.City || 'Unknown',
    PostalCode: p.PostalCode,
    Latitude: p.Latitude,
    Longitude: p.Longitude,
    BedroomsTotal: p.BedroomsTotal,
    BathroomsTotalInteger: p.BathroomsTotalInteger,
    BuildingAreaTotal: p.BuildingAreaTotal,
    YearBuilt: p.YearBuilt,
    ListingURL: p.ListingURL,
    Media: p.Media,
    TotalActualRent: p.TotalActualRent,
    NumberOfUnitsTotal: p.NumberOfUnitsTotal,
    LotFeatures: p.LotFeatures,
    LotSizeArea: p.LotSizeArea,
    LotSizeDimensions: p.LotSizeDimensions,
    LotSizeUnits: p.LotSizeUnits,
    PoolFeatures: p.PoolFeatures,
    CommunityFeatures: p.CommunityFeatures,
    Appliances: p.Appliances,
    AssociationFee: p.AssociationFee,
    AssociationFeeIncludes: p.AssociationFeeIncludes,
    OriginalEntryTimestamp: p.OriginalEntryTimestamp,
    ModificationTimestamp: p.ModificationTimestamp,
    StatusChangeTimestamp: p.StatusChangeTimestamp,
    CommonInterest: p.CommonInterest,
    UnparsedAddress: p.UnparsedAddress,
    SubdivisionName: p.SubdivisionName,
    Neighbourhood: p.Neighbourhood,
    UnitNumber: p.UnitNumber,
    Directions: p.Directions,
    CityRegion: p.CityRegion,
    ParkingTotal: p.ParkingTotal,
    BathroomsPartial: p.BathroomsPartial,
    BuildingAreaUnits: p.BuildingAreaUnits,
    BuildingFeatures: p.BuildingFeatures,
    AboveGradeFinishedArea: p.AboveGradeFinishedArea,
    BelowGradeFinishedArea: p.BelowGradeFinishedArea,
    LivingArea: p.LivingArea,
    FireplacesTotal: p.FireplacesTotal,
    ArchitecturalStyle: p.ArchitecturalStyle,
    Heating: p.Heating,
    FoundationDetails: p.FoundationDetails,
    Basement: p.Basement,
    ExteriorFeatures: p.ExteriorFeatures,
    Flooring: p.Flooring,
    ParkingFeatures: p.ParkingFeatures,
    Cooling: p.Cooling,
    IrrigationSource: p.IrrigationSource,
    WaterSource: p.WaterSource,
    Utilities: p.Utilities,
    Sewer: p.Sewer,
    Roof: p.Roof,
    ConstructionMaterials: p.ConstructionMaterials,
    Stories: p.Stories,
    PropertyAttachedYN: p.PropertyAttachedYN,
    BedroomsAboveGrade: p.BedroomsAboveGrade,
    BedroomsBelowGrade: p.BedroomsBelowGrade,
    TaxAnnualAmount: p.TaxAnnualAmount,
    TaxYear: p.TaxYear,
    Rooms: p.Rooms,
    StructureType: p.StructureType,
  }));
}

// -------------------- Save to Supabase --------------------
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const { error } = await supabase.from('property').upsert(batch);
    if (error) console.error('Error saving batch:', error.message);
    else console.log(`Saved batch ${i / batchSize + 1} (${batch.length} properties).`);
  }
}

// -------------------- Delete all properties --------------------
async function deleteAllProperties() {
  const { error } = await supabase.from('property').delete().neq('ListingKey', '');
  if (error) console.error('Error deleting properties:', error.message);
  else console.log('Deleted all existing properties.');
}

// -------------------- Fetch and process properties --------------------
async function fetchAndProcessDDFProperties() {
  const token = await getAccessToken();
  const batchSize = 50;

  const cities = [
    'Binbrook', 'Mount Hope', 'Ancaster', 'Stoney Creek', 'Hamilton',
    'Flamborough', 'Caledonia', 'Cayuga', 'Haldimand', 'Brantford',
    'Brant', 'Paris', 'Hagersville'
  ];

  const propertySubTypeFilter = `(PropertySubType eq 'Single Family' or PropertySubType eq 'Multi-family')`;

  // --- 1️⃣ Fetch by city ---
  const cityFilter = cities.map(city => `City eq '${city}'`).join(' or ');
  let nextLink = `${PROPERTY_URL}?$filter=(${cityFilter}) and ${propertySubTypeFilter}&$top=${batchSize}&$format=xml`;

  console.log('Deleting all existing properties in the database...');
  await deleteAllProperties();

  const parser = new XMLParser({ ignoreAttributes: false });

  while (nextLink) {
    try {
      console.log(`Fetching properties from ${nextLink}...`);
      const res = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      const text = await res.text();
      const data = parser.parse(text);

      const entries = data?.feed?.entry;
      if (!entries || entries.length === 0) break;

      const officeKeys = entries.map(e => e?.content?.Property?.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);

      const mapped = mapProperties(entries.map(e => e.content.Property), officeDetails);
      await savePropertiesToSupabase(mapped);

      // Handle nextLink from XML if exists (optional, depends on DDF XML)
      nextLink = null; // Stop loop if pagination not implemented in XML
    } catch (err) {
      console.error('Error fetching properties:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  console.log('✅ XML data synchronization completed.');
}

// -------------------- Main --------------------
(async () => {
  try {
    console.log('Starting XML DDF fetch...');
    await fetchAndProcessDDFProperties();
  } catch (err) {
    console.error('Fatal error:', err.message);
  }
})();
