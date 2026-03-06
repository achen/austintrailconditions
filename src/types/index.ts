// Trail Conditions Predictor — Shared Type Definitions

// --- Condition Status ---

export type ConditionStatus =
  | 'Observed Dry'
  | 'Predicted Dry'
  | 'Predicted Wet'
  | 'Observed Wet'
  | 'Closed';

// --- Classification ---

export type Classification = 'dry' | 'wet' | 'inquiry' | 'unrelated';

// --- Trail ---

export interface Trail {
  id: string;
  name: string;
  description: string | null;
  primaryStationId: string;
  dryingRateInPerDay: number;
  maxDryingDays: number;
  updatesEnabled: boolean;
  isArchived: boolean;
  conditionStatus: ConditionStatus;
  aliases: string[];
  createdAt: Date;
  updatedAt: Date;
}

// --- Weather ---

export interface WeatherObservation {
  stationId: string;
  trailId?: string;
  timestamp: Date;
  precipitationIn: number;
  temperatureF: number;
  humidityPercent: number;
  windSpeedMph: number;
  solarRadiationWm2: number;
  daylightHours: number;
}

// --- Rain Events ---

export interface RainEvent {
  id: string;
  trailId: string;
  startTimestamp: Date;
  endTimestamp: Date | null;
  totalPrecipitationIn: number;
  isActive: boolean;
}

// --- Trail Reports ---

export interface TrailReport {
  postId: string;
  parentPostId?: string | null;
  isComment?: boolean;
  authorName: string;
  postText: string;
  timestamp: Date;
  trailReferences: string[];
  classification: Classification | null;
  confidenceScore: number | null;
  flaggedForReview: boolean;
}

// --- Classification Result ---

export interface ClassificationResult {
  postId: string;
  classification: Classification;
  trailReferences: string[];
  confidenceScore: number;
  flaggedForReview: boolean;
}

// --- Predictions ---

export interface HistoricalOutcome {
  precipitationIn: number;
  predictedDryTime: Date;
  actualDryTime: Date;
  weatherConditions: Partial<WeatherObservation>;
}

export interface PredictionInput {
  totalPrecipitationIn: number;
  dryingRateInPerDay: number;
  maxDryingDays: number;
  temperatureF: number;
  humidityPercent: number;
  windSpeedMph: number;
  solarRadiationWm2: number;
  daylightHours: number;
  historicalOutcomes: HistoricalOutcome[];
}

export interface Prediction {
  id: string;
  trailId: string;
  rainEventId: string;
  predictedDryTime: Date;
  actualDryTime: Date | null;
  createdAt: Date;
  updatedAt: Date;
  inputData: PredictionInput;
}

// --- Configuration ---

export interface AppConfig {
  weatherUnderground: { apiKey: string };
  facebook: { accessToken: string; groupId: string };
  openai: { apiKey: string };
  postgres: { url: string };
  cron: {
    weatherIntervalMin: number;
    facebookIntervalMin: number;
    predictionIntervalMin: number;
  };
}

// --- Seed Data ---

export interface SeedTrail {
  name: string;
  primaryStationId: string;
  dryingRateInPerDay: number;
  maxDryingDays: number;
  updatesEnabled: boolean;
}
