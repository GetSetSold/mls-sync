// test-ddf-listing.js — one-off diagnostic: ask DDF directly for a specific listing,
// by both ListingKey and ListingId, to see whether CREA is returning it at all.
// Run this in your GitHub Actions environment (or anywhere with network access to
// identity.crea.ca / ddfapi.realtor.ca) — it needs no Supabase access, read-only against DDF.
//
// Usage: node test-ddf-listing.js X13457322

import fetch from 'node-fetch';

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const CLIENT_ID = '***PURGED-DDF-CLIENT-ID***';
const CLIENT_SECRET = '***PURGED-DDF-CLIENT-SECRET***';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node test-ddf-listing.js <ListingKey-or-ListingId>');
  process.exit(1);
}

async function getToken() {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      scope: 'DDFApi_Read',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || 'token fetch failed');
  return data.access_token;
}

async function tryFilter(token, field, value) {
  const url = `${PROPERTY_URL}?$filter=${field} eq '${value}'`;
  console.log(`\nQuerying: ${field} eq '${value}'`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    console.log(`  HTTP ${res.status}:`, JSON.stringify(data).slice(0, 500));
    return;
  }
  if (!data.value || data.value.length === 0) {
    console.log('  -> Not found via this field.');
    return;
  }
  console.log(`  -> FOUND ${data.value.length} result(s):`);
  data.value.forEach(v => {
    console.log(`     ListingKey=${v.ListingKey} ListingId=${v.ListingId} ListOfficeKey=${v.ListOfficeKey} Status=${v.StandardStatus || v.MlsStatus || '(no status field captured)'} Address=${v.UnparsedAddress || v.Address?.UnparsedAddress}`);
  });
}

async function main() {
  const token = await getToken();
  console.log('Token acquired.');
  await tryFilter(token, 'ListingKey', target);
  await tryFilter(token, 'ListingId', target);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
