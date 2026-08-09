# DoorStep TN — Final-Year Project Readiness Brief

## Honest assessment

DoorStep TN is technically suitable for a final-year software engineering
project. It is more substantial than a basic CRUD application: it combines a
multi-role marketplace, local service booking, role-based operations, manual
payment verification, notifications, location-aware discovery, background
jobs, a web client, and a native Android client.

It should not be presented as a finished commercial marketplace or as a fully
automated payment platform. The strongest academic framing is:

> A role-aware local commerce and service-booking platform that unifies product
> discovery, provider scheduling, order/booking state transitions, and
> location-aware access for customers, shops, service providers, and platform
> administrators.

## Problem statement

Small local businesses and independent service providers often use separate
messaging, catalog, booking, and payment-reference workflows. Customers must
repeat their address and order information across channels, while operators
have limited visibility into fulfilment, disputes, and service availability.
DoorStep TN addresses this fragmentation with one role-aware platform.

## Core objectives

1. Provide one authenticated workflow for product orders and service bookings.
2. Support customer, provider, shop-worker, shop-owner, and administrator roles.
3. Enforce server-side ownership, role, CSRF, input-validation, and rate-limit
   checks rather than relying on UI hiding.
4. Use location and availability data to improve local discovery and scheduling.
5. Provide a reusable API consumed by both React web and native Android clients.
6. Measure correctness, security behaviour, latency, and operational readiness.

## Architecture evidence

- React + Vite web client.
- Express + TypeScript API with Zod validation.
- PostgreSQL + Drizzle persistence and versioned migrations.
- Redis-backed sessions/cache/realtime fan-out and BullMQ jobs.
- Kotlin + Jetpack Compose Android client using Retrofit/OkHttp.
- Cookie sessions and CSRF tokens shared by web and Android flows.
- Health/readiness endpoints, structured logging, security headers, and
  CI checks.

## Current verification baseline

The repository currently contains 679 automated tests. The latest native test
coverage run reported approximately 56.73% lines, 79.14% branches, and 45.71%
functions. TypeScript checking, ESLint, the production web build, API health,
database/Redis readiness, and CSRF endpoint probes have passed. The supported
runtime is Node.js 20.x, matching CI and the `.nvmrc` file.

The Android debug build is also included in CI. A local build requires JDK 17
and Android SDK 35; without those tools, local Android compilation cannot be
claimed as verified.

## Limitations to state during evaluation

- SMS delivery is not connected to a production SMS provider; local OTP is a
  development/demo mechanism.
- Payment flows use UPI/payment references and operator confirmation rather
  than a live payment gateway or server-to-server payment settlement.
- Push notifications require Firebase project configuration.
- The tracked demo local-auth configuration is for private demonstrations only;
  production must use private credentials and disable demo authentication.
- The Android app is a client of the same API, not an independent backend.
- The active Drizzle journal is structurally valid, but 33 older SQL files are
  retained outside that journal as historical references; they are not applied
  automatically. The validator and baseline command make this distinction
  explicit.
- The API still has a large route module and the test suite is stronger in
  unit/contract coverage than in full browser-to-database end-to-end coverage.
- The latest production dependency audit has no high/critical findings, but
  still reports 10 moderate transitive `uuid` findings whose automatic fix
  would require a breaking `node-cron` upgrade.
- Authenticated DAST and a production security assessment are still separate
  deployment-stage activities.

These are acceptable project limitations when stated clearly. They become a
problem only if the report claims production-grade SMS, payments, or security
certification.

## Recommended viva demonstration

1. Start PostgreSQL/Redis and the API.
2. Log in as a customer and show nearby shops/services, cart, booking, and
   order state changes.
3. Log in as a provider and show service creation, availability, booking
   acceptance, completion, and review.
4. Log in as a shop and show product/inventory/order management and worker
   responsibilities.
5. Show an administrator dashboard, audit/health view, and a rejected
   unauthorized request.
6. Show the same login/profile/catalog contract from the Android debug build.
7. Show test, coverage, migration validation, and CI evidence.

## What would weaken the submission

- Claiming “no security restrictions” or removing server-side authorization.
- Demonstrating only screenshots without explaining data flow and state
  transitions.
- Claiming real payment/SMS delivery when the implementation is manual/demo.
- Presenting the 679 tests without explaining that coverage and HTTP-level
  integration coverage are different measures.
- Omitting the migration, deployment, and limitation sections from the report.

## Final recommendation

Proceed with this project, but submit it as a bounded engineering system with
measured evaluation and explicit limitations. Do not spend the remaining time
adding random features. Prioritize a clean project report, one reproducible
demo dataset, Android CI/build evidence, migration reproducibility, and a small
set of authenticated end-to-end tests for the primary customer/provider/shop
flows.
