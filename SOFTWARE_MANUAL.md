# DoorStep TN Software Manual

This manual is for engineers inheriting the codebase. It explains:

- how to run and operate the system
- where APIs are defined
- what each backend/frontend/android module is responsible for
- how authentication, CSRF, roles, ownership, and worker permissions interact
- how location filters, profile clearing, cache invalidation, and mutation
  validation work
- how to safely extend features without reintroducing 400/403/404 regressions

Use together with:

- `README.md` (setup/deploy quick path)
- `doorstep-android/README.md` (native Android build/release guide)

The manual describes the current implementation, not an invitation to remove
server-side safeguards. If the UI flow is inconvenient, fix the client state,
validation message, or authorization context; do not make a protected route
public.

## 1. System Overview

DoorStep TN is a multi-role commerce platform:

- customer shopping and service booking
- shop and worker operations
- provider workflows
- admin operations

Main runtime pieces:

- API server: `server/` (Express + TypeScript)
- Web app: `client/src/` (React + Vite)
- Shared contracts/schema: `shared/`
- Native Android app: `doorstep-android/`

## 2. Backend Runtime Manual

## 2.1 Startup Sequence (exact flow)

1. `server/index.ts` loads env + network config.
2. CORS origins are resolved and validated.
3. Express middleware is mounted (security headers, parsers, docs).
4. `registerRoutes(app)` from `server/routes.ts` is invoked.
5. `registerRoutes` calls auth setup and business route registration.
6. Scheduled jobs and BullMQ worker are initialized (`jobQueue`, `jobs/*`).
7. Default admin bootstrap runs (`ensureDefaultAdmin`).
8. Admin routes are mounted under `/api/admin`.
9. Static frontend serving is mounted from `dist/public` unless disabled.
10. Health/readiness endpoints and error handlers are active.

## 2.2 Request Lifecycle

1. Incoming request gets request context/tracing metadata.
2. CORS, security headers, and body parsing apply.
3. Session middleware + Passport auth state resolve user.
4. CSRF validation applies for state-changing API routes.
5. Route-level auth/role/worker-permission middleware runs.
6. Storage layer (`storage` abstraction) performs DB/cache operations.
7. Realtime invalidation/push jobs may be queued.
8. Response is serialized; metrics and logs are recorded.

## 2.3 Backend Source Map (What Each File Does)

### 2.3.1 Core bootstrap (`server/`)

- `server/index.ts`: app bootstrap, middleware, health/readiness, startup/shutdown orchestration.
- `server/routes.ts`: main API domain routes (orders/bookings/products/services/reviews/etc).
- `server/auth.ts`: session config, Passport strategy, auth and profile-creation routes.
- `server/bootstrap.ts`: default admin/permissions bootstrap on startup.
- `server/db.ts`: PostgreSQL clients, pool config, connection testing.
- `server/storage.ts`: `IStorage` interface (contract for all persistence operations).
- `server/pg-storage.ts`: PostgreSQL-backed `IStorage` implementation.
- `server/logger.ts`: pino logger setup + request log context integration.
- `server/requestContext.ts`: AsyncLocalStorage request context (requestId, trace IDs, log context).
- `server/tracing.ts`: trace/correlation parsing + traceparent generation.
- `server/swagger.ts`: OpenAPI generation config for `/api/docs`.
- `server/vite.ts`: optional Vite dev middleware/static serving helpers.
- `server/ist-utils.ts`: India-time utility wrappers used in server logic.
- `server/workerAuth.ts`: shared middleware/helpers for shop-worker permission checks.

### 2.3.2 Route modules (`server/routes/`)

- `server/routes/admin.ts`: admin auth, dashboard, logs, transactions, roles/accounts, moderation tools.
- `server/routes/promotions.ts`: promotion CRUD/validation/apply/status and worker/shop permission checks.
- `server/routes/workers.ts`: shop worker CRUD and worker capability management.
- `server/routes/bookings.ts`: small router namespace (main booking business logic remains in `routes.ts`).
- `server/routes/orders.ts`: small router namespace (main order business logic remains in `routes.ts`).

### 2.3.3 Jobs/queues/realtime

- `server/jobQueue.ts`: BullMQ queue/worker registration and generic job framework.
- `server/queue/connection.ts`: BullMQ Redis connection.
- `server/jobs/bookingExpirationJob.ts`: scheduled booking expiration processing.
- `server/jobs/paymentReminderJob.ts`: payment reminder/dispute window checks.
- `server/jobs/lowStockDigestJob.ts`: low-stock scan and digest dispatch logic.
- `server/jobs/pushNotificationDispatchJob.ts`: queued push-notification dispatch payload handling.
- `server/realtime.ts`: SSE connection management and invalidation broadcasts.

