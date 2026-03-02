# Requirements Document

## Introduction

The Trail Conditions Predictor is a system that predicts when mountain bike trails are dry and rideable after rain events. It replaces an existing Workato + Bubble + Google Sheets setup with a modern Next.js application deployed on Vercel. The system ingests weather data from Weather Underground stations, collects real-world trail condition reports from a Facebook group via an external Puppeteer scraper running on a Linux server, and uses AI to predict trail dryness more accurately than the current rule-based algorithm. All data is stored in Vercel Postgres.

## Glossary

- **Predictor**: The Trail Conditions Predictor system (Next.js application on Vercel)
- **Weather_Collector**: The scheduled service that fetches weather observations and forecasts from the Weather Underground API
- **Post_Collector**: The service that receives and processes trail condition posts from the external Puppeteer scraper via the POST /api/scrape/ingest endpoint
- **Prediction_Engine**: The AI-powered component that analyzes weather data and community reports to predict trail dryness
- **Weather_Observation**: A single timestamped record of weather data (precipitation, temperature, humidity, wind speed, solar radiation) from a weather station
- **Weather_Forecast**: A cached forecast record (5-day daily or 2-day hourly) stored in the `weather_forecasts` table, used to drive adaptive polling
- **Trail_Report**: A community-submitted post from the Facebook group indicating actual trail conditions
- **Drying_Model**: The AI model that correlates weather patterns and community reports to estimate trail dry-out time
- **Trail**: A named trail or trail system whose conditions are being tracked, each with its own primary weather station, drying rate (inches of rain dried per day), maximum drying days, and optional aliases
- **Trail_Alias**: A segment name or nickname for a trail stored in the `aliases` column, used for fuzzy matching and AI classification (e.g., "Katy Trail" for Lake Georgetown, "MM" for Mary Moore Searight, "Champions" for BCGB East)
- **Drying_Rate**: The number of inches of rain a trail can dry per day, specific to each trail's soil and terrain
- **Max_Drying_Days**: The maximum number of days a trail takes to fully dry after a rain event, stored per-trail in the database and auto-adjusted upward when wet reports arrive after the window
- **Condition_Status**: The current state of a trail: "Verified Rideable", "Probably Rideable", "Probably Not Rideable", or "Verified Not Rideable"
- **Rain_Event**: A period of precipitation that resets a trail's drying timeline
- **Dashboard**: The web-based user interface displaying current and predicted trail conditions
- **Cron_Job**: A Vercel-scheduled task that runs at defined intervals to collect data or update predictions
- **Notification_Service**: The service that sends email alerts for system events including station outages, cron failures, rain detection, forecast summaries, and cookie expiry
- **Trail_Verifier**: The component that validates incoming trail reports against recent rain history and manages stale verification expiry
- **BCGB**: Barton Creek Greenbelt (trail system in Austin, TX)

## Requirements

### Requirement 1: Collect Weather Observations

**User Story:** As a trail rider, I want the system to automatically collect weather data from weather stations, so that trail dryness predictions are based on real local conditions.

#### Acceptance Criteria

1. WHEN a scheduled Cron_Job fires, THE Weather_Collector SHALL fetch the latest Weather_Observation data from the Weather Underground API for each unique primary weather station associated with active Trails.
2. THE Weather_Collector SHALL store each Weather_Observation in the Vercel Postgres database with the following fields: timestamp, precipitation amount (inches), temperature (°F), relative humidity (%), wind speed (mph), solar radiation (W/m²), and daylight hours (calculated from date and latitude).
3. IF the Weather Underground API returns an error or is unreachable for a given station, THEN THE Weather_Collector SHALL log the failure with the error details and retry on the next scheduled interval.
4. THE Weather_Collector SHALL use a forecast-driven adaptive polling strategy to minimize API calls:
   a. WHEN any Rain_Event is active OR any Trail has a Condition_Status of "Probably Not Rideable" or "Verified Not Rideable", THE Weather_Collector SHALL poll stations hourly until all Trails are dry.
   b. WHEN no active Rain_Events exist AND all Trails have a Condition_Status of "Verified Rideable" or "Probably Rideable", THE Weather_Collector SHALL check the 5-day daily forecast once per day (1 API call, cached in the `weather_forecasts` table).
   c. IF the 5-day forecast shows no precipitation chance >= 30% in any daypart, THE Weather_Collector SHALL skip station polling entirely (forecast-only mode, 1 API call total for the day).
   d. IF the 5-day forecast shows precipitation chance >= 30% in any daypart, THE Weather_Collector SHALL call the 2-day hourly forecast (1 additional API call) to determine the first and last hour with >= 30% precipitation chance.
   e. THE Weather_Collector SHALL set `poll_after_utc` to the first forecasted rain hour minus 4 hours and `poll_until_utc` to the last forecasted rain hour plus 3 hours.
   f. IF the current time is before `poll_after_utc`, THE Weather_Collector SHALL skip station polling (too early).
   g. IF the current time is after `poll_until_utc` AND no actual precipitation was detected during the polling window, THE Weather_Collector SHALL stop hourly station polling (false alarm).
   h. IF actual precipitation is detected during the polling window, THE Weather_Collector SHALL continue hourly polling per criterion 4a (active rain / wet trails takes over).
