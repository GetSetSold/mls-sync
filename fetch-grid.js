import { createClient } from '@supabase/supabase-js';

// ✅ URL hardcoded like original working file — env var caused silent {} errors
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const BATCH_SIZE = 500;      // ✅ up from 100 — fewer DB round trips
const BATCH_DELAY_MS = 300;  // ✅ pause between batches to reduce Disk IO spikes

// =====================
// Live progress
// =====================
function showProgress(counters) {
  process.stdout.write(`\rProcessed: ${counters.processed} | Added: ${counters.added} | Updated: ${counters.updated} | Deleted: ${counters.deleted}`);
}

// =====================
// Map from property row → grid row
// Reads from property table — no second DDF fetch needed
// =====================
function mapPropertyToGrid(p) {
  let firstPhoto = null;
  if (Array.isArray(p.Media)) {
    const photo = p.Media.find(m => m.Order === 1);
    firstPhoto = photo?.MediaURL || null;
  }

  let structureTypeText = null;
  if (Array.isArray(p.StructureType) && p.StructureType.length > 0) {
    structureTypeText = p.StructureType[0];
  } else if (typeof p.StructureType === 'string') {
    structureTypeText = p.StructureType;
  }

  return {
    ListingKey: p.ListingKey,
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
// Save grid batch — same working upsert pattern as property sync
// =====================
async function saveToGrid(batch, counters) {
  const keys = batch.map(p => p.ListingKey);

  const { data: existingData } = await supabase
    .from('grid')
    .select('ListingKey')
    .in('ListingKey', keys);

  const existingKeys = new Set(existingData?.map(p => p.ListingKey) || []);
  batch.forEach(p => existingKeys.has(p.ListingKey) ? counters.updated++ : counters.added++);

  // ✅ Exact same working upsert pattern as original
  const { error } = await supabase
    .from('grid')
    .upsert(batch, { onConflict: ['ListingKey'] });

  if (error) console.error('\nError saving grid batch:', error.message);
}

// =====================
// Delete grid rows no longer in property table
// ✅ Paginated fetch — fixes statement timeout on 54K+ rows
// ✅ Safety guards — prevents accidental mass deletion
// =====================
async function deleteRemovedFromGrid(allPropertyKeys, counters) {
  // ✅ Safety guard — if property read was incomplete, skip deletion
  if (allPropertyKeys.length < 50000) {
    console.log(`\n⚠️ Only ${allPropertyKeys.length} property keys read — skipping deletion as safety measure`);
    return;
  }

  console.log('\nFetching grid keys for deletion check (paginated)...');

  const latestSet = new Set(allPropertyKeys);
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
      // ✅ Abort deletion on any read error — never delete on uncertainty
      console.error('\n⚠️ Error fetching grid keys — skipping deletion to be safe:', error.message);
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
    process.stdout.write(`\rScanned ${from} grid records...`);
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete from grid.');
    return;
  }

  // ✅ Safety guard — never delete more than 10% in one run
  const deletePercent = (toDelete.length / allPropertyKeys.length) * 100;
  if (deletePercent > 10) {
    console.log(`\n⚠️ ${toDelete.length} deletions (${deletePercent.toFixed(1)}%) seems too high — skipping`);
    console.log('If expected (e.g. after grid was wiped), remove this guard temporarily and re-run.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired listings from grid...`);

  const chunkSize = 500;
  let deletedCount = 0;

  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('grid')
      .delete()
      .in('ListingKey', chunk);

    if (error) {
      console.error('\nDelete error — stopping deletion:', error.message);
      return; // ✅ stop on first error
    }

    deletedCount += chunk.length;
    await new Promise(r => setTimeout(r, 200));
  }

  counters.deleted = deletedCount;
  console.log(`\n✅ Deleted ${deletedCount} expired grid listings`);
  showProgress(counters);
}

// =====================
// Main sync — reads from property table, writes to grid
// No DDF fetch — avoids doubling API calls and IO
// =====================
async function syncGridFromProperty() {
  const counters = { processed: 0, added: 0, updated: 0, deleted: 0 };
  const allPropertyKeys = [];

  console.log('Reading from property table...');

  const pageSize = 1000;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    const { data: rows, error } = await supabase
      .from('property')
      .select(`
        ListingKey, TotalActualRent, OriginalEntryTimestamp,
        ListPrice, PhotosCount, Media,
        UnparsedAddress, City, UnitNumber, Province, PostalCode,
        Latitude, Longitude, ParkingTotal, BathroomsTotalInteger,
        BedroomsTotal, AboveGradeFinishedArea, StructureType
      `)
      .range(from, from + pageSize - 1);

    if (error) {
      console.error('\nError reading property table:', error.message);
      break;
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    const gridRows = rows.map(mapPropertyToGrid);
    allPropertyKeys.push(...gridRows.map(r => r.ListingKey));
    counters.processed += gridRows.length;

    // Write in batches with delay
    for (let i = 0; i < gridRows.length; i += BATCH_SIZE) {
      const chunk = gridRows.slice(i, i + BATCH_SIZE);
      await saveToGrid(chunk, counters);

      if (i + BATCH_SIZE < gridRows.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    showProgress(counters);
    from += pageSize;
    hasMore = rows.length === pageSize;
  }

  await deleteRemovedFromGrid(allPropertyKeys, counters);

  console.log('\n\n✅ Grid sync complete');
  console.log(`Final counts → Processed: ${counters.processed} | Added: ${counters.added} | Updated: ${counters.updated} | Deleted: ${counters.deleted}`);
}

// =====================
// Main
// =====================
(async function main() {
  try {
    console.log('Starting grid sync from property table...');
    await syncGridFromProperty();
    console.log('Sync complete. Exiting process.');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