### 2.3.4 Security and validation (`server/security/`)

- `server/security/csrfProtection.ts`: CSRF token middleware and validation.
- `server/security/rateLimiters.ts`: auth/admin/sensitive endpoint rate-limit definitions.
- `server/security/roleAccess.ts`: shared role resolution helpers (`shop/provider/worker/admin`).
- `server/security/sanitizeUser.ts`: sensitive field stripping for user payloads.
- `server/security/secretValidators.ts`: secret strength validation for env credentials.

### 2.3.5 Services and infra adapters (`server/services/`)

- `server/services/cache.service.ts`: cache access wrapper used by business flows.
- `server/services/sessionStore.service.ts`: session store resolver (postgres vs redis).
- `server/services/jobLock.service.ts`: distributed job lock using Redis.
- `server/services/firebase-admin.ts`: Firebase Admin init + OTP token verification.
- `server/services/push-notification.ts`: FCM push notification send helper.

### 2.3.6 Monitoring/utilities

- `server/monitoring/metrics.ts`: request/resource/frontend metric aggregation.
- `server/monitoring/errorReporter.ts`: error capture/report abstraction.
- `server/utils/category.ts`: category normalization.
- `server/utils/geo.ts`: coordinate normalization + haversine helpers.
- `server/utils/geo-sql.ts`: PostGIS/haversine SQL helper generation.
- `server/utils/identity.ts`: username/email/phone normalization.
- `server/utils/location.ts`: shared profile-location write validation,
  including the explicit two-null clear operation.
- `server/utils/mutationSchemas.ts`: allow-listed product/service create and
  update schemas; ownership, IDs, deletion flags, and timestamps stay server
  controlled.
- `server/utils/zod.ts`: standardized zod validation error response formatter.

### 2.3.7 Type declarations (`server/types/`)

- `server/types/*.d.ts`: ambient typing shims for libraries where needed.

## 2.4 Backend Setup and Operation Commands

```bash
npm install
cp .env_example .env
npm run db:migrate
npm run dev:server
```

Production flow:

```bash
npm ci
npm run build
npm run db:migrate
npm run start
```

## 2.5 Extending Backend Safely

When adding an endpoint:

1. Add/adjust validation schema (zod or shared schema).
2. Add route handler in correct module (`routes.ts` or `routes/*.ts`).
3. Use `storage` methods; avoid raw SQL in route handlers unless needed.
4. Enforce auth/role/worker permissions.
5. Wire cache invalidation/realtime events if data affects live views.
6. Add/update OpenAPI comments if endpoint should appear in docs.
7. Add tests.

For a mutation, also answer these questions before implementation:

1. Which user owns the record after the request, and can the request body alter
   that owner? It must not.
2. Does the route need a shop context? Resolve it from the authenticated shop
   or active worker link, never from a client-supplied shop ID.
3. Which fields are writable? Prefer an allow-list schema over accepting the
   database insert schema wholesale.
4. What happens to list/detail/cache/realtime consumers after the write?
5. Can historical orders/bookings/reviews still refer to the record if it is
   deleted? Prefer soft deletion or a safe availability state where history
   requires it.
6. What status code and message will distinguish missing auth, missing CSRF,
   invalid input, missing ownership, deleted records, and server failure?
7. Is there a contract test for the successful path and the most likely bad
   request?

## 3. API Manual

## 3.1 API Base and Versioning

- Base path: `/api`
- Supported version alias: `/api/v1/*` (rewritten to current handlers)
- Swagger UI: `/api/docs`

## 3.2 Authentication Model

- Session cookie-based auth.
- CSRF token required for non-GET state-changing methods.
- CSRF token source: `GET /api/csrf-token`.

## 3.3 API Domain Map (Where to look in code)

- Auth and account: `server/auth.ts`
- Core business APIs: `server/routes.ts`
- Promotions: `server/routes/promotions.ts`
- Workers: `server/routes/workers.ts`
- Admin: `server/routes/admin.ts` mounted at `/api/admin`
- Health/docs/runtime: `server/index.ts`

## 3.4 API Inventory (source-discovered static route strings)

This list comes from route definitions in `server/**/*.ts` and is useful for onboarding/search.