5. IF a duplicate Weather_Observation timestamp already exists for the same station, THEN THE Weather_Collector SHALL skip the duplicate record without error.
6. THE Weather_Collector SHALL only fetch from distinct station IDs to avoid redundant API calls when multiple Trails share the same primary station.

### Requirement 2: Collect Facebook Trail Reports

**User Story:** As a trail rider, I want the system to receive posts from a Facebook group where riders report actual trail conditions, so that the AI can learn from real-world ground truth data.

#### Acceptance Criteria

1. WHEN the external Puppeteer scraper sends a POST request to /api/scrape/ingest, THE Post_Collector SHALL receive and process the submitted posts.
2. THE Post_Collector SHALL store each Trail_Report in the Vercel Postgres database with the following fields: post ID, author name, post text, timestamp, parent post ID (for comments), and any extracted trail name references.
3. IF the scraper's authentication cookie is expired or invalid, THEN THE Post_Collector SHALL log the failure with error details and THE Notification_Service SHALL send an email alert for cookie expiry.
4. IF a Trail_Report with the same post ID already exists, THEN THE Post_Collector SHALL skip the duplicate record without error.
5. THE Post_Collector SHALL also run on a scheduled Cron_Job at a configurable interval with a default of every 30 minutes to trigger the external scraper.
6. WHEN the /api/scrape/ingest endpoint processes posts, THE Post_Collector SHALL return all classified posts in the API response with timestamps, trail assignments, and status changes for the scraper's email summary.

### Requirement 3: Detect Rain Events

**User Story:** As a trail rider, I want the system to automatically detect when it has rained, so that the drying countdown begins accurately.

#### Acceptance Criteria

1. WHEN a Weather_Observation records precipitation greater than 0 inches, THE Predictor SHALL create or extend an active Rain_Event for the affected Trail.
2. WHEN no precipitation has been recorded for 60 consecutive minutes, THE Predictor SHALL mark the active Rain_Event as ended and record the total precipitation amount.
3. THE Predictor SHALL store each Rain_Event with: start timestamp, end timestamp, total precipitation (inches), and associated Trail.
4. WHILE a Rain_Event is active, THE Predictor SHALL set the Condition_Status of the associated Trail to "Verified Not Rideable".

### Requirement 4: Predict Trail Dryness with AI

**User Story:** As a trail rider, I want AI-powered predictions of when trails will be dry, so that I get more accurate estimates than the current rule-based algorithm.

#### Acceptance Criteria

1. WHEN a Rain_Event ends, THE Prediction_Engine SHALL set the Trail's Condition_Status to "Probably Not Rideable" and generate a predicted dry time using the Drying_Model.
2. THE Prediction_Engine SHALL use the following inputs for prediction: total precipitation from the Rain_Event, the Trail's drying rate (inches per day), the Trail's max_drying_days, current temperature, current humidity, current wind speed, current solar radiation, and historical Trail_Report data indicating actual dry times after similar conditions.
3. WHILE a Trail has a Condition_Status of "Probably Not Rideable" or "Probably Rideable", THE Prediction_Engine SHALL update the predicted dry time every 30 minutes as new Weather_Observation data arrives.
4. WHEN the predicted dry time has passed and no Trail_Report contradicts it, THE Prediction_Engine SHALL update the Condition_Status to "Probably Rideable".
5. WHEN a new Trail_Report indicates a Trail is rideable, THE Prediction_Engine SHALL update the Condition_Status to "Verified Rideable" and record the actual dry time as training feedback for the Drying_Model.
6. WHEN a new Trail_Report indicates a Trail is NOT rideable, THE Trail_Verifier SHALL check whether rain has occurred within the Trail's max_drying_days window before applying the report:
   a. IF no Rain_Event exists within the Trail's max_drying_days window, THE Trail_Verifier SHALL skip the wet report as stale.
   b. IF a Rain_Event ended more than max_drying_days ago but the Trail is still reported wet, THE Trail_Verifier SHALL increase the Trail's max_drying_days upward to match reality.
   c. IF the wet report is valid, THE Prediction_Engine SHALL update the Condition_Status to "Verified Not Rideable" and adjust the predicted dry time.
