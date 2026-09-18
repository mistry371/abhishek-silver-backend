# Abhishek Silver — Backend API

Node.js REST API for the **Abhishek Silver** jewellery platform: the customer storefront and the admin panel.

- **Express 5 + TypeScript**, **Zod** validation, **Drizzle ORM**
- **PostgreSQL on Supabase** in production — **embedded PGlite** (real PostgreSQL, in-process) for local development, so nothing needs installing
- **Supabase Auth** (email/password + mobile OTP) — with a local development provider that issues Supabase-shaped tokens until the Supabase project exists
- **Supabase Storage** for product media and private receipts (local disk in development)
- **Razorpay** payments with server-side signature and webhook verification (a demo gateway in development)

The backend is the single source of truth for prices, stock, coupons, payments, orders and invoices. Customer-facing responses never include purchase price, supplier data, margins, valuation or stock quantities.

---

## Quick start (local)

```bash
npm install
cp .env.example .env        # then set LOCAL_JWT_SECRET to a long random string
npm run dev                 # http://localhost:4000 — migrates and seeds the local database on first run
```

Point the storefront at it with `NEXT_PUBLIC_API_BASE_URL=http://localhost:4000/v1` (and keep `CORS_ORIGINS=http://localhost:3000`).

### Development accounts (local auth provider only)

| Who | Sign-in | Password |
| --- | --- | --- |
| Demo customer | `demo@example.com` or mobile `9000000000` | `Demo@1234` |
| Super Admin | `superadmin@example.com` | `SEED_ADMIN_PASSWORD` (default `Admin@12345`) |
| Inventory Manager | `inventory@example.com` | same |
| Sales Manager | `sales@example.com` | same |
| Content Manager | `content@example.com` | same |

Mobile OTP in local mode returns the code in the API response (`demoCode`) instead of sending an SMS. Demo coupons: `WELCOME5`, `FESTIVE2000`, `SILVER10`. The demo payment gateway accepts the signature `demo_valid_signature`.

These accounts, the demo catalogue and the demo metal rates exist **only for development**. They are never created with `--essentials` or with Supabase Auth.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start with live reload |
| `npm run build` / `npm start` | Production build (`dist/`) and start |
| `npm run typecheck` | TypeScript check |
| `npm test` | Unit + API tests (in-memory PostgreSQL) |
| `npm run db:generate` | Generate a migration after changing `src/db/schema` |
| `npm run db:migrate` | Apply migrations (and enable RLS on Supabase) |
| `npm run db:seed` | Seed essentials + demo data · `-- --essentials` for roles, settings and store content only |
| `npm run db:reset` | Recreate the **local** PGlite database |
| `npm run admin:create` | Create or link an admin account (see below) |

> PGlite is single-process: stop `npm run dev` before running `db:seed` or `db:reset` against the local database.

---

## Deploy on Render (Blueprint)

1. Supabase: create the project and two Storage buckets — `media` (public) and `private-documents` (private).
2. Render → **New → Blueprint** → choose this repository. Fill in the values it asks for (see comments in `render.yaml`).
3. Deploy. On start the API creates the tables, roles, settings and store content, and your first Super Admin from
   `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD`.