```text
DELETE /api/admin/platform-users/:userId
DELETE /api/admin/reviews/:reviewId
DELETE /api/cart/:productId
DELETE /api/fcm/unregister
DELETE /api/notifications/:id
DELETE /api/products/:id
DELETE /api/promotions/:id
DELETE /api/services/:id
DELETE /api/services/:serviceId/blocked-slots/:slotId
DELETE /api/shops/pay-later/whitelist/:customerId
DELETE /api/shops/workers/:workerUserId
DELETE /api/wishlist/:productId
GET *
GET /
GET /api
GET /api/admin/accounts
GET /api/admin/all-bookings
GET /api/admin/all-orders
GET /api/admin/audit-logs
GET /api/admin/dashboard-stats
GET /api/admin/disputes
GET /api/admin/health-status
GET /api/admin/logs
GET /api/admin/me
GET /api/admin/monitoring/summary
GET /api/admin/platform-users
GET /api/admin/roles
GET /api/admin/shops/transactions
GET /api/admin/transactions
GET /api/auth/profiles
GET /api/bookings
GET /api/bookings/customer
GET /api/bookings/customer/history
GET /api/bookings/customer/requests
GET /api/bookings/provider
GET /api/bookings/provider/:id
GET /api/bookings/provider/history
GET /api/bookings/provider/pending
GET /api/bookings/service/:id
GET /api/bookings/test
GET /api/cart
GET /api/csrf-token
GET /api/events
GET /api/health
GET /api/health/ready
GET /api/health/system
GET /api/notifications
GET /api/orders/
GET /api/orders/:id
GET /api/orders/:id/timeline
GET /api/orders/customer
GET /api/orders/shop
GET /api/orders/shop/recent
GET /api/product-reviews/customer
GET /api/products
GET /api/products/:id
GET /api/products/shop/:id
GET /api/promotions/active/:shopId
GET /api/promotions/shop/:id
GET /api/recommendations/buy-again
GET /api/returns/shop
GET /api/reviews/customer
GET /api/reviews/product/:id
GET /api/reviews/provider/:id
GET /api/reviews/service/:id
GET /api/reviews/shop/:id
GET /api/search
GET /api/search/global
GET /api/search/nearby
GET /api/services
GET /api/services/:id
GET /api/services/:id/blocked-slots
GET /api/services/:id/bookings
GET /api/services/provider/:id
GET /api/shops
GET /api/shops/:id
GET /api/shops/:shopId
GET /api/shops/:shopId/products/:productId
GET /api/shops/current
GET /api/shops/dashboard-stats
GET /api/shops/orders/active
GET /api/shops/pay-later/whitelist
GET /api/shops/workers
GET /api/shops/workers/:workerUserId
GET /api/shops/workers/check-number
GET /api/shops/workers/responsibilities
GET /api/user
GET /api/users/:id
GET /api/wishlist
GET /api/worker/me
PATCH /api/admin/bookings/:id/resolve
PATCH /api/admin/platform-users/:userId/suspend
PATCH /api/bookings/:id
PATCH /api/bookings/:id/customer-complete
PATCH /api/bookings/:id/en-route
PATCH /api/bookings/:id/provider-complete
PATCH /api/bookings/:id/status
PATCH /api/bookings/:id/update-reference
PATCH /api/notifications/:id/read
PATCH /api/notifications/mark-all-read
PATCH /api/orders/:id/status
PATCH /api/product-reviews/:id
PATCH /api/products/:id
PATCH /api/products/bulk-update
PATCH /api/promotions/:id
PATCH /api/promotions/:id/status
PATCH /api/provider/availability
PATCH /api/reviews/:id
PATCH /api/services/:id
PATCH /api/shops/workers/:workerUserId
PATCH /api/users/:id
POST /api/admin/accounts
POST /api/admin/change-password
POST /api/admin/login
POST /api/admin/logout
POST /api/admin/performance-metrics
POST /api/admin/roles
POST /api/auth/check-user
POST /api/auth/check-username
POST /api/auth/create-provider
POST /api/auth/create-shop
POST /api/auth/forgot-password-otp
POST /api/auth/login-pin
POST /api/auth/reset-password
POST /api/auth/reset-pin
POST /api/auth/rural-register
POST /api/auth/verify-reset-otp
POST /api/auth/worker-login
POST /api/bookings
POST /api/bookings/:id/confirm
POST /api/bookings/:id/notify-customer-accepted
POST /api/bookings/:id/notify-customer-rejected
POST /api/bookings/:id/payment
POST /api/bookings/:id/report-dispute
POST /api/bookings/process-expired
POST /api/cart
POST /api/delete-account
POST /api/fcm/register
POST /api/login
POST /api/logout
POST /api/orders
POST /api/orders/:id/agree-final-bill
POST /api/orders/:id/approve-pay-later
POST /api/orders/:id/cancel
POST /api/orders/:id/confirm-payment
POST /api/orders/:id/payment
POST /api/orders/:id/payment-method
POST /api/orders/:id/quote-text-order
POST /api/orders/:id/submit-payment-reference
POST /api/orders/:orderId/return
POST /api/orders/text
POST /api/performance-metrics
POST /api/product-reviews
POST /api/product-reviews/:id/reply
POST /api/products
POST /api/products/quick-add
POST /api/profile/location
POST /api/promotions
POST /api/promotions/:id/apply
POST /api/promotions/validate
POST /api/register
POST /api/returns/:id/approve
POST /api/reviews
POST /api/reviews/:id/reply
POST /api/services
POST /api/services/:id/block-time
POST /api/shops/pay-later/whitelist
POST /api/shops/workers
POST /api/waitlist
POST /api/wishlist
PUT /api/admin/roles/:roleId/permissions
```

