import type { SeedTrail } from '../types';

/**
 * 30 pre-configured Central Texas mountain bike trails.
 *
 * dryingRateInPerDay is repurposed as max absorbable inches (soil capacity).
 * Calculated as: max_drying_days × ideal_drying_rate_per_day
 * where ideal = 0.0288 in/hr × 10 hrs = 0.288 in/day (85°F, full sun, light wind).
 *
 * maxDryingDays is kept for stale report detection in trail-verifier.
 */
export const seedTrails: SeedTrail[] = [
  { name: 'BCGB - East', primaryStationId: 'KTXAUSTI3987', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'BCGB - West', primaryStationId: 'KTXAUSTI1782', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Bluff Creek Ranch', primaryStationId: 'KTXGIDDI2', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - 1/4 Notch', primaryStationId: 'KTXCEDAR422', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - Double Down', primaryStationId: 'KTXCEDAR422', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - Peddlers', primaryStationId: 'KTXAUSTI1134', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - Suburban Ninja', primaryStationId: 'KTXCEDAR264', dryingRateInPerDay: 1.15, maxDryingDays: 4, updatesEnabled: true },
  { name: 'Brushy - West', primaryStationId: 'KTXCEDAR192', dryingRateInPerDay: 0.58, maxDryingDays: 2, updatesEnabled: true },
  { name: 'Bull Creek', primaryStationId: 'KTXAUSTI3116', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Cat Mountain', primaryStationId: 'KTXAUSTI2379', dryingRateInPerDay: 0.58, maxDryingDays: 2, updatesEnabled: true },
  { name: 'Emma Long', primaryStationId: 'KTXAUSTI3019', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Flat Creek', primaryStationId: '', dryingRateInPerDay: 0, maxDryingDays: 0, updatesEnabled: false },
  { name: 'Flat Rock Ranch', primaryStationId: 'KTXCOMFO23', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Lake Georgetown', primaryStationId: 'KTXGEORG57', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Lakeway', primaryStationId: 'KTXLAKEW73', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Mary Moore Searight', primaryStationId: 'KTXAUSTI3751', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Maxwell Trail', primaryStationId: 'KTXAUSTI2365', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'McKinney Falls', primaryStationId: 'KTXAUSTI768', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Mule Shoe', primaryStationId: 'KTXSPICE194', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Pace Bend', primaryStationId: 'KTXLAGOV33', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Pedernales Falls', primaryStationId: 'KTXJOHNS3', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Reimers Ranch', primaryStationId: 'KTXSPICE61', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Reveille Peak Ranch', primaryStationId: 'KTXBURNE1295', dryingRateInPerDay: 0.29, maxDryingDays: 1, updatesEnabled: false },
  { name: 'Rocky Hill Ranch', primaryStationId: 'KTXSMITH82', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'SATN - east of mopac', primaryStationId: 'KTXAUSTI8', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'SATN - west of mopac', primaryStationId: 'KTXAUSTI2521', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Spider Mountain', primaryStationId: 'KTXBURNE711', dryingRateInPerDay: 0.29, maxDryingDays: 1, updatesEnabled: false },
  { name: 'St. Edwards', primaryStationId: 'KTXAUSTI1244', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Thumper', primaryStationId: 'KTXAUSTI1231', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Walnut Creek', primaryStationId: 'KTXAUSTI2479', dryingRateInPerDay: 0.86, maxDryingDays: 3, updatesEnabled: true },
];
