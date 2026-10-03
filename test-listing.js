// test-listing.js — one-off DDF lookup for a single listing.
// Zero dependencies (uses Node 18+ native fetch).
//
// Usage:
//   DDF_CLIENT_ID=xxx DDF_CLIENT_SECRET=yyy node test-listing.js X13810380
//
// Answers: is this listing in the DDF OData feed at all, and under what key?

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';

const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing DDF_CLIENT_ID / DDF_CLIENT_SECRET environment variables');
  process.exit(1);
}

const listingRef = process.argv[2];
if (!listingRef) {
  console.error('Usage: node test-listing.js <ListingId-or-ListingKey>');
  process.exit(1);
}

async function getAccessToken() {
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
  if (!res.ok) {
    console.error('Token request failed:', res.status, JSON.stringify(data).slice(0, 500));
    process.exit(1);
  }
  return data.access_token;
}

async function lookup(token, field, value) {
  const url = `${PROPERTY_URL}?$filter=${field} eq '${encodeURIComponent(value)}'&$top=5`;
  console.log(`\nGET ${field} eq '${value}'`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    console.error('  Lookup failed:', res.status, JSON.stringify(data).slice(0, 500));
    return;
  }
  const rows = data.value || [];
  console.log(`  -> ${rows.length} result(s)`);
  for (const p of rows) {
    console.log('  ListingKey:          ', p.ListingKey);
    console.log('  ListingId:           ', p.ListingId);
    console.log('  City:                ', p.Address?.City || p.City);
    console.log('  UnparsedAddress:     ', p.Address?.UnparsedAddress || p.UnparsedAddress);
    console.log('  ListPrice:           ', p.ListPrice);
    console.log('  TotalActualRent:     ', p.TotalActualRent);
    console.log('  StandardStatus:      ', p.StandardStatus);
    console.log('  ModificationTimestamp:', p.ModificationTimestamp);
    console.log('  OriginatingSystem:   ', p.OriginatingSystemName);
    console.log('  ListOfficeKey:       ', p.ListOfficeKey);
  }
}

const token = await getAccessToken();
console.log('Token OK.');
await lookup(token, 'ListingId', listingRef);
if (/^[A-Z]/i.test(listingRef)) {
  // MLS numbers are also usually the ListingKey in DDF — check both spellings
  await lookup(token, 'ListingKey', listingRef);
}