## 3.5 API Testing Workflow

1. Get CSRF token + cookie.
2. Login/register.
3. Reuse cookie jar for authenticated requests.
4. For write requests include `x-csrf-token`.
5. For admin APIs use `/api/admin/login` then `/api/admin/*` routes.

## 3.6 Authorization matrix for common operations

The following is the practical contract behind the route guards. Exact
permission names are defined in `shared/schema.ts` and checked by
`server/workerAuth.ts`.

| Operation                             | Customer          | Provider             | Shop owner               | Worker                         | Admin                                                          |
| ------------------------------------- | ----------------- | -------------------- | ------------------------ | ------------------------------ | -------------------------------------------------------------- |
| Browse public products/services/shops | Yes               | Yes                  | Yes                      | Yes                            | Yes                                                            |
| Create/update own service             | No                | Own provider records | No                       | No                             | Platform tools only unless an admin route explicitly allows it |
| Create/update shop products           | No                | No                   | Own shop                 | Active link + `products:write` | Platform tools only unless an admin route explicitly allows it |
| Manage shop orders/inventory          | No                | No                   | Own shop                 | Matching shop responsibility   | Admin routes                                                   |
| Book a service/place an order         | Own customer flow | No                   | No                       | No                             | No                                                             |
| Manage own profile/location           | Own profile       | Own profile          | Own profile/shop context | Own account where supported    | Admin account flow                                             |
| Manage workers                        | No                | No                   | Own shop                 | No                             | Platform administration                                        |

This table explains an important distinction: login success does not imply that
every operation is valid. It also explains why the fix for worker product
operations belongs in shop-context and permission resolution, rather than in a
global “allow all” switch.

## 3.7 Location contract and clear semantics

`POST /api/profile/location` accepts:

```json
{
  "latitude": 10.567,
  "longitude": 77.273,
  "context": "user"
}
```

To explicitly clear the saved location, send both coordinates as `null`:

```json
{
  "latitude": null,
  "longitude": null,
  "context": "user"
}
```

The API also normalizes empty coordinate strings to null for Android clients.
One null plus one number is rejected. This is intentional: every stored or
queried location must be a complete pair.

`context: "shop"` stores the shop's location when the authenticated account
has the shop context; other contexts update the authenticated user's location.
The context field remains extensible for mobile clients, but it does not let a
client update an arbitrary user's or shop's location.

On the web, `useLocationFilter` is a temporary browse state machine:

```text
profile coordinates -> initial active source: profile
Clear                -> no active source and no geo query parameters
Saved location       -> source: profile
Use device           -> source: device
Manual coordinates   -> source: manual
```

The profile-sync effect watches only the profile coordinate value. Watching the
active `location` as well would restore profile coordinates immediately after
Clear. Every browse page includes location values in its React Query key and
request only when they exist, so a clear also invalidates the old result path
through the normal query-key change.

## 3.8 Safe product/service mutation contract

`server/utils/mutationSchemas.ts` deliberately uses `pick(...).strict()` from
the shared insert schemas. Product and service creation/update can accept
editable listing fields, but cannot accept:

- primary IDs;
- `shopId` or `providerId` ownership;
- deletion flags;
- search/cache fields;
- created/updated timestamps;
- server-generated audit or relationship fields.

The route supplies ownership from the session/context, normalizes categories,
checks verification/role/ownership, writes through storage, and invalidates
the affected cache keys. An update with no fields is rejected rather than
silently reported as a successful no-op.

Public reads and bookings exclude deleted records. A detail/update/delete
request for an already deleted service/product returns not found, preventing a
stale client from mutating an invisible record.

## 3.9 Worker mutation and revocation contract

