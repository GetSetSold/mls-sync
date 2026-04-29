import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

// ✅ URL hardcoded — env var caused silent {} errors
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = process.env.DDF_CLIENT_ID || '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET || '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';

const BATCH_SIZE = 500;     // ✅ up from 100 — fewer DB round trips
const BATCH_DELAY_MS = 300; // ✅ pause between batches to reduce Disk IO spikes

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
// Map properties for grid — unchanged from original working version
// =====================
function mapPropertiesForGrid(properties) {
  return properties.map(p => {
    let firstPhoto = null;
    if (Array.isArray(p.Media)) {
      const photo = p.Media.find(m => m.Order === 1);
      if (photo) firstPhoto = photo.MediaURL;
    }

    let structureTypeText = null;
    if (Array.isArray(p.StructureType) && p.StructureType.length > 0) {
      structureTypeText = p.StructureType[0];
    } else if (p.StructureType && typeof p.StructureType === 'string') {
      structureTypeText = p.StructureType;
    }

    return {
      ListingKey: p.ListingKey,
      TotalActualRent: p.TotalActualRent,
      OriginalEntryTimestamp: p.OriginalEntryTimestamp,
      ListPrice: p.ListPrice,
      PhotosCount: p.PhotosCount,
      Media: firstPhoto,
      UnparsedAddress: p.Address?.UnparsedAddress || p.UnparsedAddress || null,
      City: p.Address?.City || p.City || 'Unknown',
      UnitNumber: p.Address?.UnitNumber || p.UnitNumber || null,
      Province: p.Address?.Province || p.Province || 'ON',
      PostalCode: p.Address?.PostalCode || p.PostalCode || null,
      Latitude: p.Latitude,
      Longitude: p.Longitude,
      ParkingTotal: p.ParkingTotal,
      BathroomsTotalInteger: p.BathroomsTotalInteger,
      BedroomsTotal: p.BedroomsTotal,
      AboveGradeFinishedArea: p.AboveGradeFinishedArea,
      StructureTypeText: structureTypeText,
    };
  });
}

// =====================
// Save to grid — same working upsert pattern, larger batch + delay
// =====================
async function savePropertiesToGrid(properties, counters) {
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);

    const keys = batch.map(p => p.ListingKey);
    const { data: existingData } = await supabase
      .from('grid')
      .select('ListingKey')
      .in('ListingKey', keys);

    const existingKeys = new Set(existingData?.map(p => p.ListingKey) || []);
    batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

    const { error } = await supabase
      .from('grid')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (error) console.error('\nError saving batch:', error.message);

    showProgress(counters);

    // ✅ Pause between batches to spread Disk IO
    if (i + BATCH_SIZE < properties.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
    }
  }
}

// =====================
// Delete non-matching listings
// ✅ Paginated fetch — fixes timeout from single SELECT on 56K rows
// ✅ Safety guard only blocks on zero keys, not arbitrary threshold
// =====================
async function deleteNonMatchingProperties(allFetchedKeys, counters) {
  if (allFetchedKeys.length === 0) {
    console.log('\n⚠️ No keys collected from DDF — skipping deletion');
    return;
  }

  console.log(`\nChecking for deleted listings (${allFetchedKeys.length} DDF keys collected)...`);

  const latestSet = new Set(allFetchedKeys);
  const toDelete = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  // ✅ Paginate through grid keys — avoids timeout from one large SELECT
  while (hasMore) {
    const { data, error } = await supabase
      .from('grid')
      .select('ListingKey')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('\n⚠️ Error scanning grid — skipping deletion to be safe:', error.message);
      return;
    }

    if (!data || data.length === 0) {
      hasMore = false;
      break;
    }

    data.forEach(r => {
      if (!latestSet.has(r.ListingKey)) toDelete.push(r.ListingKey);
    });

    from += pageSize;
    hasMore = data.length === pageSize;
    process.stdout.write(`\rScanning grid... ${from} checked`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo listings to delete from grid.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired listings from grid...`);

  const chunkSize = 500;
  let deletedCount = 0;

  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('grid')
      .delete()
      .in('ListingKey', chunk)
      .select('ListingKey');

    if (error) {
      console.error('\nDelete error:', error.message);
      return;
    }

    deletedCount += data.length;
    await new Promise(r => setTimeout(r, 200));
  }

  counters.deleted = deletedCount;
  console.log(`\n✅ Deleted ${deletedCount} expired listings`);
  showProgress(counters);
}

// =====================
// Fetch from DDF and sync to grid — same pattern as original working file
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { added: 0, updated: 0, deleted: 0 };
  const token = await getAccessToken();
  let nextLink = `${PROPERTY_URL}?$top=100`;
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      const response = await fetch(nextLink, { headers: { Authorization: `Bearer ${token}` } });
      const data = await response.json();

      if (!data.value) throw new Error('Missing value array in DDF response');

      const mappedProperties = mapPropertiesForGrid(data.value);
      await savePropertiesToGrid(mappedProperties, counters);

      allFetchedKeys.push(...mappedProperties.map(p => p.ListingKey));
      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nError fetching properties:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  if (allFetchedKeys.length > 0) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log('\n✅ Grid sync complete');
  console.log(`Final counts → Added: ${counters.added}, Updated: ${counters.updated}, Deleted: ${counters.deleted}`);
}

// =====================
// Main
// =====================
(async function main() {
  try {
    console.log('Starting grid sync...');
    await fetchAndProcessDDFProperties();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
