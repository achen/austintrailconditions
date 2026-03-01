# Implementation Plan: Trail Conditions Predictor

## Overview

Build a Next.js 14 application that predicts mountain bike trail dryness after rain events. Implementation proceeds bottom-up: database schema → configuration → core services → cron API routes → dashboard UI → admin UI, with each step wiring into the previous. All code is TypeScript, deployed on Vercel with Vercel Postgres (Neon).

## Tasks

- [x] 1. Set up database schema and project structure
  - [x] 1.1 Create database migration script with all tables and indexes
    - Create `src/db/migrations/001_initial_schema.sql` with the full schema from the design: `trails`, `weather_observations`, `rain_events`, `trail_reports`, `predictions` tables, all constraints, and all indexes
    - Update `scripts/migrate.js` to run SQL migrations against Vercel Postgres
    - _Requirements: 1.2, 2.2, 3.3, 9.1_

  - [x] 1.2 Create TypeScript type definitions and shared interfaces
    - Create `src/types/index.ts` with all interfaces from the design: `Trail`, `WeatherObservation`, `RainEvent`, `TrailReport`, `Prediction`, `PredictionInput`, `HistoricalOutcome`, `ClassificationResult`, `AppConfig`, `SeedTrail`
    - _Requirements: 1.2, 2.2, 3.3, 4.2, 6.1_

  - [x] 1.3 Create Vercel Postgres client utility
    - Create `src/lib/db.ts` that initializes and exports a database client using `@vercel/postgres` (sql template tag or createPool) with the `POSTGRES_URL` environment variable
    - _Requirements: 8.1_

  - [x] 1.4 Create seed data file with 30 pre-configured trails
    - Create `src/db/seed-trails.ts` with the 30 Central Texas trails from the design (name, station ID, drying rate, max days, updates enabled)
    - Create `src/db/seed.ts` script that inserts seed trails on first deployment using ON CONFLICT DO NOTHING
    - _Requirements: 6.6_

- [x] 2. Implement configuration validation
  - [x] 2.1 Implement ConfigValidator service
    - Create `src/services/config-validator.ts` that reads and validates all required environment variables: `WEATHER_API_KEY`, `FACEBOOK_ACCESS_TOKEN`, `FACEBOOK_GROUP_ID`, `OPENAI_API_KEY`, `POSTGRES_URL`
    - Throw descriptive errors naming each missing or malformed variable
    - _Requirements: 8.1, 8.2, 8.3_

  - [x] 2.2 Write property test for configuration validation
    - **Property 16: Configuration validation rejects incomplete config**
    - **Validates: Requirements 8.2, 8.3**

- [x] 3. Implement WeatherCollector service
  - [x] 3.1 Implement WeatherCollector with fetch, store, and adaptive polling
    - Create `src/services/weather-collector.ts` implementing `fetchObservations()`, `storeObservations()`, and `getActiveStationIds()`
    - Fetch from `api.weather.com` for each unique active station ID
    - Store observations with ON CONFLICT DO NOTHING for deduplication by (station_id, timestamp)
    - Calculate daylight hours from date and Austin latitude (~30.27°N)
    - Implement adaptive polling logic: check if any rain events are active or any trail is in a drying state to determine polling frequency
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6_

  - [x] 3.2 Write property tests for weather observation storage
    - **Property 1: Weather observation storage round-trip**
    - **Validates: Requirements 1.2**

  - [x] 3.3 Write property test for weather observation idempotency
    - **Property 2: Weather observation idempotency**
    - **Validates: Requirements 1.5**

- [x] 4. Implement RainDetector service
  - [x] 4.1 Implement RainDetector with evaluate and checkForRainEnd
    - Create `src/services/rain-detector.ts` implementing `evaluate()` and `checkForRainEnd()`
    - Create/extend active rain events when precipitation > 0 for a trail's station
    - End rain events after 60 minutes of zero precipitation, recording total precipitation
    - Set trail condition_status to "Verified Not Rideable" while rain event is active
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 4.2 Write property tests for rain detection
    - **Property 5: Precipitation creates rain event with Wet status**
    - **Property 6: Dry gap ends rain event**
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4**

- [x] 5. Checkpoint - Ensure data collection layer works
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement PostCollector service
  - [x] 6.1 Implement PostCollector with fetch and store
    - Create `src/services/post-collector.ts` implementing `fetchPosts()` and `storePosts()`
    - Fetch from Facebook Graph API using group ID and access token
    - Store posts with ON CONFLICT DO NOTHING for deduplication by post_id
    - _Requirements: 2.1, 2.2, 2.4_

  - [x] 6.2 Write property tests for trail report storage
    - **Property 3: Trail report storage round-trip**
    - **Property 4: Trail report idempotency**
    - **Validates: Requirements 2.2, 2.4**

- [x] 7. Implement PostClassifier service
  - [x] 7.1 Implement PostClassifier with classify and extractTrailNames
    - Create `src/services/post-classifier.ts` implementing `classify()` and `extractTrailNames()`
    - Use OpenAI API to classify posts as dry/wet/inquiry/unrelated with confidence score
    - Implement fuzzy matching for trail name extraction against known trail list
    - Flag posts with confidence < 0.6 for manual review
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 7.2 Write property tests for classification
    - **Property 14: Classification output validity**
    - **Property 15: Fuzzy trail name extraction**
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**