Worker creation is shop-owner-only and validates a ten-digit worker number,
four-digit PIN, contact normalization, unique email/phone, and a list of known
responsibilities. Worker updates validate and normalize changed fields, exclude
the target worker from duplicate checks, and apply user and shop-link changes
inside one database transaction.

Worker deletion is a revocation operation. The `shop_workers` link remains for
history, but `active=false` prevents future shop operations and login access.
This avoids foreign-key/history corruption caused by hard-deleting a user who
is referenced by orders, audit records, or other operational history.

## 3.10 Status-code diagnosis

| Status | Meaning                                                                       | First place to inspect                                      |
| ------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 400    | Body/query/parameter is invalid or a business precondition failed             | Zod schema, response `errors`, route log                    |
| 401    | No valid session/authentication                                               | Cookie jar, login flow, session store                       |
| 403    | CSRF, suspension, role, worker permission, verification, or ownership failure | Response `message`, `x-request-id`, auth/context middleware |
| 404    | Resource does not exist, is deleted, or is not linked to this owner           | ID, deletion state, owner/context query                     |
| 409    | State conflict or duplicate/transition conflict                               | Current order/booking/worker state                          |
| 429    | Rate limit                                                                    | Auth/admin/sensitive limiter and retry policy               |
| 500    | Unexpected server/dependency failure                                          | Structured logs, readiness, database/Redis                  |

Do not interpret every 403 as a missing “guard rail”. CSRF and authorization
are required controls. A usable fix makes the valid session/context arrive at
the route, or makes the response explain the missing prerequisite.

## 4. Frontend Software Manual

## 4.1 Frontend Boot Flow

- `client/src/main.tsx`: React root + global `ErrorBoundary`.
- `client/src/App.tsx`: provider composition and route switch.
- Route-level code splitting via `React.lazy` and `Suspense`.

Provider stack in `App.tsx`:

1. `QueryClientProvider`
2. `LanguageProvider`
3. `AuthProvider`
4. `UserProvider`
5. `AdminProvider`

## 4.2 Frontend Routing and Pages

Routes are defined in `client/src/App.tsx`.
Page files are under `client/src/pages/`.

### 4.2.1 Top-level pages

- `auth-page.tsx`: entry auth screen
- `home-page.tsx`: public landing
- `home-page-below-fold.tsx`: lower section/home split content
- `not-found.tsx`: fallback route
- `privacy-policy.tsx`, `terms-of-service.tsx`, `account-deletion.tsx`: legal pages
- `notification-redirect.tsx`: push/deep-link redirect handler

### 4.2.2 Auth pages (`client/src/pages/auth/`)

- `RuralAuthFlow.tsx`: phone/PIN-first auth flow
- `WorkerLoginPage.tsx`: worker login
- `ForgotPassword.tsx`: reset flow UI
- `RegisterFlow.tsx`: registration path
- `translations.ts`: auth text resources

### 4.2.3 Customer pages (`client/src/pages/customer/`)

- `dashboard.tsx`: customer home dashboard
- `browse-products.tsx`, `product-details.tsx`
- `browse-services.tsx`, `service-details.tsx`, `service-provider.tsx`, `book-service.tsx`
- `browse-shops.tsx`, `shop-details.tsx`, `quick-order.tsx`
- `cart.tsx`, `wishlist.tsx`
- `orders.tsx`, `order-details.tsx`
- `bookings.tsx`
- `profile.tsx`
- `MyReviews.tsx`
- `components/ProductReviewDialog.tsx`

### 4.2.4 Shop pages (`client/src/pages/shop/`)

- `dashboard.tsx`
- `products.tsx`, `components/ProductFormDialog.tsx`
- `orders.tsx`
- `inventory.tsx`
- `ShopPromotions.tsx`
- `reviews.tsx`
- `workers.tsx`
- `profile.tsx`

### 4.2.5 Provider pages (`client/src/pages/provider/`)

- `dashboard.tsx`
- `services.tsx`
- `bookings.tsx`
- `reviews.tsx`
- `earnings.tsx`
- `profile.tsx`

### 4.2.6 Admin pages (`client/src/pages/admin/`)

- `AdminLogin.tsx`
- `AdminLayout.tsx`
- `AdminDashboard.tsx`
- `AdminPlatformUserManagement.tsx`
- `AdminOrders.tsx`
- `AdminBookings.tsx`
- `AdminShopAnalytics.tsx`
- `AdminHealth.tsx`
- `AdminMonitoring.tsx`
- `AdminAccountManagement.tsx`
- `AdminChangePassword.tsx`
- `disputes.tsx`
- `admin-utils.ts`

## 4.3 Frontend Source Map (Core non-page modules)

