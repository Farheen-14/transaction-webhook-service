# Transaction Webhook Service

A service that receives transaction webhooks from payment processors (like Razorpay), acknowledges each one with `202 Accepted` within milliseconds, and processes it reliably in the background. Each transaction is processed once, with a simulated 30-second external call, and none are lost if the server crashes.

**Live (AWS EC2 in Sydney, behind CloudFront):**

| What | URL |
| --- | --- |
| API (via CloudFront, recommended) | https://d2j1vpl9axgs7o.cloudfront.net |
| Health check | https://d2j1vpl9axgs7o.cloudfront.net/ |
| API (direct to the server) | https://3-107-153-148.sslip.io |
| Dashboard (React) | https://dashboard.3-107-153-148.sslip.io |
| Frontend repo | https://github.com/Farheen-14/fe-transaction-webhook-service |

> **Testing from far away?** The server is in Sydney, the only region the AWS Free plan allows. The API itself answers a webhook in a few milliseconds; most of the response time you see is network distance. Every response carries a `Server-Timing` header with the server's own time. See [Latency and the Sydney region](#latency-and-the-sydney-region).

Stack: **NestJS 12 + TypeORM** on Node.js 22+, with **MySQL/MariaDB** (or Postgres/Supabase via one env switch). The dashboard is React + Vite.

---

## API

| Method | Path | Response |
| --- | --- | --- |
| `POST` | `/v1/webhooks/transactions` | **202** `{ "acknowledged": true, "transaction_id": "...", "duplicate": false }` |
| `GET` | `/` | **200** `{ "status": "HEALTHY", "current_time": "...", "database": "UP" }` (**503** + `UNHEALTHY` if the DB is down) |
| `GET` | `/v1/transactions/:transaction_id` | `[ { transaction_id, source_account, destination_account, amount, currency, status, created_at, processed_at, attempts, last_error } ]`, or `[]` if the ID is unknown |
| `GET` | `/v1/transactions?limit=50` | Most recent transactions (extra endpoint, used by the dashboard) |

Webhook body:

```json
{
  "transaction_id": "txn_abc123def456",
  "source_account": "acc_user_789",
  "destination_account": "acc_merchant_456",
  "amount": 1500,
  "currency": "INR"
}
```

`status` goes from `PROCESSING` to `PROCESSED` about 30 s after the webhook. It becomes `FAILED` only after `WORKER_MAX_ATTEMPTS` failed attempts. Error responses:
- **400:** the body is invalid.
- **503:** the webhook could not be stored. The sender should retry, which is safe because ingestion is idempotent.

---

## How it works

```
Payment processor ──POST──▶ WebhooksController ──INSERT (UNIQUE transaction_id)──▶ transactions table
                                  │                                                    ▲
                                  └── 202 Accepted (~5 ms on the server)               │ claim (lease) → process → mark PROCESSED
                                                                                       │
                                                  TransactionProcessor (polls every 1 s, 30 s simulated external call)
```

1. **Respond fast, but only after the webhook is stored.** The request does one thing: an `INSERT` with `status = PROCESSING`. It replies `202` once that commits, so the response time doesn't depend on processing time. If the insert takes longer than 400 ms, the service answers `503` so the sender retries.
2. **The database enforces idempotency.** `transaction_id` has a `UNIQUE` constraint, so a repeated webhook (even 10 arriving at the same moment) fails the insert. That failure is reported as `duplicate: true`, still with `202`. No race conditions and no extra locks.
3. **The table doubles as a durable job queue.** The worker finds `PROCESSING` rows whose lease (`locked_until`) is empty or expired. It claims each one with a conditional `UPDATE ... WHERE <still due>`. Only one claimer can win that update, so running several instances is safe.
4. **No transaction is lost.**
    - If the process crashes mid-processing, the lease expires and another worker picks the row up again.
    - On a normal shutdown (SIGTERM), the worker releases its leases immediately.
    - The final `UPDATE ... WHERE status = 'PROCESSING'` means a transaction can be marked processed only once.
5. **Failures are retried with exponential backoff** (5 s, 10 s, 20 s, …). After `WORKER_MAX_ATTEMPTS` failures the row becomes `FAILED`, and the error message is kept in `last_error`.

### Technical choices

