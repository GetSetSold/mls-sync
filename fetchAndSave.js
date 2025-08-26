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
// Global Error Handlers
// =====================
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', err => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

// =====================
// Utility: Live Progress
// =====================
function showProgress(counters) {
  process.stdout.write(
    `\rAdded: ${counters.added} | Updated: ${counters.updated} | Deleted: ${counters.deleted}`
  );
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
      if (data.value && data.value.length > 0) officeDetails[key] = data.value[0].OfficeName;
    } catch (error) {
      console.error(`Error fetching office ${key}:`, error.message);
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
    const officeName = officeKey ? officeDetails[officeKey] || null : null;

    return {
      ListOfficeKey: officeKey,
      OfficeName: officeName,
      ListingKey: property.ListingKey,
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
// Save properties in Supabase
// =====================
async function savePropertiesToSupabase(properties, counters) {
  const batchSize = 100;

  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);
    const keys = batch.map(p => p.ListingKey);

    // Check which already exist
    const { data: existingData, error: fetchError } = await supabase
      .from('property')
      .select('ListingKey')
      .in('ListingKey', keys);

    if (fetchError) throw fetchError;

    const existingKeys = new Set(existingData.map(p => p.ListingKey));
    batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

    const { error: upsertError } = await supabase
      .from('property')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (upsertError) throw upsertError;

    // Update live progress
    showProgress(counters);
  }
}

// =====================
// Delete non-matching properties
// =====================
async function deleteNonMatchingProperties(listingKeys, counters) {
  const { data, error } = await supabase
    .from('property')
    .delete()
    .not('ListingKey', 'in', listingKeys)
    .select('ListingKey');

  if (error) throw error;
  counters.deleted = data.length;
  showProgress(counters);
}

// =====================
// Fetch & process DDF properties
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
      if (!response.ok) throw new Error(`Failed to fetch properties: ${response.statusText}`);

      const data = await response.json();
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

  if (allFetchedKeys.length > 0) await deleteNonMatchingProperties(allFetchedKeys, counters);

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