7. THE Prediction_Engine SHALL use the OpenAI API to analyze weather patterns and community reports for generating predictions.
8. IF the OpenAI API is unreachable, THEN THE Prediction_Engine SHALL fall back to a rule-based estimation using the Trail's drying rate, max_drying_days, precipitation amount, and elapsed time since the Rain_Event ended.

### Requirement 5: Display Trail Conditions Dashboard

**User Story:** As a trail rider, I want to see current trail conditions on my phone, so that I can quickly check if trails are rideable.

#### Acceptance Criteria

1. THE Dashboard SHALL be a mobile-first, responsive single-page view that displays a list of all tracked Trails with their current Condition_Status.
2. THE Dashboard SHALL display each Trail's Condition_Status using the following display labels with distinct color indicators: "Observed Dry" (for Verified Rideable), "Predicted Dry" (for Probably Rideable), "Predicted Wet" (for Probably Not Rideable), or "Observed Wet" (for Verified Not Rideable).
3. WHILE a Trail has a Condition_Status of "Probably Not Rideable" or "Probably Rideable", THE Dashboard SHALL display the estimated time until the Trail is dry.
4. THE Dashboard SHALL be usable without authentication for read-only access.
5. WHEN a user loads the Dashboard, THE Predictor SHALL return the current data within 2 seconds.
6. THE Dashboard SHALL display a "Last Updated" timestamp showing when the trail condition data was most recently refreshed.
7. THE Dashboard SHALL display the site as "Austin Trail Conditions" matching the existing branding at austintrailconditions.com.

### Requirement 6: Manage Trails

**User Story:** As a system administrator, I want to add, edit, and remove trails from the system, so that I can keep the tracked trail list current.

#### Acceptance Criteria

1. THE Predictor SHALL allow an administrator to create a new Trail with a name, optional description, primary weather station ID, drying rate (inches per day), max_drying_days, and optional aliases.
2. THE Predictor SHALL allow an administrator to edit an existing Trail's name, description, primary station ID, drying rate, max_drying_days, and aliases.
3. THE Predictor SHALL allow an administrator to enable or disable weather updates for a Trail via an "update" flag.
4. THE Predictor SHALL allow an administrator to archive a Trail so it no longer appears on the Dashboard.
5. THE Predictor SHALL retain all historical data (Weather_Observations, Rain_Events, Trail_Reports) for archived Trails.
6. THE Predictor SHALL seed the database with the initial set of 30 trails and their station IDs, drying rates, max days, and aliases on first deployment.

### Requirement 7: Classify Trail Reports with AI

**User Story:** As a trail rider, I want the system to automatically understand Facebook posts and extract trail condition information, so that raw posts become structured data for predictions.

#### Acceptance Criteria

1. WHEN a new Trail_Report is stored, THE Prediction_Engine SHALL classify the post as one of: "trail is dry/rideable", "trail is wet/muddy", "trail condition inquiry", or "unrelated".
2. THE Prediction_Engine SHALL extract any Trail names mentioned in the Trail_Report text using fuzzy matching against the configured Trail list and Trail_Aliases loaded from the database.
3. THE Prediction_Engine SHALL assign a confidence score between 0 and 1 to each classification.
4. IF the confidence score is below 0.6, THEN THE Prediction_Engine SHALL flag the Trail_Report for manual review.
5. THE Prediction_Engine SHALL use the OpenAI API for natural language classification of Trail_Reports, with the system prompt including common mountain bike slang terms (GTG, g2g, primo, tacky, hero dirt, not g2g, chocolate cake, peanut butter).
6. WHEN a Trail_Report is a comment with a parent post ID and has no trail name matches in its text, THE Prediction_Engine SHALL inherit the trail references from the parent post's stored trail_references in the database.