| Choice | Why |
| --- | --- |
| The database is the queue (no Redis, SQS or BullMQ) | The webhook and its job are written in the same `INSERT`, so they can never disagree ("saved but never queued" is impossible). It is also one less service to run. At much higher volume I'd move to SQS or BullMQ and keep the same idempotency key. |
| A `UNIQUE` constraint for idempotency | The database guarantees it atomically, even under concurrent duplicates. Application-level "check then insert" code has race conditions. |
| A lease (`locked_until`) instead of a boolean "locked" flag | A crashed worker can't hold a transaction forever. |
| `DECIMAL(18,2)` for money | Exact arithmetic, with no floating-point rounding. |
| Millisecond UTC timestamps | `processed_at - created_at` is exact, and the values don't depend on the server's timezone. |
| TypeORM with MySQL and Postgres | MySQL locally and on EC2, Supabase (Postgres) as a drop-in option. Switching only needs a change of `DB_TYPE`. |
| Config validated at startup | Invalid env values stop the app with a clear message instead of misbehaving later. |
| Processing is at-least-once, the final state is exactly-once | A real downstream API should receive `transaction_id` as its idempotency key. That covers the small window where the call succeeds but the process dies before writing `PROCESSED`. |

---

## Run locally

Requirements: **Node.js 22+** and **MySQL 8** (or any Postgres).

```bash
cp .env.example .env      # set DB_PASSWORD; the MySQL database is created automatically
npm install
npm run start:dev         # http://localhost:3000
```

To use Postgres or Supabase instead, set `DB_TYPE=postgres`, `DATABASE_URL=<Session pooler URI>` and `DB_SSL=true`. Every variable is documented in [.env.example](.env.example).

## Test it

**Automated end-to-end check of the success criteria.** It takes about 45 s, most of it spent waiting for the processing to finish:

```bash
npm run test:smoke                                                     # against localhost:3000
API_URL=https://d2j1vpl9axgs7o.cloudfront.net npm run test:smoke       # against the live deployment
```

It checks:
- the health endpoint
- a single webhook (`202` → `PROCESSING` → `PROCESSED` about 30 s later)
- 10 concurrent duplicates (exactly one row, `attempts = 1`)
- 50 concurrent webhooks, reported twice: **server-side** time (from the `Server-Timing` header) and **end-to-end** time from your machine, which includes the network
- input validation

**With curl** (`-i` shows the headers, including `Server-Timing`):

```bash
curl -i -X POST https://d2j1vpl9axgs7o.cloudfront.net/v1/webhooks/transactions \
  -H "Content-Type: application/json" \
  -d '{"transaction_id":"txn_demo_1","source_account":"acc_user_789","destination_account":"acc_merchant_456","amount":1500,"currency":"INR"}'

curl https://d2j1vpl9axgs7o.cloudfront.net/v1/transactions/txn_demo_1     # PROCESSING, then PROCESSED after ~30 s
```

**To see retries:** start the service with `SIMULATED_FAILURE_RATE=0.5`, then watch `attempts` and `last_error` change.

### Measured results

| Check | Result |
| --- | --- |
| Single webhook, time inside the API | ~5 ms |
| Locally, 50 concurrent webhooks (end-to-end) | max 198 ms, p50 161 ms |
| Processing time | 30.0 s |
| 10 concurrent duplicates | 1 row, processed once |
| Crash mid-processing, then restart | Picked up again after the lease expired, then `PROCESSED` |

---

## Latency and the Sydney region

**Short version:** the API answers webhooks in milliseconds. The extra time you see when calling it from India (or anywhere far from Australia) is network distance, not server work.

**Why Sydney:** the deployment uses an AWS **Free plan** account. A Free plan project is locked to one region, and this one was assigned **Asia Pacific (Sydney)**. Other regions such as Mumbai require upgrading to a paid plan.

**What the 500 ms requirement is about:** the webhook must be acknowledged *regardless of processing complexity*, so the 30-second processing must not run inside the request. The API only validates and inserts one row, then returns `202`. Processing happens later in the background worker.

**Where the time goes** for one webhook sent from India (approximate):

| Part | Time |
| --- | --- |
| Browser/laptop → nearest CloudFront edge (Delhi), incl. TLS | ~50–100 ms |
| CloudFront edge → EC2 in Sydney and back | ~250–300 ms per round trip (+1 round trip when a new connection is needed) |
| **Inside the API (validate + INSERT + 202)** | **~5 ms** |

