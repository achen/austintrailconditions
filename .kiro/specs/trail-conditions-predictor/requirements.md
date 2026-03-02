# Requirements Document

## Introduction

The Trail Conditions Predictor is a system that predicts when mountain bike trails are dry and rideable after rain events. It replaces an existing Workato + Bubble + Google Sheets setup with a modern Next.js application deployed on Vercel. The system ingests weather data from a personal Weather Underground station, collects real-world trail condition reports from a Facebook group, and uses AI to predict trail dryness more accurately than the current rule-based algorithm. All data is stored in Vercel Postgres.

## Glossary

- **Predictor**: The Trail Conditions Predictor system (Next.js application on Vercel)
- **Weather_Collector**: The scheduled service that fetches weather observations from the Weather Underground API
- **Post_Collector**: The scheduled service that fetches trail condition posts from the Facebook Graph API
- **Prediction_Engine**: The AI-powered component that analyzes weather data and community reports to predict trail dryness
- **Weather_Observation**: A single timestamped record of weather data (precipitation, temperature, humidity, wind speed, solar radiation) from the personal weather station
- **Trail_Report**: A community-submitted post from the Facebook group indicating actual trail conditions
- **Drying_Model**: The AI model that correlates weather patterns and community reports to estimate trail dry-out time
- **Trail**: A named trail or trail system whose conditions are being tracked, each with its own primary weather station, drying rate (inches of rain dried per day), and maximum drying days
- **Drying_Rate**: The number of inches of rain a trail can dry per day, specific to each trail's soil and terrain
- **Max_Days**: The maximum number of days a trail takes to fully dry after a rain event
- **Condition_Status**: The current state of a trail: "Verified Rideable", "Probably Rideable", "Probably Not Rideable", or "Verified Not Rideable"
- **Rain_Event**: A period of precipitation that resets a trail's drying timeline
- **Dashboard**: The web-based user interface displaying current and predicted trail conditions
- **Cron_Job**: A Vercel-scheduled task that runs at defined intervals to collect data or update predictions

## Requirements

### Requirement 1: Collect Weather Observations

**User Story:** As a trail rider, I want the system to automatically collect weather data from my personal weather station, so that trail dryness predictions are based on real local conditions.

#### Acceptance Criteria

1. WHEN a scheduled Cron_Job fires, THE Weather_Collector SHALL fetch the latest Weather_Observation data from the Weather Underground API for each unique primary weather station associated with active Trails.
2. THE Weather_Collector SHALL store each Weather_Observation in the Vercel Postgres database with the following fields: timestamp, precipitation amount (inches), temperature (°F), relative humidity (%), wind speed (mph), solar radiation (W/m²), and daylight hours (calculated from date and latitude).
3. IF the Weather Underground API returns an error or is unreachable for a given station, THEN THE Weather_Collector SHALL log the failure with the error details and retry on the next scheduled interval.
4. THE Weather_Collector SHALL use a forecast-driven adaptive polling strategy to minimize API calls:
   a. WHEN no active Rain_Events exist AND all Trails have a Condition_Status of "Verified Rideable" or "Probably Rideable", THE Weather_Collector SHALL check the 5-day daily forecast once per day (1 API call, cached in the `weather_forecasts` table).
   b. IF the 5-day forecast shows precipitation chance >= 30% in any daypart, THE Weather_Collector SHALL call the 2-day hourly forecast (1 additional API call) to determine the exact hour rain is expected to start and end.
   c. THE Weather_Collector SHALL begin hourly station polling 4 hours before the first forecasted rain hour (`poll_after_utc`).
   d. THE Weather_Collector SHALL stop hourly station polling 3 hours after the last forecasted rain hour (`poll_until_utc`) IF no actual precipitation was detected during the polling window (false alarm).
   e. IF actual precipitation is detected, THE Weather_Collector SHALL continue hourly polling as long as any Rain_Event is active or any Trail has a Condition_Status of "Probably Not Rideable" or "Verified Not Rideable".
   f. IF the 5-day forecast shows no precipitation chance >= 30%, THE Weather_Collector SHALL skip station polling entirely (forecast-only mode, 1 API call total for the day).
5. IF a duplicate Weather_Observation timestamp already exists for the same station, THEN THE Weather_Collector SHALL skip the duplicate record without error.
6. THE Weather_Collector SHALL only fetch from distinct station IDs to avoid redundant API calls when multiple Trails share the same primary station.

### Requirement 2: Collect Facebook Trail Reports

**User Story:** As a trail rider, I want the system to pull posts from a Facebook group where riders report actual trail conditions, so that the AI can learn from real-world ground truth data.

#### Acceptance Criteria

1. WHEN a scheduled Cron_Job fires, THE Post_Collector SHALL fetch recent posts from the configured Facebook group using the Facebook Graph API.
2. THE Post_Collector SHALL store each Trail_Report in the Vercel Postgres database with the following fields: post ID, author name, post text, timestamp, and any extracted trail name references.
3. IF the Facebook Graph API returns an error or the access token is expired, THEN THE Post_Collector SHALL log the failure with error details and notify the system administrator.
4. IF a Trail_Report with the same post ID already exists, THEN THE Post_Collector SHALL skip the duplicate record without error.
5. THE Post_Collector SHALL run at a configurable interval with a default of every 30 minutes.

### Requirement 3: Detect Rain Events

**User Story:** As a trail rider, I want the system to automatically detect when it has rained, so that the drying countdown begins accurately.

#### Acceptance Criteria

