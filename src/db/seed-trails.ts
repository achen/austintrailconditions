import type { SeedTrail } from '../types';

/**
 * 30 pre-configured Central Texas mountain bike trails.
 *
 * Each trail includes its primary Weather Underground station ID,
 * drying rate (inches of rain dried per day), maximum drying days,
 * and whether automated weather updates are enabled.
 */
export const seedTrails: SeedTrail[] = [
  { name: 'Walnut Creek', primaryStationId: 'KTXAUSTI2479', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Thumper', primaryStationId: 'KTXAUSTI12445', dryingRateInPerDay: 3, maxDryingDays: 3, updatesEnabled: true },
  { name: 'St. Edwards', primaryStationId: 'KTXAUSTI1655', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Spider Mountain', primaryStationId: 'KTXBURNE711', dryingRateInPerDay: 0, maxDryingDays: 1, updatesEnabled: false },
  { name: 'SATN - east of mopac', primaryStationId: 'KTXAUSTI8', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'SATN - west of mopac', primaryStationId: 'KTXAUSTI25', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Maxwell Trail', primaryStationId: 'KTXAUSTI2587', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Rocky Hill Ranch', primaryStationId: 'KTXSMITH825', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Reveille Peak Ranch', primaryStationId: 'KTXBURNE1295', dryingRateInPerDay: 0, maxDryingDays: 1, updatesEnabled: false },
  { name: 'Reimers Ranch', primaryStationId: 'KTXSPICE395', dryingRateInPerDay: 3, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Pedernales Falls', primaryStationId: 'KTXJOHNS3', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Pace Bend', primaryStationId: 'KTXMARBL115', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Mule Shoe', primaryStationId: 'KTXSPICE1235', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'McKinney Falls', primaryStationId: 'KTXAUSTI768', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Mary Moore Searight', primaryStationId: 'KTXAUSTI18214', dryingRateInPerDay: 3, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Lakeway', primaryStationId: 'KTXTHEHI45', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Lake Georgetown', primaryStationId: 'KTXGEORG7815', dryingRateInPerDay: 3, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Flat Rock Ranch', primaryStationId: 'KTXCOMFO545', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Flat Creek', primaryStationId: '', dryingRateInPerDay: 0, maxDryingDays: 0, updatesEnabled: false },
  { name: 'Emma Long', primaryStationId: 'KTXAUSTI30195', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Cat Mountain', primaryStationId: 'KTXAUSTI36535', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Bull Creek', primaryStationId: 'KTXAUSTI31165', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - West', primaryStationId: 'KTXCEDAR192', dryingRateInPerDay: 2.5, maxDryingDays: 2, updatesEnabled: true },
  { name: 'Brushy - Suburban Ninja', primaryStationId: 'KTXCEDAR264', dryingRateInPerDay: 2.5, maxDryingDays: 4, updatesEnabled: true },
  { name: 'Brushy - Double Down', primaryStationId: 'KTXAUSTI36925', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - 1/4 Notch', primaryStationId: 'KTXAUSTI36925', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Brushy - Peddlers', primaryStationId: 'KTXAUSTI1134', dryingRateInPerDay: 2.5, maxDryingDays: 3, updatesEnabled: true },
  { name: 'Bluff Creek Ranch', primaryStationId: 'KTXLAGRA775', dryingRateInPerDay: 1, maxDryingDays: 3, updatesEnabled: true },
  { name: 'BCGB - East', primaryStationId: 'KTXAUSTI22775', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
  { name: 'BCGB - West', primaryStationId: 'KTXAUSTI32465', dryingRateInPerDay: 2, maxDryingDays: 3, updatesEnabled: true },
];
