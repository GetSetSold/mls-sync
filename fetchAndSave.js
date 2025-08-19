// fetchAndSave.js
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabaseUrl = process.env.SUPABASE_URL || 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL   = 'https://identity.crea.ca/connect/token';
const CLIENT_ID   = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL  = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL    = 'https://ddfapi.realtor.ca/odata/v1/Office';

const PAGE_SIZE = 50;         // keep small to be gentle with DDF
const UPSERT_BATCH = 100;     // Supabase upsert chunk size

// 1) Access token
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

// 2) Office details (per page to avoid n+1 cost across entire province)
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set((officeKeys || []).filter(Boolean))];
  const officeDetails = {};
  await Promise.all(uniqueKeys.map(async key => {
    try {
      const res = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const json = await res.json();
      if (json?.value?.length) officeDetails[key] = json.value[0].OfficeName || null;
    } catch (e) {
      console.error(`Office lookup failed for ${key}:`, e.message);
    }
  }));
  return officeDetails;
}

// 3) EXACT field mapping to your property table
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
      // add any other columns you physically have in Supabase if needed
    };
  });
}

// 4) Upsert in batches and count new/updated
async function upsertPropertiesBatched(rows) {
  let added = 0, updated = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    const keys = batch.map(r => r.ListingKey);

    // find existing keys for this batch
    const { data: existing, error: selErr } = await supabase
      .from('property')
      .select('ListingKey')
      .in('ListingKey', keys);
    if (selErr) {
      console.error('Select existing error:', selErr.message);
    }
    const existingSet = new Set((existing || []).map(r => r.ListingKey));
    added += batch.filter(r => !existingSet.has(r.ListingKey)).length;
    updated += batch.filter(r => existingSet.has(r.ListingKey)).length;

    const { error } = await supabase
      .from('property')
      .upsert(batch, { onConflict: 'ListingKey' });
    if (error) console.error('Upsert error:', error.message);
    else console.log(`Upserted ${batch.length} (page chunk)`);
  }
  return { added, updated };
}

// 5) Get all ListingKeys currently in DB (paged)
async function getAllDbListingKeys() {
  const CHUNK = 1000;
  let from = 0;
  let all = [];
  while (true) {
    const to = from + CHUNK - 1;
    const { data, error } = await supabase
      .from('property')
      .select('ListingKey')
      .range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data.map(r => r.ListingKey));
    if (data.length < CHUNK) break;
    from += CHUNK;
  }
  return all;
}

// 6) Fetch ALL Ontario listings and sync
async function fetchAndSyncOntario() {
  const token = await getAccessToken();

  // DDF sometimes uses 'ON' or 'Ontario' → handle both.
  const propertySubTypeFilter =
    "(PropertySubType eq 'Single Family' or PropertySubType eq 'Multi-family')";
  const provinceFilter =
    "((Province eq 'ON') or (Province eq 'Ontario'))";
  let nextLink = `${PROPERTY_URL}?$filter=${encodeURIComponent(`${provinceFilter} and ${propertySubTypeFilter}`)}&$top=${PAGE_SIZE}`;

  const feedKeys = new Set();
  let totalFetched = 0;
  let added = 0, updated = 0;

  while (nextLink) {
    console.log('Fetching:', nextLink);
    const res = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Fetch error: ${res.status} ${res.statusText}`);
    const json = await res.json();

    const page = json?.value || [];
    totalFetched += page.length;
    console.log(`Fetched ${page.length} listings (running total: ${totalFetched})`);

    // Feed keys
    page.forEach(p => { if (p.ListingKey) feedKeys.add(p.ListingKey); });

    // Office lookup for this page
    const officeKeys = page.map(p => p.ListOfficeKey).filter(Boolean);
    const officeDetails = await fetchOfficeDetails(token, officeKeys);

    // Map and upsert this page
    const mapped = mapProperties(page, officeDetails);
    const counts = await upsertPropertiesBatched(mapped);
    added += counts.added;
    updated += counts.updated;

    nextLink = json['@odata.nextLink'] || null;
  }

  console.log(`Total fetched Ontario properties: ${totalFetched}`);

  // Delete expired (missing from feed)
  const dbKeys = await getAllDbListingKeys();
  const toDelete = dbKeys.filter(k => !feedKeys.has(k));
  let deleted = 0;
  if (toDelete.length) {
    console.log(`Deleting ${toDelete.length} expired listings...`);
    // delete in chunks
    const CHUNK = 1000;
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      const chunk = toDelete.slice(i, i + CHUNK);
      const { error } = await supabase.from('property').delete().in('ListingKey', chunk);
      if (error) {
        console.error('Delete error:', error.message);
      } else {
        deleted += chunk.length;
      }
    }
  }

  console.log(`✅ Sync summary → Added: ${added}, Updated: ${updated}, Deleted: ${deleted}, TotalSeenToday: ${feedKeys.size}`);
}

// 7) Main
(async function main() {
  try {
    console.log('Starting Ontario daily sync…');
    await fetchAndSyncOntario();
    console.log('Done.');
  } catch (err) {
    console.error('Fatal error:', err?.message || err);
    process.exit(1);
  }
})();
