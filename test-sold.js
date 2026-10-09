// test-sold.js — one-off DDF sold-data availability probe.
// Zero dependencies (uses Node 18+ native fetch).
//
// Usage:
//   DDF_CLIENT_ID=xxx DDF_CLIENT_SECRET=yyy node test-sold.js
//
// Answers: does this DDF feed expose sold listings, and do they carry ClosePrice?

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const PROPERTY_URL = 'https://ddfapi.realtor.ca/odata/v1/Property';

const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing DDF_CLIENT_ID / DDF_CLIENT_SECRET environment variables');
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

async function probe(token, statusValue) {
  const filter = `StandardStatus eq '${statusValue}'`;
  const select = 'ListingKey,ListingId,StandardStatus,ListPrice,ClosePrice,CloseDate,City,UnparsedAddress,ModificationTimestamp,OriginatingSystemName';
  const url = `${PROPERTY_URL}?$filter=${encodeURIComponent(filter)}&$top=5&$select=${select}&$orderby=${encodeURIComponent('ModificationTimestamp desc')}`;
  console.log(`\nGET StandardStatus eq '${statusValue}'`);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  if (!res.ok) {
    console.error('  Probe failed:', res.status, JSON.stringify(data).slice(0, 500));
    return { rows: 0, withPrice: 0 };
  }
  const rows = data.value || [];
  console.log(`  -> ${rows.length} result(s)`);
  let withPrice = 0;
  for (const p of rows) {
    const hasPrice = p.ClosePrice != null;
    if (hasPrice) withPrice++;
    console.log('  ListingKey:      ', p.ListingKey);
    console.log('  ListingId:       ', p.ListingId);
    console.log('  StandardStatus:  ', p.StandardStatus);
    console.log('  ListPrice:       ', p.ListPrice);
    console.log('  ClosePrice:      ', p.ClosePrice);
    console.log('  CloseDate:       ', p.CloseDate);
    console.log('  City:            ', p.City);
    console.log('  UnparsedAddress: ', p.UnparsedAddress);
    console.log('  ---');
  }
  return { rows: rows.length, withPrice };
}

const token = await getAccessToken();
console.log('Token OK.');

const sold = await probe(token, 'Sold');
const closed = sold.rows ? { rows: 0, withPrice: 0 } : await probe(token, 'Closed');

const totalRows = sold.rows + closed.rows;
const totalPriced = sold.withPrice + closed.withPrice;

console.log('\n================ VERDICT ================');
if (!totalRows) {
  console.log('NO SOLD RECORDS in this DDF feed.');
  console.log('Your board does not share solds via DDF — keep the paste flow in the valuation builder.');
} else if (!totalPriced) {
  console.log(`Sold records exist (${totalRows} sampled) but ClosePrice is EMPTY.`);
  console.log('Status-only feed — not enough for auto sold comps. Keep the paste flow.');
} else {
  console.log(`SOLD DATA AVAILABLE: ${totalRows} sampled, ${totalPriced} with ClosePrice.`);
  console.log('Next step: extend the DDF sync to pull solds into the sold table,');
  console.log('then the valuation builder can auto-load sold comps.');
}
console.log('=========================================');