1. WHEN a Weather_Observation records precipitation greater than 0 mm, THE Predictor SHALL create or extend an active Rain_Event for the affected Trail.
2. WHEN no precipitation has been recorded for 60 consecutive minutes, THE Predictor SHALL mark the active Rain_Event as ended and record the total precipitation amount.
3. THE Predictor SHALL store each Rain_Event with: start timestamp, end timestamp, total precipitation (mm), and associated Trail.
4. WHILE a Rain_Event is active, THE Predictor SHALL set the Condition_Status of the associated Trail to "Verified Not Rideable".

### Requirement 4: Predict Trail Dryness with AI

**User Story:** As a trail rider, I want AI-powered predictions of when trails will be dry, so that I get more accurate estimates than the current rule-based algorithm.

#### Acceptance Criteria

1. WHEN a Rain_Event ends, THE Prediction_Engine SHALL set the Trail's Condition_Status to "Probably Not Rideable" and generate a predicted dry time using the Drying_Model.
2. THE Prediction_Engine SHALL use the following inputs for prediction: total precipitation from the Rain_Event, the Trail's drying rate (inches per day), the Trail's maximum drying days, current temperature, current humidity, current wind speed, current solar radiation, and historical Trail_Report data indicating actual dry times after similar conditions.
3. WHILE a Trail has a Condition_Status of "Probably Not Rideable" or "Probably Rideable", THE Prediction_Engine SHALL update the predicted dry time every 30 minutes as new Weather_Observation data arrives.
4. WHEN the predicted dry time has passed and no Trail_Report contradicts it, THE Prediction_Engine SHALL update the Condition_Status to "Probably Rideable".
5. WHEN a new Trail_Report indicates a Trail is rideable, THE Prediction_Engine SHALL update the Condition_Status to "Verified Rideable" and record the actual dry time as training feedback for the Drying_Model.
6. WHEN a new Trail_Report indicates a Trail is NOT rideable, THE Prediction_Engine SHALL update the Condition_Status to "Verified Not Rideable" and adjust the predicted dry time.
5. THE Prediction_Engine SHALL use the OpenAI API to analyze weather patterns and community reports for generating predictions.
6. IF the OpenAI API is unreachable, THEN THE Prediction_Engine SHALL fall back to a rule-based estimation using the Trail's drying rate, maximum drying days, precipitation amount, and elapsed time since the Rain_Event ended.

### Requirement 5: Display Trail Conditions Dashboard

**User Story:** As a trail rider, I want to see current trail conditions on my phone, so that I can quickly check if trails are rideable.

#### Acceptance Criteria

1. THE Dashboard SHALL be a mobile-first, responsive single-page view that displays a list of all tracked Trails with their current Condition_Status.
2. THE Dashboard SHALL display each Trail's Condition_Status using one of four states: "Verified Rideable", "Probably Rideable", "Probably Not Rideable", or "Verified Not Rideable", each with a distinct color indicator.
3. WHILE a Trail has a Condition_Status of "Probably Not Rideable" or "Probably Rideable", THE Dashboard SHALL display the estimated time until the Trail is dry.
4. THE Dashboard SHALL be usable without authentication for read-only access.
5. WHEN a user loads the Dashboard, THE Predictor SHALL return the current data within 2 seconds.
6. THE Dashboard SHALL display a "Last Updated" timestamp showing when the trail condition data was most recently refreshed.
7. THE Dashboard SHALL display the site as "Austin Trail Conditions" matching the existing branding at austintrailconditions.com.

### Requirement 6: Manage Trails

**User Story:** As a system administrator, I want to add, edit, and remove trails from the system, so that I can keep the tracked trail list current.

#### Acceptance Criteria

1. THE Predictor SHALL allow an administrator to create a new Trail with a name, optional description, primary weather station ID, drying rate (inches per day), and maximum drying days.
2. THE Predictor SHALL allow an administrator to edit an existing Trail's name, description, primary station ID, drying rate, and maximum drying days.
3. THE Predictor SHALL allow an administrator to enable or disable weather updates for a Trail via an "update" flag.
4. THE Predictor SHALL allow an administrator to archive a Trail so it no longer appears on the Dashboard.
5. THE Predictor SHALL retain all historical data (Weather_Observations, Rain_Events, Trail_Reports) for archived Trails.
6. THE Predictor SHALL seed the database with the initial set of 30 trails and their station IDs, drying rates, and max days on first deployment.

### Requirement 7: Classify Trail Reports with AI

**User Story:** As a trail rider, I want the system to automatically understand Facebook posts and extract trail condition information, so that raw posts become structured data for predictions.

#### Acceptance Criteria

1. WHEN a new Trail_Report is stored, THE Prediction_Engine SHALL classify the post as one of: "trail is dry/rideable", "trail is wet/muddy", "trail condition inquiry", or "unrelated".
2. THE Prediction_Engine SHALL extract any Trail names mentioned in the Trail_Report text using fuzzy matching against the configured Trail list.
3. THE Prediction_Engine SHALL assign a confidence score between 0 and 1 to each classification.
4. IF the confidence score is below 0.6, THEN THE Prediction_Engine SHALL flag the Trail_Report for manual review.
5. THE Prediction_Engine SHALL use the OpenAI API for natural language classification of Trail_Reports.

### Requirement 8: Store and Manage Configuration

**User Story:** As a system administrator, I want to configure API keys, station IDs, and Facebook group IDs in one place, so that the system is easy to set up and maintain.

#### Acceptance Criteria

1. THE Predictor SHALL read configuration values from environment variables for: Weather Underground API key, Facebook Graph API access token, Facebook group ID, OpenAI API key, and Vercel Postgres connection string (POSTGRES_URL).
2. IF any required configuration value is missing at startup, THEN THE Predictor SHALL log a descriptive error message identifying the missing value and prevent the application from starting.
3. THE Predictor SHALL validate that each API key and token has the correct format before attempting API calls.
4. Trail-specific configuration (station ID, drying rate, max days, update flag) SHALL be stored in the database rather than environment variables.

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
