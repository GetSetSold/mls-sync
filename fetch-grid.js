import { createClient } from '@supabase/supabase-js';

// ✅ URL hardcoded like original working file — env var caused silent {} errors
const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const BATCH_SIZE = 500;      // ✅ up from 100 — fewer DB round trips
const BATCH_DELAY_MS = 300;  // ✅ pause between batches to reduce Disk IO spikes
const PAGE_SIZE = 200;       // ✅ small pages — Media JSON is large, 1000 rows times out

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
  // ✅ Media intentionally NOT selected from property table — it's heavy JSON
  // that causes statement timeouts at scale. Photo URL is preserved in grid
  // from the initial full sync and only changes when PhotosChangeTimestamp updates.
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
    // Media not updated here — preserved from grid's existing value
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

  // Split into new vs existing
  const toInsert = batch.filter(p => !existingKeys.has(p.ListingKey));
  const toUpdate = batch.filter(p => existingKeys.has(p.ListingKey));

  counters.added += toInsert.length;
  counters.updated += toUpdate.length;

  // ✅ New rows — insert with Media as null (will be populated by fetch-property media sync)
  if (toInsert.length > 0) {
    const { error } = await supabase
      .from('grid')
      .insert(toInsert.map(p => ({ ...p, Media: null })));
    if (error) console.error('\nError inserting new grid rows:', error.message);
  }

  // ✅ Existing rows — update but exclude Media so photo URLs are preserved
  if (toUpdate.length > 0) {
    const { error } = await supabase
      .from('grid')
      .upsert(toUpdate, {
        onConflict: ['ListingKey'],
        ignoreDuplicates: false,
      });
    if (error) console.error('\nError updating grid rows:', error.message);
  }
}

// =====================
// Delete grid rows no longer in property table
// ✅ Paginated fetch — fixes statement timeout on 54K+ rows
// ✅ Safety guards — prevents accidental mass deletion
// =====================
async function deleteRemovedFromGrid(allPropertyKeys, counters) {
  // ✅ Safety guard — if nothing was read at all, skip deletion
  if (allPropertyKeys.length === 0) {
    console.log('\n⚠️ No property keys collected — skipping deletion');
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
  // Exception: if grid has fewer rows than property (recovery after wipe), allow full deletion
  const deletePercent = (toDelete.length / allPropertyKeys.length) * 100;
  const gridTotal = from; // from = total rows scanned in grid
  const gridIsSparse = gridTotal < allPropertyKeys.length * 0.5;

  if (deletePercent > 10 && !gridIsSparse) {
    console.log(`\n⚠️ ${toDelete.length} deletions (${deletePercent.toFixed(1)}%) seems too high — skipping`);
    console.log('If expected (e.g. board change), remove this guard temporarily and re-run.');
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
// Sync Media URLs only for rows that need it
// Reads Media from property only for new listings or photo count changes
// Avoids selecting Media for all 56K rows which causes timeout
// =====================
async function syncMediaForGrid() {
  console.log('\nSyncing Media URLs for new/changed listings...');

  let updated = 0;
  const pageSize = 200;
  let from = 0;
  let hasMore = true;

  while (hasMore) {
    // Find grid rows where Media is null (new listings)
    const { data: nullMediaRows, error: e1 } = await supabase
      .from('grid')
      .select('ListingKey')
      .is('Media', null)
      .range(from, from + pageSize - 1);

    if (e1) {
      console.error('\nError fetching null media rows:', e1.message);
      break;
    }

    if (!nullMediaRows || nullMediaRows.length === 0) {
      hasMore = false;
      break;
    }

    const keys = nullMediaRows.map(r => r.ListingKey);

    // Fetch Media from property table for just these keys
    const { data: propRows, error: e2 } = await supabase
      .from('property')
      .select('ListingKey, Media')
      .in('ListingKey', keys);

    if (e2) {
      console.error('\nError fetching media from property:', e2.message);
      break;
    }

    // Update grid with first photo URL
    for (const row of propRows || []) {
      let firstPhoto = null;
      if (Array.isArray(row.Media)) {
        const photo = row.Media.find(m => m.Order === 1);
        firstPhoto = photo?.MediaURL || null;
      }

      if (firstPhoto) {
        await supabase
          .from('grid')
          .update({ Media: firstPhoto })
          .eq('ListingKey', row.ListingKey);
        updated++;
      }
    }

    from += pageSize;
    hasMore = nullMediaRows.length === pageSize;
    process.stdout.write(`\rMedia synced: ${updated}`);
  }

  console.log(`\n✅ Media sync complete — updated ${updated} listings`);
}

// =====================
// No DDF fetch — avoids doubling API calls and IO
// =====================
async function syncGridFromProperty() {
  const counters = { processed: 0, added: 0, updated: 0, deleted: 0 };
  const allPropertyKeys = [];

  console.log('Reading from property table...');

  let from = 0;
  let hasMore = true;
  let consecutiveErrors = 0;

  while (hasMore) {
    const { data: rows, error } = await supabase
      .from('property')
      .select(`
        ListingKey, TotalActualRent, OriginalEntryTimestamp,
        ListPrice, PhotosCount,
        UnparsedAddress, City, UnitNumber, Province, PostalCode,
        Latitude, Longitude, ParkingTotal, BathroomsTotalInteger,
        BedroomsTotal, AboveGradeFinishedArea, StructureType
      `)
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      consecutiveErrors++;
      console.error(`\nError reading property table at offset ${from}:`, error.message);

      if (consecutiveErrors >= 3) {
        console.error('3 consecutive errors — stopping read');
        break;
      }

      // ✅ Wait and retry same page on timeout
      console.log('Retrying in 3 seconds...');
      await new Promise(r => setTimeout(r, 3000));
      continue; // retry same offset
    }

    consecutiveErrors = 0; // reset on success

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
    from += PAGE_SIZE;
    hasMore = rows.length === PAGE_SIZE;

    // ✅ Small pause between pages to avoid hammering DB
    await new Promise(r => setTimeout(r, 100));
  }

  await deleteRemovedFromGrid(allPropertyKeys, counters);
  await syncMediaForGrid();

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