**Measured from India:**

| Path | New connection | Reused connection |
| --- | --- | --- |
| Directly to Sydney (`3-107-153-148.sslip.io`) | ~1.6 s | ~0.4 s |
| Through CloudFront (`d2j1vpl9axgs7o.cloudfront.net`) | ~0.4–0.65 s | ~0.3 s |
| Time inside the API (`Server-Timing` header) | ~5 ms | ~5 ms |

**How to verify it yourself:**
- `curl -i` any endpoint and look at `Server-Timing: app;dur=…` (milliseconds spent in the API).
- Or open the browser DevTools → Network → select a request → **Timing**.
- The dashboard shows `total` and `server` time next to every webhook response.
- The smoke test prints both a server-side and an end-to-end line.

**What has been done to reduce it:**
- **CloudFront** in front of the API: the HTTPS connection ends at a nearby edge, and the long-distance part runs over AWS's network.
- **Keep-alive of 65 s** on the Node server: CloudFront can reuse its connections to Sydney instead of opening a new one for each request.

**What would remove it:** deploying in a region close to the callers, for example `ap-south-1` (Mumbai) for India, is expected to bring end-to-end times to about 100–200 ms. The code needs no change; only the EC2 instance moves.

---

## Deployment (AWS)

The deployment runs on a single **EC2 t3.micro** (Amazon Linux 2023, region ap-southeast-2) using the AWS Free plan credits:

| Component | How it runs |
| --- | --- |
| API | Node.js 22, kept alive by **pm2** (restarts on crash and on reboot) |
| Database | **MariaDB 10.5** on the same instance, bound to `127.0.0.1` only |
| HTTPS | **Caddy** reverse proxy with automatic Let's Encrypt certificates for `*.sslip.io` hostnames |
| Dashboard | Static build served by Caddy |
| CDN / edge | **CloudFront** distribution → EC2 port 3000 (caching disabled, all HTTP methods allowed) |
| Firewall | Security group open on 22 (SSH), 80/443 (HTTPS) and 3000 (CloudFront origin) |

To deploy a new version from a local checkout:

```bash
git archive --format=tar HEAD | ssh -i txn-key.pem ec2-user@<host> 'rm -rf ~/app.new && mkdir ~/app.new && tar -x -C ~/app.new'
ssh -i txn-key.pem ec2-user@<host> 'cd ~/app.new && npm ci && npm run build && cp ~/app/.env . && rm -rf ~/app.old && mv ~/app ~/app.old && mv ~/app.new ~/app && pm2 restart txn-api'
```

The `.env` file on the server holds the database password and is never committed. A [Dockerfile](Dockerfile) is also included for container platforms such as ECS or Elastic Beanstalk.

---

## Project structure

```
src/
  main.ts                                   bootstrap: env, CORS, validation, graceful shutdown
  config.ts                                 all env-based settings, validated at startup
  database.ts                               TypeORM options for MySQL / Postgres
  common/
    async.utils.ts                          sleep, withTimeout, errorMessage
    db-errors.ts                            unique-violation detection (MySQL + Postgres)
    server-timing.middleware.ts             adds Server-Timing header (time spent inside the API)
  health/health.controller.ts               GET /
  transactions/
    transaction.entity.ts                   table: UNIQUE(transaction_id), lease and timing columns
    dto/transaction-webhook.dto.ts          request validation
    dto/transaction-view.dto.ts             public JSON shape + mapper
    webhooks.controller.ts                  POST /v1/webhooks/transactions
    transactions.controller.ts              GET /v1/transactions[/:id]
    transactions.service.ts                 idempotent ingest + queries
    transaction-processor.service.ts        background worker (claim → process → complete/retry)
    transactions.module.ts
scripts/smoke-test.mjs                      end-to-end test of the success criteria
```

## What I'd add for production

- Webhook signature verification (for example Razorpay's `X-Razorpay-Signature`), so only the real processor can post.
- Versioned migrations instead of `DB_SYNC=true`.
- Unit tests for the service and worker. Today the end-to-end smoke test covers the behaviour.
- Metrics and alerts: queue depth, oldest `PROCESSING` age, `FAILED` count.
- Running the worker as its own process or service, so the API and processing scale independently.
