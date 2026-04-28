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
    ModificationTimestamp: p.ModificationTimestamp
      ? new Date(p.ModificationTimestamp).toISOString()
      : null,
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

async function filterChanged(batch) {
  const keys = batch.map(p => p.ListingKey);

  const { data: existing, error } = await supabase
    .from('grid')
    .select('ListingKey, ModificationTimestamp')
    .in('ListingKey', keys);

  if (error) {
    console.error('\nDelta check error (upserting full batch as fallback):', JSON.stringify(error));
    return batch;
  }

  const existingMap = new Map(
    (existing || []).map(r => [
      r.ListingKey,
      r.ModificationTimestamp ? new Date(r.ModificationTimestamp).toISOString() : null
    ])
  );

  return batch.filter(p => {
    const storedTs = existingMap.get(p.ListingKey);
    return !storedTs || p.ModificationTimestamp !== storedTs;
  });
}

async function deleteRemovedFromGrid(allPropertyKeys, counters) {
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
      console.error('\nError fetching grid keys:', JSON.stringify(error));
      break;
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
  }

  if (toDelete.length === 0) {
    console.log('\nNothing to delete from grid.');
    return;
  }

  console.log(`\nDeleting ${toDelete.length} expired listings from grid...`);

  const chunkSize = 500;
  for (let i = 0; i < toDelete.length; i += chunkSize) {
    const chunk = toDelete.slice(i, i + chunkSize);
    const { error } = await supabase
      .from('grid')
      .delete()
      .in('ListingKey', chunk);

    if (error) {
      console.error(`\nDelete error:`, JSON.stringify(error));
    } else {
      counters.deleted += chunk.length;
    }

    await new Promise(r => setTimeout(r, 200));
    showProgress(counters);
  }
}

async function syncGridFromProperty() {
  const counters = { processed: 0, upserted: 0, skipped: 0, deleted: 0 };
  const allPropertyKeys = [];

  console.log('Reading from property table...');

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
      console.error('\nError reading property table:', JSON.stringify(error));
      break;
    }

    if (!rows || rows.length === 0) {
      hasMore = false;
      break;
    }

    const gridRows = rows.map(mapPropertyToGrid);
    allPropertyKeys.push(...gridRows.map(r => r.ListingKey));
    counters.processed += gridRows.length;

    const changed = await filterChanged(gridRows);
    counters.skipped += gridRows.length - changed.length;

    for (let i = 0; i < changed.length; i += BATCH_SIZE) {
      const chunk = changed.slice(i, i + BATCH_SIZE);

      const { error: upsertError } = await supabase
        .from('grid')
        .upsert(chunk, { onConflict: 'ListingKey' });

      if (upsertError) {
        console.error('\nGrid upsert error:', JSON.stringify(upsertError));
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

  await deleteRemovedFromGrid(allPropertyKeys, counters);

  console.log('\n\n✅ Grid sync complete');
  console.log(`Processed: ${counters.processed} | Upserted: ${counters.upserted} | Skipped: ${counters.skipped} | Deleted: ${counters.deleted}`);
}

(async function main() {
  try {
    console.log('Starting grid sync...');
    await syncGridFromProperty();
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error.message);
    process.exit(1);
  }
})();
