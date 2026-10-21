/**
 * End-to-end smoke test of the assignment's success criteria against a RUNNING service.
 *
 * Checks: health endpoint, single transaction (202 -> PROCESSING -> PROCESSED after ~30s),
 * duplicate prevention (10 concurrent identical webhooks -> one row, processed once),
 * performance (50 concurrent webhooks, each must answer in < 500ms), and input validation.
 *
 * Usage:
 *   node scripts/smoke-test.mjs                                   # http://localhost:3000
 *   API_URL=https://your-api.example.com node scripts/smoke-test.mjs
 *   WAIT_MS=40000  # how long to wait for background processing (default 40s)
 *
 * Exit code 0 = all checks passed, 1 = at least one failed (usable in CI).
 * Latency is reported twice: "server-side" (from the API's Server-Timing header) and
 * "end-to-end" (measured here, so it includes the network distance to the server).
 */
const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const WAIT_MS = Number(process.env.WAIT_MS ?? 40_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${msg}`);
  if (!ok) failures++;
};

async function call(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  // Time the API itself reported (Server-Timing: app;dur=4.8), separate from network time.
  const serverMs = Number(/dur=([\d.]+)/.exec(res.headers.get('server-timing') ?? '')?.[1] ?? NaN);
  return { status: res.status, ms, serverMs, body: text ? JSON.parse(text) : null };
}

/** "max 707ms, p50 644ms" for a list of durations. */
const summarize = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { max: sorted.at(-1), p50: sorted[Math.floor(sorted.length / 2)] };
};

const payload = (id) => ({
  transaction_id: id,
  source_account: 'acc_user_789',
  destination_account: 'acc_merchant_456',
  amount: 1500,
  currency: 'INR',
});

const run = Date.now().toString(36);
const single = `txn_smoke_single_${run}`;
const dup = `txn_smoke_dup_${run}`;

console.log(`Testing ${API}\n\n1. Health`);
const health = await call('GET', '/');
check(health.status === 200 && health.body.status === 'HEALTHY', `GET / -> ${JSON.stringify(health.body)}`);

console.log('\n2. Single transaction');
const r1 = await call('POST', '/v1/webhooks/transactions', payload(single));
check(
  r1.status === 202,
  `202 Accepted (got ${r1.status}) in ${r1.ms.toFixed(0)}ms` +
    (Number.isFinite(r1.serverMs) ? ` (server ${r1.serverMs.toFixed(1)}ms)` : ''),
);
const q1 = await call('GET', `/v1/transactions/${single}`);
check(q1.body[0]?.status === 'PROCESSING', `status right after webhook = ${q1.body[0]?.status}`);

console.log('\n3. Duplicate prevention (10 concurrent + 1 later)');
const dups = await Promise.all(Array.from({ length: 10 }, () => call('POST', '/v1/webhooks/transactions', payload(dup))));
check(dups.every((r) => r.status === 202), `all 10 duplicates answered 202`);
check(dups.filter((r) => !r.body.duplicate).length === 1, `exactly one accepted as new`);

console.log('\n4. Performance (50 concurrent different webhooks)');
const load = await Promise.all(
  Array.from({ length: 50 }, (_, i) => call('POST', '/v1/webhooks/transactions', payload(`txn_smoke_load_${run}_${i}`))),
);
check(load.every((r) => r.status === 202), 'all 50 answered 202');
// Two separate numbers, so a failure can be attributed correctly:
//  - server-side: time spent inside the API (from the Server-Timing header)
//  - end-to-end:  full round trip from this machine, including network distance to the server
const server = summarize(load.map((r) => r.serverMs));
const total = summarize(load.map((r) => r.ms));
if (Number.isFinite(server.max)) {
  check(server.max < 500, `server-side: max ${server.max.toFixed(1)}ms, p50 ${server.p50.toFixed(1)}ms (< 500ms)`);
} else {
  console.log('  INFO  no Server-Timing header (older server version?), skipping server-side check');
}
check(
  total.max < 500,
  `end-to-end from this machine (incl. network): max ${total.max.toFixed(0)}ms, p50 ${total.p50.toFixed(0)}ms (< 500ms)`,
);

console.log('\n5. Validation');
const bad = await call('POST', '/v1/webhooks/transactions', { transaction_id: 'x' });
check(bad.status === 400, `invalid body -> ${bad.status}`);

console.log(`\nWaiting ${WAIT_MS / 1000}s for background processing...`);
await sleep(WAIT_MS);

const s = (await call('GET', `/v1/transactions/${single}`)).body;
check(s.length === 1 && s[0].status === 'PROCESSED', `single: ${s[0]?.status}`);
const took = (Date.parse(s[0]?.processed_at) - Date.parse(s[0]?.created_at)) / 1000;
check(took >= 30 && took < 40, `processed ~30s after receipt (${took.toFixed(1)}s)`);

const d = (await call('GET', `/v1/transactions/${dup}`)).body;
check(d.length === 1 && d[0].status === 'PROCESSED' && d[0].attempts === 1, `duplicate: one row, processed once (attempts=${d[0]?.attempts})`);

const late = await call('POST', '/v1/webhooks/transactions', payload(dup));
check(late.status === 202 && late.body.duplicate, 'duplicate after processing -> 202, ignored');

const all = await Promise.all(load.map((_, i) => call('GET', `/v1/transactions/txn_smoke_load_${run}_${i}`)));
check(all.every((r) => r.body[0]?.status === 'PROCESSED'), 'all 50 load-test transactions processed');

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
