import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// =====================
// Global Error Handlers
// =====================
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

process.on('uncaughtException', err => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// =====================
// Supabase Setup
// =====================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl) throw new Error('Missing SUPABASE_URL environment variable');
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

// =====================
// DDF API Config
// =====================
const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';
const OFFICE_URL = 'https://ddfapi.realtor.ca/odata/v1/Office';

// =====================
// Fetch Access Token
// =====================
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

    console.log('✅ Successfully fetched DDF access token');
    return data.access_token;
  } catch (err) {
    console.error('❌ Error fetching DDF access token:', err.message);
    throw err;
  }
}

// =====================
// Fetch Office Details
// =====================
async function fetchOfficeDetails(token, officeKeys) {
  const uniqueKeys = [...new Set(officeKeys)];
  const officeDetails = {};
  if (!uniqueKeys.length) return officeDetails;

  try {
    const filter = uniqueKeys.map(k => `OfficeKey eq '${k}'`).join(' or ');
    const response = await fetch(`${OFFICE_URL}?$filter=${filter}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (!response.ok) throw new Error('Failed fetching office details');

    data.value?.forEach(office => {
      officeDetails[office.OfficeKey] = office.OfficeName;
    });
  } catch (err) {
    console.error('❌ Error fetching office details:', err.message);
  }
  return officeDetails;
}

// =====================
// Map Properties
// =====================
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
      ListPrice: property.ListPrice,
      ModificationTimestamp: property.ModificationTimestamp,
      PublicRemarks: property.PublicRemarks,
      CommunityName: property.Address?.CommunityName || property.City || 'Unknown',
      City: property.City,
      Latitude: property.Latitude,
      Longitude: property.Longitude,
      ListingURL: property.ListingURL,
    };
  });
}

// =====================
// Save Properties & Track Progress
// =====================
async function savePropertiesToSupabase(properties, counters, progress) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const keys = batch.map(p => p.ListingKey);

    // Check existing keys
    const { data: existingData, error: fetchError } = await supabase
      .from('property')
      .select('ListingKey')
      .in('ListingKey', keys);

    if (fetchError) throw fetchError;

    const existingKeys = new Set(existingData.map(p => p.ListingKey));

    batch.forEach(p => {
      if (existingKeys.has(p.ListingKey)) counters.updated++;
      else counters.added++;
    });

    // Upsert batch
    const { error: upsertError } = await supabase
      .from('property')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (upsertError) throw upsertError;

    progress.fetched += batch.length;
    progress.batches++;
    console.log(`Batch ${progress.batches} saved (${batch.length} properties). Total fetched: ${progress.fetched}`);
    console.log(`Current counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
  }
}

// =====================
// Delete Non-Matching Properties
// =====================
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
    console.error('❌ Error deleting non-matching properties:', err.message);
  }
}

// =====================
// Main DDF Sync
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { added: 0, updated: 0, deleted: 0 };
  const progress = { fetched: 0, batches: 0 };
  let allFetchedKeys = [];

  const token = await getAccessToken();
  let nextLink = `${PROPERTY_URL}?$top=100`;

  while (nextLink) {
    try {
      console.log(`Fetching properties: ${nextLink}`);
      const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();

      if (!response.ok) throw new Error('Failed to fetch properties');

      console.log(`Fetched ${data.value.length} properties from this page`);
      const officeKeys = data.value.map(p => p.ListOfficeKey).filter(Boolean);
      const officeDetails = await fetchOfficeDetails(token, officeKeys);
      const mappedProperties = mapProperties(data.value, officeDetails);

      await savePropertiesToSupabase(mappedProperties, counters, progress);
      allFetchedKeys.push(...mappedProperties.map(p => p.ListingKey));

      nextLink = data['@odata.nextLink'] || null;
    } catch (err) {
      console.error('❌ Error processing batch:', err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (allFetchedKeys.length > 0) await deleteNonMatchingProperties(allFetchedKeys, counters);

  console.log('✅ DDF incremental sync complete');
  console.log(`Final counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// =====================
// Run Main
// =====================
(async function main() {
  try {
    console.log('Starting incremental DDF property sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
  }
})();