### Requirement 8: Store and Manage Configuration

**User Story:** As a system administrator, I want to configure API keys, station IDs, and scraper settings in one place, so that the system is easy to set up and maintain.

#### Acceptance Criteria

1. THE Predictor SHALL read configuration values from environment variables for: Weather Underground API key, OpenAI API key, Vercel Postgres connection string (POSTGRES_URL), and email notification settings.
2. IF any required configuration value is missing at startup, THEN THE Predictor SHALL log a descriptive error message identifying the missing value and prevent the application from starting.
3. THE Predictor SHALL validate that each API key and token has the correct format before attempting API calls.
4. Trail-specific configuration (station ID, drying rate, max_drying_days, aliases, update flag) SHALL be stored in the database rather than environment variables.

### Requirement 9: Retain Historical Data for Correlation Analysis

**User Story:** As a system operator, I want all weather observations, rain events, predictions, and trail reports retained over time, so that the AI can identify correlations between weather patterns and actual trail drying times.

#### Acceptance Criteria

1. THE Predictor SHALL retain all Weather_Observations, Rain_Events, Predictions, and Trail_Reports indefinitely in the Vercel Postgres database.
2. WHEN generating a new prediction, THE Prediction_Engine SHALL query historical data for the same Trail to find past Rain_Events with similar precipitation amounts, temperatures, humidity, and wind conditions.
3. THE Prediction_Engine SHALL use matched historical outcomes (predicted vs. actual dry times) as context when calling the OpenAI API to improve future predictions.
4. THE Predictor SHALL NOT expose historical data or charts to end users on the Dashboard.

### Requirement 10: Improve Predictions Over Time

**User Story:** As a trail rider, I want the prediction accuracy to improve as more real-world data is collected, so that dry time estimates become increasingly reliable.

#### Acceptance Criteria

1. THE Prediction_Engine SHALL store each prediction alongside the actual outcome (predicted dry time vs. actual dry time from Trail_Reports) as training data.
2. WHEN generating a new prediction, THE Prediction_Engine SHALL include relevant historical prediction-vs-actual outcomes in the prompt context sent to the OpenAI API.
3. THE Dashboard SHALL display the prediction accuracy for the last 10 Rain_Events as a percentage of predictions within 2 hours of the actual dry time.

### Requirement 11: Expire Stale Verifications

**User Story:** As a trail rider, I want trails stuck in "Verified Not Rideable" to automatically transition back to a predicted state when enough time has passed, so that the dashboard stays current.

#### Acceptance Criteria

1. WHEN the predict Cron_Job, Facebook Cron_Job, or scrape ingest route runs, THE Trail_Verifier SHALL check all Trails with a Condition_Status of "Verified Not Rideable" for stale verifications.
2. IF no Rain_Event exists within a Trail's max_drying_days window, THE Trail_Verifier SHALL transition the Trail's Condition_Status from "Verified Not Rideable" to "Probably Rideable".

### Requirement 12: Send System Notifications

**User Story:** As a system administrator, I want to receive email alerts for important system events, so that I can respond to issues promptly.

#### Acceptance Criteria

1. WHEN any weather station goes offline, THE Notification_Service SHALL send an email alert identifying the offline station.
2. WHEN a Cron_Job fails, THE Notification_Service SHALL send an email alert with the failure details.
3. WHEN rain is detected, THE Notification_Service SHALL send an email alert including current trail statuses.
4. WHEN the daily forecast check completes, THE Notification_Service SHALL send a summary email including current trail statuses.
5. WHEN the scraper's authentication cookie is approaching expiry, THE Notification_Service SHALL send an email alert.

### Requirement 13: Station Health Monitoring (Future)

**User Story:** As a system administrator, I want the system to monitor weather station health, so that I can identify and address station issues.

#### Acceptance Criteria

1. THE Predictor SHALL include station health functions (autoReplaceOfflineStations, crossValidatePrecipitation) in the codebase for future use.
2. THE station health functions SHALL NOT be wired into any active code paths or cron jobs (dead code kept for future activation).
