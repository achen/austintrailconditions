import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateConfig } from '@/services/config-validator';

// Feature: trail-conditions-predictor, Property 16: Configuration validation rejects incomplete config
// **Validates: Requirements 8.2, 8.3**

const REQUIRED_ENV_VARS = [
  'WEATHER_API_KEY',
  'POSTGRES_URL',
] as const;

/**
 * Generates a complete valid env object, then removes a random non-empty subset
 * of the required keys. Returns the partial env and the list of missing keys.
 */
const incompleteEnvArb = fc
  .record({
    WEATHER_API_KEY: fc.string({ minLength: 1 }),
    POSTGRES_URL: fc.constant('postgresql://user:pass@host:5432/db'),
  })
  .chain((fullEnv) =>
    fc
      .subarray([...REQUIRED_ENV_VARS], { minLength: 1 })
      .map((keysToRemove) => {
        const partialEnv: Record<string, string> = { ...fullEnv };
        for (const key of keysToRemove) {
          delete partialEnv[key];
        }
        return { partialEnv, missingKeys: keysToRemove };
      })
  );

describe('Property 16: Configuration validation rejects incomplete config', () => {
  it('should throw an error naming each missing variable when at least one required env var is absent', () => {
    fc.assert(
      fc.property(incompleteEnvArb, ({ partialEnv, missingKeys }) => {
        expect(() => validateConfig(partialEnv)).toThrow();

        try {
          validateConfig(partialEnv);
        } catch (err: unknown) {
          const message = (err as Error).message;
          for (const key of missingKeys) {
            expect(message).toContain(key);
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
