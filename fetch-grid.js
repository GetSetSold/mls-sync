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

const BATCH_SIZE = 500;

// =====================
// Detect sync mode
// Matches fetch-property.js — full at 2am UTC, delta all other runs
// =====================
function getSyncMode() {
  const utcHour = new Date().getUTCHours();
  const isFullSync = utcHour === 2;
  return isFullSync ? 'full' : 'delta';
}

function buildStartUrl(mode) {
  if (mode === 'full') {
    console.log('🔄 MODE: Full sync — fetching all listings (deletions will be checked)');
    return `${PROPERTY_URL}?$top=100`;
  }

  // Delta: 4.5 hour lookback — 30 min overlap to never miss records
  const since = new Date(Date.now() - 4.5 * 60 * 60 * 1000).toISOString();
  console.log(`⚡ MODE: Delta sync — fetching records modified since ${since}`);
  return `${PROPERTY_URL}?$filter=ModificationTimestamp gt ${since}&$top=100`;
}

// =====================
// Live progress
// =====================
function showProgress(counters) {
  process.stdout.write(`\rFetched: ${counters.fetched} | Saved: ${counters.saved} | Deleted: ${counters.deleted}`);
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
// Save to grid
// No pre-check SELECT — upsert handles insert vs update internally
// =====================
async function savePropertiesToGrid(properties, counters) {
  for (let i = 0; i < properties.length; i += BATCH_SIZE) {
    const batch = properties.slice(i, i + BATCH_SIZE);

    const { error } = await supabase
      .from('grid')
      .upsert(batch, { onConflict: ['ListingKey'] });

    if (error) console.error('\nError saving batch:', error.message);
    else counters.saved += batch.length;

    showProgress(counters);
  }
}

// =====================
// Delete expired listings — only runs on full sync
// Paginated to avoid statement timeout
// =====================
async function deleteNonMatchingProperties(allFetchedKeys, counters) {
  if (allFetchedKeys.length === 0) {
    console.log('\n⚠️ No keys from DDF — skipping deletion');
    return;
  }

  console.log(`\nChecking for expired grid listings (${allFetchedKeys.length} DDF keys)...`);

  const latestSet = new Set(allFetchedKeys);
  const toDelete = [];
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('grid')
      .select('ListingKey')
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('\n⚠️ Error scanning grid — skipping deletion:', error.message);
      return;
    }

    if (!data || data.length === 0) { hasMore = false; break; }

    data.forEach(r => {
      if (!latestSet.has(r.ListingKey)) toDelete.push(r.ListingKey);
    });

    from += pageSize;
    hasMore = data.length === pageSize;
    process.stdout.write(`\rScanning grid for deletions... ${from} checked`);
  }

  if (toDelete.length === 0) {
    console.log('\nNo expired listings in grid.');
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
  console.log(`\n✅ Deleted ${deletedCount} expired grid listings`);
  showProgress(counters);
}

// =====================
// Main fetch and sync
// =====================
async function fetchAndProcessDDFProperties() {
  const counters = { fetched: 0, saved: 0, deleted: 0 };
  const mode = getSyncMode();
  const token = await getAccessToken();

  let nextLink = buildStartUrl(mode);
  const allFetchedKeys = [];

  while (nextLink) {
    try {
      const response = await fetch(nextLink, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await response.json();

      if (!data.value) {
        console.error('❌ Unexpected DDF response:', JSON.stringify(data, null, 2));
        throw new Error('Missing value array in DDF response');
      }

      const mapped = mapPropertiesForGrid(data.value);

      counters.fetched += mapped.length;
      allFetchedKeys.push(...mapped.map(p => p.ListingKey));

      await savePropertiesToGrid(mapped, counters);

      nextLink = data['@odata.nextLink'] || null;

    } catch (error) {
      console.error('\nFetch error:', error.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  // ✅ Only check deletions on full sync — delta won't have all keys
  if (mode === 'full' && allFetchedKeys.length > 0) {
    await deleteNonMatchingProperties(allFetchedKeys, counters);
  }

  console.log('\n✅ Grid sync complete');
  console.log(`Mode: ${mode.toUpperCase()} | Fetched: ${counters.fetched} | Saved: ${counters.saved} | Deleted: ${counters.deleted}`);
}

// =====================
// Entry point
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
