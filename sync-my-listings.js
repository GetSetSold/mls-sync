// sync-my-listings.js — pulls Rohit's own office listings (ListOfficeKey 291890) from the
// already-synced `property` table into `sold`, alongside manually-entered rows.
//
// Run this AFTER ddf-sync.js in the same cron job (it reads from `property`, not DDF directly,
// so it needs property to already be up to date).
//
// Safety: only ever touches rows where source = 'ddf_sync' (matched by listing_key). Manual
// rows (source = 'manual', listing_key = null) are never selected, updated, or deleted by this
// script — insert those by hand (SQL editor, or your future CRM admin) and they're left alone.
//
// Limitation to know about: DDF's public feed only exposes ACTIVE listings — there is no
// "sold price" field available here, so these rows reflect the CURRENT list price, not a
// final sale price. If you want true sold prices/dates, those have to be entered manually
// (source = 'manual') since DDF doesn't provide them. Once a listing sells and drops out of
// the active DDF feed, this script's cleanup step (below) marks the ddf_sync row status as
// 'Off Market' rather than deleting it — deciding "sold" vs "expired" vs "withdrawn" can't be
// inferred from DDF alone, so treat that status as "no longer active" and edit it by hand if
// you know it actually sold.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://nkjxlwuextxzpeohutxz.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY environment variable');

const supabase = createClient(supabaseUrl, supabaseKey);

const MY_OFFICE_KEY = '291890';

function firstPhotoUrl(media) {
  if (!Array.isArray(media)) return null;
  const photo = media.find(m => m.Order === 1) || media[0];
  return photo?.MediaURL || null;
}

async function main() {
  console.log(`Syncing office ${MY_OFFICE_KEY} listings from property -> sold...`);

  const { data: myListings, error } = await supabase
    .from('property')
    .select('ListingKey, ListPrice, UnparsedAddress, City, BedroomsTotal, BathroomsTotalInteger, ParkingTotal, LivingArea, AboveGradeFinishedArea, Media, ListingURL')
    .eq('ListOfficeKey', MY_OFFICE_KEY);

  if (error) throw new Error(`Failed to read property: ${error.message}`);
  console.log(`  Found ${myListings.length} active listing(s) for this office.`);

  const rows = myListings.map(p => ({
    listing_key: p.ListingKey,
    source: 'ddf_sync',
    status: 'Active',
    price: p.ListPrice,
    listed_price: p.ListPrice,
    address: [p.UnparsedAddress, p.City].filter(Boolean).join(', '),
    image_url: firstPhotoUrl(p.Media),
    link: p.ListingURL,
    bed: p.BedroomsTotal != null ? String(p.BedroomsTotal) : null,
    bath: p.BathroomsTotalInteger != null ? String(p.BathroomsTotalInteger) : null,
    parking: p.ParkingTotal != null ? String(p.ParkingTotal) : null,
    sqft: (p.LivingArea ?? p.AboveGradeFinishedArea) != null
      ? String(p.LivingArea ?? p.AboveGradeFinishedArea)
      : null,
  }));

  if (rows.length > 0) {
    const { error: upsertErr } = await supabase
      .from('sold')
      .upsert(rows, { onConflict: 'listing_key' });
    if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
    console.log(`  Upserted ${rows.length} row(s) into sold.`);
  }

  // Mark previously-synced rows that are no longer active for this office as 'Off Market'
  // instead of deleting them — deletion would destroy the record entirely, and we can't tell
  // sold vs. withdrawn vs. expired from the DDF feed alone.
  const currentKeys = rows.map(r => r.listing_key);
  const { data: staleRows, error: staleErr } = await supabase
    .from('sold')
    .select('id, listing_key, status')
    .eq('source', 'ddf_sync')
    .not('status', 'eq', 'Off Market');

  if (staleErr) throw new Error(`Failed to check stale rows: ${staleErr.message}`);

  const toMarkOffMarket = (staleRows || [])
    .filter(r => !currentKeys.includes(r.listing_key))
    .map(r => r.id);

  if (toMarkOffMarket.length > 0) {
    const { error: updateErr } = await supabase
      .from('sold')
      .update({ status: 'Off Market' })
      .in('id', toMarkOffMarket);
    if (updateErr) throw new Error(`Failed to mark off-market: ${updateErr.message}`);
    console.log(`  Marked ${toMarkOffMarket.length} row(s) as Off Market (no longer active in DDF for this office — check manually if they sold).`);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
