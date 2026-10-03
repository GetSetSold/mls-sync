// test-replication.js — probe the DDF Replication endpoints.
// Zero dependencies (Node 18+ native fetch).
//
// Usage:
//   DDF_CLIENT_ID=xxx DDF_CLIENT_SECRET=yyy node test-replication.js [ListingKey]
//
// Steps:
//   1. Lists your DDF Destinations (to find your DestinationId).
//   2. Probes PropertyReplication() response shape ($top=3, dumps raw keys).
//   3. Searches the replication feed for the given ListingKey (default 30307659).

const TOKEN_URL = 'https://identity.crea.ca/connect/token';
const API = 'https://ddfapi.realtor.ca/odata/v1';

const CLIENT_ID = process.env.DDF_CLIENT_ID;
const CLIENT_SECRET = process.env.DDF_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing DDF_CLIENT_ID / DDF_CLIENT_SECRET environment variables');
  process.exit(1);
}
const targetKey = process.argv[2] || '30307659';

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
    console.error('Token request failed:', res.status, JSON.stringify(data).slice(0, 300));
    process.exit(1);
  }
  return data.access_token;
}

async function get(token, path, label) {
  console.log(`\n=== ${label}\nGET ${path}`);
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!res.ok || !data) {
    console.log(`  HTTP ${res.status} — ${text.slice(0, 300)}`);
    return null;
  }
  return data;
}

const token = await getAccessToken();
console.log('Token OK.');

// 1. Destinations
const dest = await get(token, '/Destination?$top=20', 'Your DDF destinations');
if (dest?.value) {
  for (const d of dest.value) {
    console.log(`  DestinationId=${d.DestinationId} Name="${d.DestinationName}" Url="${d.DestinationUrl}" Status=${d.DestinationStatus} Type=${d.DestinationType}`);
  }
  console.log(`  @odata.nextLink present: ${!!dest['@odata.nextLink']}`);
}

// 2. Replication shape probe
const rep = await get(token, '/Property/PropertyReplication()', 'PropertyReplication() shape probe');
if (rep?.value) {
  console.log(`  page items: ${rep.value.length}; keys of first item: ${Object.keys(rep.value[0] || {}).join(', ')}`);
  console.log('  First item raw:', JSON.stringify(rep.value[0]).slice(0, 400));
  console.log(`  @odata.nextLink present: ${!!rep['@odata.nextLink']}`);
  if (rep['@odata.count'] !== undefined) console.log(`  @odata.count: ${rep['@odata.count']}`);
  const keys = rep.value.map(r => r.ListingKey).filter(Boolean);
  console.log(`  target ${targetKey} on first page: ${keys.includes(targetKey) ? 'YES' : 'no'}`);
}

// 3. Is the missing listing in the replication feed?
const found = await get(token, `/Property/PropertyReplication()?$filter=ListingKey eq '${targetKey}'`, `Replication lookup ListingKey=${targetKey}`);
if (found?.value) {
  console.log(`  -> ${found.value.length} result(s)`);
  for (const r of found.value) console.log('  ', JSON.stringify(r).slice(0, 300));
}

// 4. Scoped variant (uses first destination id if we found one)
const firstId = dest?.value?.[0]?.DestinationId;
if (firstId) {
  const scoped = await get(token, `/Property/PropertyReplication(DestinationId=${firstId})?$filter=ListingKey eq '${targetKey}'`, `Scoped replication lookup (DestinationId=${firstId})`);
  if (scoped?.value) console.log(`  -> ${scoped.value.length} result(s)`);
} else {
  console.log('\nSkipping scoped variant — no DestinationId found.');
}
