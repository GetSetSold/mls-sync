import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';
import { XMLParser } from 'fast-xml-parser';

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

// Fetch DDF access token
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
  if (!response.ok) throw new Error(data.error_description || 'Failed to fetch token');
  return data.access_token;
}

// Fetch unique office details
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
  const officeDetails = {};

  await Promise.all(
    uniqueKeys.map(async (key) => {
      try {
        const res = await fetch(`${OFFICE_URL}?$filter=OfficeKey eq '${key.trim()}'`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.value?.length > 0) officeDetails[key] = data.value[0].OfficeName;
      } catch (e) {
        console.error(`Error fetching office ${key}:`, e.message);
      }
    })
  );

  return officeDetails;
}

// Map XML properties to Supabase structure
function mapXmlProperties(properties, officeDetails) {
  return properties.map((p) => {
    const officeKey = p.ListOfficeKey || null;
    const officeName = officeKey && officeDetails[officeKey] ? officeDetails[officeKey] : null;
    const address = p.Address || {};

    return {
      ListOfficeKey: officeKey,
      OfficeName: officeName,
      ListingKey: p.ListingKey,
      PropertyType: p.PropertyType,
      PropertySubType: p.PropertySubType,
      ListPrice: p.Price || p.ListPrice,
      CommunityName: address.CommunityName || p.City || 'Unknown',
      City: address.City || p.City,
      PostalCode: address.PostalCode,
      UnitNumber: p.UnitNumber,
      PublicRemarks: p.PublicRemarks,
      Media: p.Media,
      ListingURL: p.ListingURL,
      BedroomsTotal: p.Building?.BedroomsTotal || null,
      BathroomsTotalInteger: p.Building?.BathroomTotal || null,
      LivingArea: p.Building?.SizeInterior || null,
      YearBuilt: p.Building?.YearBuilt || null,
      // Add any other fields you need
    };
  });
}

// Save properties to Supabase
async function savePropertiesToSupabase(properties) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const { error } = await supabase.from('property').upsert(batch);
    if (error) console.error('Error saving batch:', error.message);
  }
}

// Delete all existing properties
async function deleteAllProperties() {
  const { error } = await supabase.from('property').delete().neq('ListingKey', '');
  if (error) console.error('Error deleting properties:', error.message);
}

// Fetch properties by city or community
async function fetchPropertiesByLocation(token, locationField, locationName) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const batchSize = 100;
  let offset = 1;

  while (true) {
    const propertySubTypeFilter = `(PropertySubType eq 'Single Family' or PropertySubType eq 'Multi-family')`;
    const filter = encodeURIComponent(`${locationField} eq '${locationName}' and ${propertySubTypeFilter}`);
    const url = `${PROPERTY_URL}?$filter=${filter}&$top=${batchSize}&$skip=${offset - 1}`;

    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/xml' } });
      if (!res.ok) throw new Error(res.statusText);
      const xml = await res.text();
      const data = parser.parse(xml);
      const properties = data?.RETS?.['RETS-RESPONSE']?.PropertyDetails ?? [];

      if (!properties || properties.length === 0) break;

      const officeKeys = properties.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);
      const mapped = mapXmlProperties(properties, officeDetails);
      await savePropertiesToSupabase(mapped);

      const pagination = data?.RETS?.['RETS-RESPONSE']?.Pagination;
      if (!pagination || parseInt(pagination.RecordsReturned) + offset > parseInt(pagination.TotalRecords)) break;

      offset += parseInt(pagination.RecordsReturned);
    } catch (e) {
      console.error(`Error fetching ${locationName} (${locationField}) at offset ${offset}:`, e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// Main function
(async () => {
  try {
    console.log('Starting sync...');
    await deleteAllProperties();
    const token = await getAccessToken();

    const locations = [
      { field: 'City', name: 'Binbrook' },
      { field: 'City', name: 'Mount Hope' },
      { field: 'City', name: 'Ancaster' },
      { field: 'City', name: 'Stoney Creek' },
      { field: 'City', name: 'Hamilton' },
      { field: 'City', name: 'Flamborough' },
      { field: 'City', name: 'Caledonia' },
      { field: 'CommunityName', name: 'Haldimand' }, // Catch Haldimand listings
      { field: 'City', name: 'Cayuga' },
      { field: 'City', name: 'Brantford' },
      { field: 'City', name: 'Brant' },
      { field: 'City', name: 'Paris' },
      { field: 'City', name: 'Hagersville' },
    ];

    for (const loc of locations) {
      console.log(`Fetching listings for ${loc.name} (${loc.field})...`);
      await fetchPropertiesByLocation(token, loc.field, loc.name);
    }

    console.log('✅ All properties synced.');
  } catch (e) {
    console.error('Sync failed:', e.message);
  }
})();
