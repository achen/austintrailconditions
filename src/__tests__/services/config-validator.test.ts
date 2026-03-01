import { describe, it, expect } from 'vitest';
import { validateConfig } from '@/services/config-validator';

const validEnv: Record<string, string> = {
  WEATHER_API_KEY: 'wu-api-key-123',
  FACEBOOK_ACCESS_TOKEN: 'fb-token-abc',
  FACEBOOK_GROUP_ID: '123456789',
  OPENAI_API_KEY: 'sk-openai-key-xyz',
  POSTGRES_URL: 'postgresql://user:pass@host:5432/db',
};

describe('ConfigValidator', () => {
  it('returns a valid AppConfig when all env vars are present', () => {
    const config = validateConfig(validEnv);

    expect(config.weatherUnderground.apiKey).toBe('wu-api-key-123');
    expect(config.facebook.accessToken).toBe('fb-token-abc');
    expect(config.facebook.groupId).toBe('123456789');
    expect(config.openai.apiKey).toBe('sk-openai-key-xyz');
    expect(config.postgres.url).toBe('postgresql://user:pass@host:5432/db');
    expect(config.cron.weatherIntervalMin).toBe(60);
    expect(config.cron.facebookIntervalMin).toBe(30);
    expect(config.cron.predictionIntervalMin).toBe(30);
  });

  it('accepts POSTGRES_URL with postgres:// prefix', () => {
    const env = { ...validEnv, POSTGRES_URL: 'postgres://user:pass@host/db' };
    const config = validateConfig(env);
    expect(config.postgres.url).toBe('postgres://user:pass@host/db');
  });

  it('throws when WEATHER_API_KEY is missing', () => {
    const env = { ...validEnv };
    delete env.WEATHER_API_KEY;
    expect(() => validateConfig(env)).toThrow('WEATHER_API_KEY');
  });

  it('defaults facebook and openai to empty strings when not provided', () => {
    const env = { WEATHER_API_KEY: 'key', POSTGRES_URL: 'postgresql://host/db' };
    const config = validateConfig(env);
    expect(config.facebook.accessToken).toBe('');
    expect(config.facebook.groupId).toBe('');
    expect(config.openai.apiKey).toBe('');
  });

  it('throws when POSTGRES_URL is missing', () => {
    const env = { ...validEnv };
    delete env.POSTGRES_URL;
    expect(() => validateConfig(env)).toThrow('POSTGRES_URL');
  });

  it('throws when multiple required env vars are missing', () => {
    const env = { FACEBOOK_ACCESS_TOKEN: 'fb' };
    expect(() => validateConfig(env)).toThrow('WEATHER_API_KEY');
    expect(() => validateConfig(env)).toThrow('POSTGRES_URL');
  });

  it('throws when an env var is an empty string', () => {
    const env = { ...validEnv, WEATHER_API_KEY: '' };
    expect(() => validateConfig(env)).toThrow('WEATHER_API_KEY');
  });

  it('throws when a required env var is whitespace only', () => {
    const env = { ...validEnv, WEATHER_API_KEY: '   ' };
    expect(() => validateConfig(env)).toThrow('WEATHER_API_KEY');
  });

  it('throws when POSTGRES_URL has invalid prefix', () => {
    const env = { ...validEnv, POSTGRES_URL: 'mysql://user:pass@host/db' };
    expect(() => validateConfig(env)).toThrow('POSTGRES_URL must start with postgres://');
  });

  it('trims whitespace from values', () => {
    const env = {
      ...validEnv,
      WEATHER_API_KEY: '  wu-key  ',
      POSTGRES_URL: '  postgresql://host/db  ',
    };
    const config = validateConfig(env);
    expect(config.weatherUnderground.apiKey).toBe('wu-key');
    expect(config.postgres.url).toBe('postgresql://host/db');
  });
});
