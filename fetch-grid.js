// grid-sync.js
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

// CREA DDF API
const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';

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
// Map properties for grid
// =====================
function mapPropertiesForGrid(properties) {
  return properties.map(p => {
    // Get first photo with Order=1
    let firstPhoto = null;
    if (Array.isArray(p.Media)) {
      const photo = p.Media.find(m => m.Order === 1);
      if (photo) firstPhoto = photo.MediaURL;
    }

    return {
      ListingKey: p.ListingKey,
      TotalActualRent: p.TotalActualRent,
      OriginalEntryTimestamp: p.OriginalEntryTimestamp,
      ListPrice: p.ListPrice,
      PhotosCount: p.PhotosCount,
      Media: firstPhoto, // only first photo

      // Flattened address
      UnparsedAddress: p.Address?.UnparsedAddress || p.UnparsedAddress || null,
      City: p.Address?.City || p.City || 'Unknown',
      UnitNumber: p.Address?.UnitNumber || p.UnitNumber || null,
      Province: p.Address?.Province || p.Province || 'ON',
      PostalCode: p.Address?.PostalCode || p.PostalCode || null,
      Latitude: p.Latitude,
      Longitude: p.Longitude,
     

      // Property details
      ParkingTotal: p.ParkingTotal,
      BathroomsTotalInteger: p.BathroomsTotalInteger,
      BedroomsTotal: p.BedroomsTotal,
      AboveGradeFinishedArea: p.AboveGradeFinishedArea,
      StructureTypeText: p.StructureType,
    };
  });
}

// =====================
// Save properties to grid
// =====================
async function savePropertiesToGrid(properties, counters) {
  const batchSize = 100;
  for (let i = 0; i < properties.length; i += batchSize) {
    const batch = properties.slice(i, i + batchSize);

    const keys = batch.map(p => p.ListingKey);
    const { data: existingData } = await supabase
      .from('grid')
      .select('ListingKey')
      .in('ListingKey', keys);

    const existingKeys = new Set(existingData?.map(p => p.ListingKey) || []);
    batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

    const { error } = await supabase.from('grid').upsert(batch, { onConflict: ['ListingKey'] });
    if (error) console.error('Error saving batch:', error.message);

    showProgress(counters);
  }
}

// =====================
// Delete non-matching listings from grid
// =====================
async function deleteNonMatchingProperties(listingKeys, counters) {
  try {
    const { data: existingKeys, error: fetchError } = await supabase
      .from('grid')
      .select('ListingKey');

    if (fetchError) {
      console.error('Error fetching existing keys for deletion:', fetchError.message);
      return;
    }

    const existingSet = new Set(existingKeys.map(r => r.ListingKey));
    const latestSet = new Set(listingKeys);
    const toDelete = [...existingSet].filter(key => !latestSet.has(key));

    if (!toDelete.length) return;

    const chunkSize = 500;
    let deletedCount = 0;
    for (let i = 0; i < toDelete.length; i += chunkSize) {
      const chunk = toDelete.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from('grid')
        .delete()
        .in('ListingKey', chunk)
        .select('ListingKey');

      if (error) console.error(`Error deleting chunk at ${i}:`, error.message);
      else deletedCount += data.length;
    }

    counters.deleted = deletedCount;
    showProgress(counters);
  } catch (err) {
    console.error('Fatal deletion error:', err.message);
  }
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
      const data = await response.json();

      if (!data.value) throw new Error('Missing value array in DDF response');

      const mappedProperties = mapPropertiesForGrid(data.value);
      await savePropertiesToGrid(mappedProperties, counters);

      allFetchedKeys.push(...mappedProperties.map(p => p.ListingKey));
      nextLink = data['@odata.nextLink'] || null;
    } catch (error) {
      console.error('Error fetching properties:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (allFetchedKeys.length) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log(`\n✅ Grid sync complete. Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// =====================
// Main
// =====================
(async function main() {
  try {
    console.log('Starting incremental grid sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
