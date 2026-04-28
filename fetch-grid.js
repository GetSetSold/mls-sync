// grid-sync.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) throw new Error('Missing environment variables');

const supabase = createClient(supabaseUrl, supabaseKey);

const BATCH_SIZE = 500;
const BATCH_DELAY_MS = 300;

function showProgress(counters) {
  process.stdout.write(
    `\rProcessed: ${counters.processed} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`
  );
}

// =====================
// Map from property row → grid row
// No DDF fetch needed — data already in property table
// =====================
function mapPropertyToGrid(p) {
  // Extract first photo URL from Media array stored in property table
  let firstPhoto = null;
  if (Array.isArray(p.Media)) {
    const photo = p.Media.find(m => m.Order === 1);
    firstPhoto = photo?.MediaURL || null;
  }

  // StructureType stored as array in property — extract text
  let structureTypeText = null;
  if (Array.isArray(p.StructureType) && p.StructureType.length > 0) {
    structureTypeText = p.StructureType[0];
  } else if (typeof p.StructureType === 'string') {
    structureTypeText = p.StructureType;
  }

  return {
    ListingKey: p.ListingKey,
    ModificationTimestamp: p.ModificationTimestamp, // needed for delta checks
    TotalActualRent: p.TotalActualRent,
    OriginalEntryTimestamp: p.OriginalEntryTimestamp,
    ListPrice: p.ListPrice,
    PhotosCount: p.PhotosCount,
    Media: firstPhoto,
    UnparsedAddress: p.UnparsedAddress,
    City: p.City,
    UnitNumber: p.UnitNumber,
    Province: p.Province,
    PostalCode: p.PostalCode,
    Latitude: p.Latitude,
    Longitude: p.Longitude,
    ParkingTotal: p.ParkingTotal,
    BathroomsTotalInteger: p.BathroomsTotalInteger,
    BedroomsTotal: p.BedroomsTotal,
    AboveGradeFinishedArea: p.AboveGradeFinishedArea,
    StructureTypeText: structureTypeText,
  };
}

// =====================
// Delta check against grid table
// Only returns rows where ModificationTimestamp differs
// =====================
async function filterChanged(batch) {
  const keys = batch.map(p => p.ListingKey);

  const { data: existing } = await supabase
    .from('grid')
    .select('ListingKey, ModificationTimestamp')
    .in('ListingKey', keys);

  const existingMap = new Map(
    (existing || []).map(r => [r.ListingKey, r.ModificationTimestamp])
  );

  return batch.filter(p => {
    const existingTs = existingMap.get(p.ListingKey);
    return !existingTs || p.ModificationTimestamp !== existingTs;
  });
}

// =====================
// Delete grid rows no longer in property table
// =====================
async function deleteRemovedFromGrid(allPropertyKeys, counters) {
  console.log('\nChecking for removed grid listings...');

  const { data: existing } = await supabase
    .from('grid')
    .select('ListingKey');

  if (!existing?.length) return;

  const latestSet = new Set(allPropertyKeys);
  const toDelete = existing
    .map(r => r.ListingKey)
    .filter(key => !latestSet.has(key));

  if (!toDelete.length) {
    console.log('Nothing to delete from grid.');
    return;
  }

  console.log(`Deleting ${toDelete.length} removed listings from grid...`);

  const chunkSize = 500;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('grid')
      .delete()
      .in('ListingKey', chunk);

    if (error) console.error(`Delete error at chunk ${i}:`, error.message);
    else counters.deleted += chunk.length;

    await new Promise(r => setTimeout(r, 200));
  }
}

// =====================
// Main sync — reads from property table, writes to grid
// =====================
async function syncGridFromProperty() {
  const counters = { processed: 0, upserted: 0, skipped: 0, deleted: 0 };
  const allPropertyKeys = [];

  console.log('Reading from property table...');

  // Paginate through property table in batches
  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase
      .from('property')
      .select(`
        ListingKey, ModificationTimestamp, TotalActualRent,
        OriginalEntryTimestamp, ListPrice, PhotosCount, Media,
        UnparsedAddress, City, UnitNumber, Province, PostalCode,
        Latitude, Longitude, ParkingTotal, BathroomsTotalInteger,
        BedroomsTotal, AboveGradeFinishedArea, StructureType
      `)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('Error reading property table:', error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    const gridRows = rows.map(mapPropertyToGrid);
    allPropertyKeys.push(...gridRows.map(r => r.ListingKey));
    counters.processed += gridRows.length;

    // Delta check — only write what changed
    const changed = await filterChanged(gridRows);
    counters.skipped += gridRows.length - changed.length;

    // Write in batches with delay
    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      const chunk = changed.slice(i, i + BATCH_SIZE);
      const { error: upsertError } = await supabase
        .from('grid')
        .upsert(chunk, { onConflict: 'ListingKey' });

      if (upsertError) {
        console.error('Upsert error:', upsertError.message);
      } else {
        counters.upserted += chunk.length;
      }

      if (i + BATCH_SIZE < changed.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    showProgress(counters);
    from += pageSize;
    hasMore = rows.length === pageSize;
  }

  // Clean up stale grid rows
  await deleteRemovedFromGrid(allPropertyKeys, counters);

  console.log('\n\n✅ Grid sync complete');
  console.log(`Processed: ${counters.processed} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`);
}

// =====================
// Entry point
// =====================
(async function main() {
  try {
    console.log('Starting grid sync from property table...');
    await syncGridFromProperty();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
