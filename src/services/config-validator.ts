import { AppConfig } from '@/types';

const DEFAULT_CRON_INTERVALS = {
  weatherIntervalMin: 60,
  facebookIntervalMin: 30,
  predictionIntervalMin: 30,
};

/**
 * Validates all required environment variables are present and correctly formatted.
 * Throws a descriptive error naming each missing or malformed variable.
 */
export function validateConfig(
  env: Record<string, string | undefined> = process.env
): AppConfig {
  const errors: string[] = [];

  // Always required
  for (const varName of ['WEATHER_API_KEY', 'POSTGRES_URL'] as const) {
    const value = env[varName];
    if (!value || value.trim() === '') {
      errors.push(`Missing required environment variable: ${varName}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  // Format validation
  const postgresUrl = (env.POSTGRES_URL || env.DATABASE_URL || '').trim();
  if (
    !postgresUrl.startsWith('postgres://') &&
    !postgresUrl.startsWith('postgresql://')
  ) {
    errors.push('POSTGRES_URL must start with postgres:// or postgresql://');
  }

  if (errors.length > 0) {
    throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
  }

  return {
    weatherUnderground: { apiKey: env.WEATHER_API_KEY!.trim() },
    facebook: {
      accessToken: env.FACEBOOK_ACCESS_TOKEN?.trim() ?? '',
      groupId: env.FACEBOOK_GROUP_ID?.trim() ?? '',
    },
    openai: { apiKey: env.OPENAI_API_KEY?.trim() ?? '' },
    postgres: { url: postgresUrl },
    cron: { ...DEFAULT_CRON_INTERVALS },
  };
}