### 4.3.1 Data and API layer (`client/src/lib/`)

- `queryClient.ts`: fetch wrapper, CSRF handling, React Query defaults.
- `apiClient.ts`: typed Zodios client wrapper.
- `api-error.ts`: API error normalization utilities.
- `firebase.ts`: Firebase web auth init and OTP helpers.
- `push-notifications.ts`: web push registration and backend token sync.
- `notification-routing.ts`: click routing behavior.
- `protected-route.tsx`: role-based route guard.
- `role-access.ts`: frontend role helper logic.
- `permissions.ts`, `geo.ts`, `upi.ts`, `time-slots.ts`, category helpers.

### 4.3.2 Hooks (`client/src/hooks/`)

- `use-auth.tsx`: user auth session state + login/logout/register mutations.
- `use-admin.tsx`: admin auth/session state.
- `use-realtime-updates.ts`: SSE subscription and cache invalidation.
- `use-client-performance-metrics.ts` / `use-admin-performance-metrics.ts`: frontend perf telemetry.
- `use-shop-context.ts`, `use-location-filter.ts`, `use-worker-permissions.ts`, `use-mobile.tsx`, `use-toast.ts`.

### 4.3.3 Contexts (`client/src/contexts/`)

- `UserContext.tsx`: multi-profile/app-mode state.
- `language-context.tsx`: language state.
- `notification-context.tsx`: notification state.

### 4.3.4 Components (`client/src/components/`)

- `ui/*`: reusable design-system primitives.
- `layout/*`: dashboard/shop layout shells.
- `navigation/*`: app navigation components.
- `location/*`: map/filter/location UI helpers.
- `PushNotificationManager.tsx`, `PermissionRequester.tsx`: runtime permissions/push setup.
- `ErrorBoundary.tsx`, `RouteErrorBoundary.tsx`: failure boundaries.

## 4.4 Frontend Dev Rules

When adding a new page:

1. create page in correct role folder under `pages/`
2. add route in `App.tsx`
3. gate with `ProtectedRoute` if auth/role restricted
4. use `queryClient`/`apiRequest` for API calls (keeps CSRF/session behavior consistent)

When adding a filter or mutation:

1. Keep server state in React Query and transient form/UI state local to the
   page or hook.
2. Include every server input that changes the result in the query key.
3. On clear/reset, remove the input from both local state and the request
   parameters; do not only hide the value in the UI.
4. Invalidate the exact list/detail keys after a successful write.
5. Keep profile data and temporary filter data separate. A saved profile
   location is not the same thing as an active nearby search.
6. Display the API validation message to the user, but never weaken the API
   schema to make an accidental payload appear successful.

### 4.5 Frontend/API 403 debugging checklist

The shared `queryClient` obtains a CSRF token, preserves cookies, and sends the
token for state-changing requests. A new custom `fetch` call can easily
reintroduce 403 errors if it bypasses that helper. Before adding a custom
client, verify:

- the call uses the same origin/proxy or a configured API origin;
- credentials/cookies are included;
- a fresh CSRF token is available for POST/PATCH/PUT/DELETE;
- the app has hydrated the intended role/profile;
- the mutation sends only the fields accepted by the server;
- a worker operation has loaded its permission context;
- the UI invalidates/refetches after the mutation rather than showing stale
  data.

## 5. Android Software Manual (Code Map)

This complements `doorstep-android/README.md`.

## 5.1 Android App Entry Points

- `doorstep-android/app/src/main/java/com/doorstep/tn/DoorStepApp.kt`: app class, Hilt setup, image loader.
- `doorstep-android/app/src/main/java/com/doorstep/tn/MainActivity.kt`: single-activity Compose host, notification intent routing.
- `doorstep-android/app/src/main/java/com/doorstep/tn/navigation/NavHost.kt`: all navigation graph/routes.
- `doorstep-android/app/src/main/java/com/doorstep/tn/DoorStepFirebaseMessagingService.kt`: FCM token/message handling.

## 5.2 Android Package Map

### 5.2.1 Core platform (`core/*`)

- `core/di/*`: Hilt modules (`NetworkModule`, `DatabaseModule`).
- `core/network/*`: Retrofit API interface, request/response models, auth+CSRF interceptor.
- `core/database/*`: Room entities/DAO/database.
- `core/datastore/DataStore.kt`: local preference persistence.
- `core/security/*`: secure storage for session/user/fcm info.
- `core/cache/*`: local memory/cache repository.

### 5.2.2 Auth feature (`auth/*`)

