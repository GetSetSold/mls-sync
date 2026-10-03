// diag-scan.js — diagnose the DB key scan: page-by-page vs exact head count.
// Usage: SUPABASE_KEY=xxx node diag-scan.js   (run from the mls-sync repo dir)
import { createClient } from '@supabase/supabase-js';

const supabaseKey = process.env.SUPABASE_KEY;
if (!supabaseKey) throw new Error('Missing SUPABASE_KEY');
const supabase = createClient('https://nkjxlwuextxzpeohutxz.supabase.co', supabaseKey);

const BATCH = 1000;
let from = 0, total = 0, pages = 0;
const seen = new Set();
while (true) {
  const { data, error } = await supabase.from('property').select('ListingKey').range(from, from + BATCH - 1);
  if (error) { console.error(`ERROR at offset ${from}:`, error.message); break; }
  if (!data || data.length === 0) { console.log(`page ${pages}: offset ${from} -> empty, stopping`); break; }
  console.log(`page ${pages}: offset ${from} -> ${data.length} rows`);
  for (const r of data) seen.add(r.ListingKey);
  total += data.length;
  pages++;
  if (data.length < BATCH) break;
  from += BATCH;
  if (pages > 70) { console.log('SAFETY STOP at 70 pages'); break; }
}
console.log(`\nScanned rows: ${total}, pages: ${pages}, distinct keys: ${seen.size}`);

const { count, error: cErr } = await supabase.from('property').select('*', { count: 'exact', head: true });
console.log('Exact head count:', count, cErr ? `(${cErr.message})` : '');
console.log(total === count ? 'MATCH: scan is complete' : `MISMATCH: scan missed ${(count ?? 0) - total} rows`);