4. The site can launch with `PAYMENT_PROVIDER=none` (browsing, enquiries and WhatsApp; checkout explains online payment
   isn't available yet). Add the Razorpay keys and switch to `razorpay` when ready.

Free Render services sleep when idle, so the first request after a quiet period can take up to a minute.

## Instagram feed on the homepage

Set `INSTAGRAM_ACCESS_TOKEN` on Render to show the latest posts and reels automatically:

1. The Instagram account must be a **Business** or **Creator** account (Instagram app → Settings → Account type and tools).
2. At [developers.facebook.com](https://developers.facebook.com) create an app (type **Business**) and add the **Instagram** product.
3. Under **API setup with Instagram login**, add the account and click **Generate token**.
4. Paste the token into `INSTAGRAM_ACCESS_TOKEN` on Render and deploy.

Posts refresh every 15 minutes and the token is renewed weekly, so it never needs pasting again. `GET /health?deep=1` reports `instagram: ok — N latest posts` when it works. Without a token, or while Instagram is unreachable, the homepage shows the posts from **Admin → Content → Instagram**.

## Going live on Supabase

1. **Create a Supabase project** (region close to Gujarat, e.g. Mumbai).
2. **Database** — copy the connection string (Project Settings → Database) into `DATABASE_URL`.
3. **Auth** — set `AUTH_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. Projects still on the legacy JWT secret also need `SUPABASE_JWT_SECRET`; projects with signing keys are verified automatically via JWKS. Enable the **Phone** provider with an SMS partner for OTP sign-in.
4. **Storage** — create a **public** bucket `media` and a **private** bucket `private-documents`, then set `STORAGE_PROVIDER=supabase`.
5. **Migrate and seed essentials**
   ```bash
   npm run db:migrate
   npm run db:seed -- --essentials
   ```
   Migrations enable row-level security on every table, so Supabase's Data API cannot read them with the anon key — all access goes through this API.
6. **First Super Admin** — the password is read from an environment variable and never printed or stored here:
   ```bash
   ADMIN_PASSWORD='choose-a-strong-password' npm run admin:create -- --email owner@example.com --name "Owner"
   ```
   Or create the user in the Supabase dashboard and link it with `--auth-user-id <uuid>`.
7. **Metal rates** — sign in to the admin panel and set today's rates in **Pricing** before activating products.
8. **Razorpay** — set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET`; add the webhook `https://<api-domain>/v1/webhooks/razorpay` for `payment.captured`, `order.paid` and `payment.failed`.
9. **Production settings** — `NODE_ENV=production`, `PUBLIC_API_URL`, `PUBLIC_SITE_URL`, `CORS_ORIGINS`, and `TRUST_PROXY=true` behind a proxy. The API refuses to start in production with local auth, the demo gateway or without `DATABASE_URL`.

Optionally set `STOREFRONT_REVALIDATE_URL` and `STOREFRONT_REVALIDATE_SECRET` so admin changes purge the storefront cache immediately (otherwise pages refresh within a few minutes).

---

## Architecture

```
src/
  app.ts, server.ts         Express app and startup
  config/env.ts             Validated environment (never logs values)
  auth/                     Supabase + local providers, RBAC permission catalogue
  db/                       Drizzle schema, connection (PGlite ⇄ Postgres), migrations, seed
  http/                     Auth middleware, rate limiting, error handling
  modules/
    catalog/                Customer-safe catalogue snapshot, filters, facets, search
    cart/ orders/           Server-priced quotes, checkout, payments, webhooks
    account/ leads/         Customer auth, profile, addresses, wishlist, enquiries, newsletter
    content/                Public CMS endpoints
    pricing/                Price engine and pricing context (rates, GST, offers)
    admin/                  Admin panel API (one file per module)
  services/                 Stock ledger, billing, audit, notifications, storage, settings, numbering
tests/                      Price engine, allocation and end-to-end API tests
```

### Key rules the code enforces

- **Price** = metal rate (for purity) × net weight + making + stone + other − discount + GST, rounded to whole rupees exactly like the storefront reference engine. The customer gets the best of the product discount and running offer discounts. Prices are snapshotted on every order line.
- **Stock** only changes through the stock ledger: rows are locked, negative stock is rejected, every movement is immutable with before/after quantities, manual changes need a reason, and a stale form returns `409 conflict`.
- **Online orders** deduct stock, count coupon use, and create a sale and a paid GST invoice only after the payment signature is verified — idempotently, so the browser callback and the webhook can both arrive.
- **Invoices** get backend-generated numbers consecutive within the Indian financial year (`INV-2627-00001`). Issued invoices are locked; totals are always computed server-side.
- **Purchases** reach inventory only on approval. **Expenses** follow Draft → Submitted → Approved/Rejected → Paid.
- **Audit log** records every admin mutation with actor, time, before/after and reason; sensitive actions are flagged.
- **Bulk imports** accept .xlsx and .csv files (type verified from the bytes, 5 MB and 2,000 rows at most), preview every row without writing, and commit only a file with no errors — in one transaction, with one audit entry per import.

### Roles

Default roles follow the documentation's Role & Permission Matrix: **Super Admin**, **Inventory Manager**, **Sales Manager** and **Content Manager**. Permissions are fine-grained (e.g. `inventory:adjust`, `products:view_confidential`, `billing:issue`, `expenses:approve`) and editable in **Settings → Roles**. The Super Admin role always holds every permission, and the last active Super Admin can't be removed.

---

## API overview

All routes are under `/v1`. Errors return `{ code, message, fieldErrors? }`.

**Storefront** — `GET /products`, `/products/:slug`, `/products/slugs`, `/products/merchandising`, `/products/:id/related`, `/products/:id/price`, `/products/compare`, `/search/suggestions`, `/categories[/:slug]`, `/collections[/:slug]` · `POST /cart/quote`, `GET|POST|PATCH|DELETE /cart…` · `POST /orders`, `/orders/:id/payments/verify`, `/orders/:id/payments/failed`, `GET /orders[/:id]` · `POST /auth/login|register|otp/request|otp/verify|refresh|password/forgot|logout` · `GET|PATCH /me`, `/me/password`, `/me/addresses`, `/me/enquiries`, `/wishlist…` · `POST /enquiries`, `/newsletter` · `GET /content/homepage|about|testimonials|instagram|trust|social|faqs|store|policies/:slug`, `/blog[/:slug]`, `/offers` · `POST /webhooks/razorpay`

**Admin** (`/v1/admin`, bearer token + permission per route) — `auth/login|refresh|me|logout`, `dashboard`, `search`, `notifications`, `customers` (+ Customer 360, addresses, notes), `products` (+ bulk), `categories`, `subcategories`, `collections`, `media`, `inventory` (+ summary, lookup, movements), `locations`, `vendors`, `purchases` (+ submit/approve/cancel), `orders` (+ status, notes, communications, returns, refunds), `returns`, `refunds`, `billing/summary`, `invoices` (+ issue, payments, cancel), `sales` (+ quote), `expenses` (+ summary, submit/approve/reject/mark-paid, attachments), `expense-categories`, `recurring-expenses`, `pricing` (+ rates, gst, making-defaults, charge-rates, preview, history), `coupons`, `offers`, `content/:key`, `content/policies`, `testimonials`, `faqs`, `blog-posts`, `enquiries` (+ notes, contacts, assignees), `reports/:type` (+ CSV export), `settings`, `users`, `roles`, `audit-logs`, `profile`, `imports` (+ `imports/:entity/template`, preview and commit uploads).

---

## To confirm with the business

These are configurable and marked in the code; they are not assumptions presented as facts.

- GST rate (seeded at 3% for jewellery), shipping fee (0), max quantity per line (5), guest checkout — **Settings / Pricing**
- Legal name, GSTIN and invoice address printed on invoices — **Settings → General**
- Invoice number prefix — **Settings → Billing**
- Expense approvals and tax fields on expenses — **Settings → Expenses**
- Real metal rates (the seed uses illustrative demo values) — **Pricing**
- Phone numbers, WhatsApp number, store hours, email — **Content → Contact**
- Shipping, returns, privacy and terms policies (currently placeholders) — **Content → Policies**
- Whether customer email addresses must be confirmed before sign-in (not enforced by default)