- `auth/data/model/AuthModels.kt`
- `auth/data/repository/AuthRepository.kt`
- `auth/ui/*`: phone/OTP/PIN/profile-setup screens + `AuthViewModel`.

### 5.2.3 Customer feature (`customer/*`)

- `customer/data/model/CustomerModels.kt`
- `customer/data/repository/CustomerRepository.kt`
- `customer/ui/*`: dashboard, products, services, shops, bookings, orders, cart, wishlist, reviews, notifications.

### 5.2.4 Shop feature (`shop/*`)

- `shop/data/model/ShopModels.kt`
- `shop/data/repository/ShopRepository.kt`
- `shop/ui/*`: dashboard, products, product edit, orders, inventory, promotions, reviews, workers, profile.

### 5.2.5 Provider feature (`provider/*`)

- `provider/data/model/ProviderModels.kt`
- `provider/data/repository/ProviderRepository.kt`
- `provider/ui/*`: dashboard, services, bookings, reviews, earnings, notifications, profile.

### 5.2.6 Shared/common package (`common/*`)

- `common/ui/*`: reusable Compose widgets and legal screens.
- `common/theme/*`: app theme/colors/typography.
- `common/config/*`: app category/platform config constants.
- `common/localization/Translations.kt`: localization resources.
- `common/util/*`: helper utilities.

### 5.2.7 Android local API selection

The debug base URL is compiled into `BuildConfig.API_BASE_URL` by
`app/build.gradle.kts`:

- emulator: `http://10.0.2.2:<PORT>`;
- physical device: `http://<computer-lan-ip>:<PORT>` supplied with
  `-PLOCAL_API_BASE_URL=...`;
- Genymotion: normally `http://10.0.3.2:<PORT>`;
- release: the configured HTTPS production URL.

`npm run dev:all` discovers the current host LAN IPv4 address and prints the
API URL. That value is a build input for a physical-device debug APK; it is
not dynamically injected into an APK that was already installed. This explains
why changing Wi-Fi networks requires a new debug build/reinstall.

The Android `AuthInterceptor` obtains `/api/csrf-token`, keeps the session
cookie, adds `X-CSRF-Token` to writes, and retries once for a CSRF 403. A
repeated 403 after the retry normally indicates role/ownership/suspension or a
server origin/session issue rather than a missing token.

Profile location clearing is represented by a complete pair of empty values in
the mobile request; the server normalizes those values to two nulls. This
keeps Moshi/request serialization from accidentally omitting one half of the
clear operation.

## 5.3 Android Build and Config Files

- `doorstep-android/app/build.gradle.kts`: app module config, build types, release validations.
- `doorstep-android/release.env.example`: required release env vars template.
- `doorstep-android/settings.gradle.kts`, `build.gradle.kts`, `gradle/libs.versions.toml`: Gradle project/plugin/dependency versions.
- `doorstep-android/app/src/main/AndroidManifest.xml`: permissions, activity, FCM service declarations.

## 6. Shared Layer (`shared/`) Manual

- `shared/schema.ts`: DB schema + zod shared shapes (single source for entities/roles/types).
- `shared/api-contract.ts`: typed API contracts used by frontend typed client.
- `shared/config.ts`: shared flags and config constants.
- `shared/performance.ts`, `shared/monitoring.ts`, `shared/logging.ts`: shared telemetry/log contracts.
- `shared/date-utils.ts`: common date handling utilities.
- `shared/predefinedImages.ts`: preloaded image mapping metadata.

## 7. Scripts and Deployment Asset Manual

### 7.1 Scripts (`scripts/`)

- `runMigrations.ts`: apply Drizzle migrations.
- `setup-local.sh`: safe local Node/PostgreSQL/Redis/bootstrap/migration setup;
  `--reset-db` is explicit and refuses remote databases.
- `dev-all.sh`: starts API + Vite, detects the active LAN IP, and prints web,
  admin, API, and Android addresses.
- `seedMigrationHistory.ts`: baseline migration history in existing DB.
- `validateMigrationHistory.ts`: validates journal/file/snapshot structure and
  reports legacy SQL files outside the active Drizzle journal.
- `setupAdmin.ts`: admin bootstrap helper script.
- `truncateAllData.ts`: destructive DB cleanup helper (dev tooling).
- `run_load_regression.sh`: load regression runner.
- `run_tests_with_report.sh`: coverage + test report wrapper.
- `security_checklist.js`: security checks.
- `liveMonitor.js`: runtime monitor helper.
- `start_cloudflare_tunnel.sh`: local tunnel startup script.
- `provision.sh`: VPS bootstrap script (reference).

### 7.2 Deployment files (`deploy/`)