- [x] 8. Implement PredictionEngine service
  - [x] 8.1 Implement PredictionEngine with predict, updatePredictions, fallbackPredict, and recordActualOutcome
    - Create `src/services/prediction-engine.ts` implementing all PredictionEngine methods
    - Use OpenAI API with weather data + historical outcomes as context for predictions
    - Implement rule-based fallback using trail drying rate, max days, and weather adjustments from the design
    - Transition trails: "Probably Not Rideable" → "Probably Rideable" when predicted dry time passes; "Verified Rideable" when dry report received; "Verified Not Rideable" when wet report received
    - Record actual dry time on predictions when community reports confirm dryness
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 10.1, 10.2_

  - [x] 8.2 Implement historical correlation query
    - Create `src/services/history-service.ts` that queries historical rain events with similar conditions (precipitation ±0.5 in, temperature ±10°F) for the same trail, ordered by most recent
    - Include prediction-vs-actual outcomes in the context sent to OpenAI
    - _Requirements: 9.2, 9.3, 10.2_

  - [x] 8.3 Write property tests for prediction engine
    - **Property 7: Rain event end triggers prediction with complete inputs**
    - **Property 8: Drying trails get updated predictions**
    - **Property 9: Dry report transitions trail to Verified Rideable and records outcome**
    - **Property 10: Fallback prediction produces valid result**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 10.1, 10.2**

  - [x] 8.4 Write property tests for historical correlation
    - **Property 17: Historical correlation query returns similar events**
    - **Validates: Requirements 9.2, 9.3**

- [x] 9. Implement TrailService
  - [x] 9.1 Implement TrailService with CRUD operations
    - Create `src/services/trail-service.ts` implementing `create()`, `update()`, `archive()`, `listActive()`, and `seed()`
    - Archive sets `is_archived = true` but retains all associated data
    - `listActive()` excludes archived trails
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [x] 9.2 Write property tests for trail management
    - **Property 12: Trail management round-trip**
    - **Property 13: Archiving excludes from active list but retains history**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5**

- [x] 10. Checkpoint - Ensure all services work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement cron API routes
  - [x] 11.1 Implement weather cron route
    - Create `src/app/api/cron/weather/route.ts` that validates config, gets active station IDs, fetches observations, stores them, and runs rain detection
    - Implement adaptive polling: skip if no active rain events and last poll was < 24 hours ago; always run if rain events active or trails are drying
    - Add cron authorization check via `CRON_SECRET` header
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 3.1_

  - [x] 11.2 Implement Facebook cron route
    - Create `src/app/api/cron/facebook/route.ts` that fetches posts, stores them, and classifies new unclassified posts
    - Log errors and flag admin notification on Facebook API failures
    - _Requirements: 2.1, 2.3, 2.5, 7.1_

  - [x] 11.3 Implement prediction cron route
    - Create `src/app/api/cron/predict/route.ts` that updates predictions for all drying trails, processes classified reports to transition trail statuses
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6_

  - [x] 11.4 Configure Vercel cron schedule
    - Create or update `vercel.json` with cron definitions: weather hourly, facebook every 30 min, predict every 30 min
    - _Requirements: 1.4, 2.5_

- [x] 12. Implement trail management API routes
  - [x] 12.1 Implement trails REST API
    - Create `src/app/api/trails/route.ts` with GET (list active) and POST (create trail) handlers
    - Create `src/app/api/trails/[id]/route.ts` with PUT (update) and DELETE (archive) handlers
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 13. Implement Dashboard UI
  - [x] 13.1 Create main dashboard page
    - Create `src/app/page.tsx` as a server component that queries trails with current conditions
    - Display mobile-first responsive list of trails with color-coded status indicators: green (Verified Rideable), light green (Probably Rideable), orange (Probably Not Rideable), red (Verified Not Rideable)
    - Show estimated dry time for trails in "Probably Not Rideable" or "Probably Rideable" status
    - Show "Last Updated" timestamp for each trail
    - Title the page "Austin Trail Conditions"
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 13.2 Implement prediction accuracy display
    - Add accuracy percentage to the dashboard showing prediction accuracy for the last 10 rain events (predictions within 2 hours of actual dry time)
    - _Requirements: 10.3_

  - [x] 13.3 Write property test for dashboard data
    - **Property 11: Dashboard data includes status and predicted dry time for drying trails**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.6**

  - [x] 13.4 Write property test for prediction accuracy calculation
    - **Property 18: Prediction accuracy calculation**
    - **Validates: Requirements 10.3**

- [x] 14. Implement Admin page
  - [x] 14.1 Create admin page for trail management
    - Create `src/app/admin/page.tsx` with forms to add, edit, and archive trails
    - Include fields: name, description, primary station ID, drying rate, max days, updates enabled
    - Wire to `/api/trails` and `/api/trails/[id]` endpoints
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 15. Create app layout and global styles
  - [x] 15.1 Create root layout and global CSS
    - Create `src/app/layout.tsx` with "Austin Trail Conditions" branding, mobile-first viewport meta, and Tailwind CSS setup
    - Create `src/app/globals.css` with Tailwind directives and status color variables
    - _Requirements: 5.1, 5.7_

- [x] 16. Final checkpoint - Full integration verification
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The project already has package.json, tsconfig, tailwind config, next.config, and .env.local scaffolded — tasks build on top of this
- Vitest and fast-check need to be added as dev dependencies before running tests