- `deploy/systemd/doorstep-api.service`: systemd unit template.
- `deploy/nginx-load-balancer.conf`: Nginx reverse proxy/load-balancing template.
- `deploy/k8s/doorstep-api.yaml`: Kubernetes deployment/service baseline.

## 8. Regenerating File/API Inventories

Useful onboarding commands:

```bash
# Backend file inventory
find server -type f | sort

# Frontend file inventory
find client/src -type f | sort

# Android Kotlin inventory
find doorstep-android/app/src/main/java/com/doorstep/tn -type f | sort

# API route inventory from source
find server -type f -name '*.ts' -print0 | xargs -0 perl -0777 -ne \
'while(/(?:app|router|bookingsRouter|ordersRouter)\.(get|post|put|patch|delete)\(\s*["\x27]([^"\x27]+)["\x27]/g){my $m=uc($1); my $p=$2; if($ARGV =~ /server\/routes\/admin\.ts$/){$p="/api/admin$p";} if($ARGV =~ /server\/routes\/bookings\.ts$/){$p="/api/bookings$p";} if($ARGV =~ /server\/routes\/orders\.ts$/){$p="/api/orders$p";} print "$m $p\n";}' | sort -u
```

## 9. New Engineer Onboarding Path (Recommended)

1. Read `README.md` sections: setup + deployment + env.
2. Run app locally (server + client).
3. Read this manual sections 2, 3, and 4.
4. Open Swagger (`/api/docs`) and verify auth/CSRF flow.
5. For mobile work, read `doorstep-android/README.md` + section 5 in this file.

## 10. Change checklist for the previously fragile flows

Use this checklist when reviewing changes to the flows that historically
produced stale data, 400 responses, or 403 responses.

### Profile location

- [ ] UI can save a complete coordinate pair.
- [ ] UI can explicitly clear both coordinates.
- [ ] API accepts two nulls/normalized empty strings and rejects a half-pair.
- [ ] User and shop contexts update only the authenticated owner context.
- [ ] Shop cache is invalidated after a shop-location change.
- [ ] Web and Android send the same semantic clear operation.

### Browse filters

- [ ] Shops, Services, and Products use the shared location hook.
- [ ] Clear removes active coordinates/source and leaves saved location merely
      available, not automatically active.
- [ ] Query keys include lat/lng/radius when active.
- [ ] Cleared requests omit all geo parameters.
- [ ] Pagination resets when the result scope changes.
- [ ] Radius remains clamped to the supported 5–100 km range.

### Products and services

- [ ] Create/update schemas are allow-listed and strict.
- [ ] Client-supplied owner IDs are ignored/rejected.
- [ ] Provider/shop ownership is checked after loading the record.
- [ ] Deleted records cannot be updated, booked, or returned as public detail.
- [ ] Affected caches are invalidated after create/update/delete.
- [ ] Existing order/booking history is preserved.

### Workers

- [ ] Worker number/PIN/contact values are validated and normalized.
- [ ] Duplicate checks exclude the worker currently being edited.
- [ ] User/link changes are transactional.
- [ ] Permission checks use the active shop link, not a request-body shop ID.
- [ ] Delete/revoke deactivates access without breaking historical references.

## 11. Verification commands and interpretation

From the repository root:

```bash
npm run db:check
npm run check
npm run lint
npm test
npm run build
```

These commands cover migration structure, TypeScript, lint rules, automated
tests, and the production web/API bundle. They do not prove that external SMS,
Firebase push, TLS certificates, payment settlement, DNS, backups, or Android
hardware behaviour are configured. Those require environment-specific checks.

For an authenticated HTTP probe, preserve the cookie jar and fetch a fresh
CSRF token before each independent session. Never print passwords, PINs,
session cookies, bearer tokens, service-account JSON, or full `.env` contents
to logs or bug reports.

## 12. Design decisions worth preserving

1. **Same-origin development proxy:** keeps browser cookies and CSRF behaviour
   simple while `dev:all` still exposes the app over the current LAN IP.
2. **Profile/active-location separation:** lets a user clear a search without
   deleting their saved address and prevents accidental rehydration.
3. **Allow-listed writes:** prevents ownership and lifecycle fields from being
   changed by a client.
4. **Worker revocation instead of deletion:** preserves referential integrity
   and audit history.
5. **Explicit migration baseline:** makes existing-schema adoption auditable
   instead of silently pretending every historical SQL file is active.
6. **Server-side authorization:** protects the platform even when the web or
   Android client is modified or bypassed.

Changing any of these decisions requires updates to route tests, the web and
Android clients, this manual, `README.md`, and the project report.
