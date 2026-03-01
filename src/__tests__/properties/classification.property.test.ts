import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { TrailReport, Classification } from '@/types';

// Feature: trail-conditions-predictor, Property 14: Classification output validity
// **Validates: Requirements 7.1, 7.3, 7.4**
// Feature: trail-conditions-predictor, Property 15: Fuzzy trail name extraction
// **Validates: Requirements 7.2**

// --- Mock the database (sql) used by classify() ---
vi.mock('@/lib/db', () => {
  const sqlMock = () => Promise.resolve({ rows: [], rowCount: 0 });
  return { sql: sqlMock };
});

import { classify, extractTrailNames } from '@/services/post-classifier';

// --- Constants ---

const VALID_CLASSIFICATIONS: Classification[] = ['dry', 'wet', 'inquiry', 'unrelated'];

const KNOWN_TRAIL_NAMES = [
  'Walnut Creek',
  'Thumper',
  'St. Edwards',
  'Spider Mountain',
  'SATN - east of mopac',
  'Maxwell Trail',
  'Reimers Ranch',
  'Pedernales Falls',
  'McKinney Falls',
  'Mary Moore Searight',
  'Emma Long',
  'Cat Mountain',
  'Bull Creek',
  'Brushy - West',
  'Bluff Creek Ranch',
  'BCGB - East',
];

// --- Generators ---

/** Pick a random valid classification */
const classificationArb = fc.constantFrom<Classification>('dry', 'wet', 'inquiry', 'unrelated');

/** Random confidence score in [0, 1] */
const confidenceArb = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/** Random post text — non-empty string */
const postTextArb = fc.string({ minLength: 1, maxLength: 500 });

/** Random post ID */
const postIdArb = fc.uuid();

/** Build a random TrailReport */
const trailReportArb = fc.record({
  postId: postIdArb,
  authorName: fc.string({ minLength: 1, maxLength: 50 }),
  postText: postTextArb,
  timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }),
  trailReferences: fc.constant([] as string[]),
  classification: fc.constant(null as Classification | null),
  confidenceScore: fc.constant(null as number | null),
  flaggedForReview: fc.constant(false),
});


// --- Helpers ---

/**
 * Create a mock OpenAI client that returns a specific classification and confidence.
 */
function createMockOpenAI(classification: Classification, confidence: number) {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  classification,
                  confidenceScore: confidence,
                }),
              },
            },
          ],
        }),
      },
    },
  } as unknown as import('openai').default;
}

/**
 * Create a mock OpenAI client that returns malformed/invalid JSON.
 */
function createBrokenMockOpenAI() {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: 'not valid json at all' } }],
        }),
      },
    },
  } as unknown as import('openai').default;
}

// --- Property Tests ---

describe('Property 14: Classification output validity', () => {
  it('for any trail report, classify() returns a valid classification, confidence in [0,1], and flaggedForReview=true when confidence < 0.6', async () => {
    await fc.assert(
      fc.asyncProperty(
        trailReportArb,
        classificationArb,
        confidenceArb,
        async (report, mockClassification, mockConfidence) => {
          const mockClient = createMockOpenAI(mockClassification, mockConfidence);

          const result = await classify(report, KNOWN_TRAIL_NAMES, mockClient);

          // Classification must be one of the valid values
          expect(VALID_CLASSIFICATIONS).toContain(result.classification);

          // Confidence score must be in [0, 1]
          expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
          expect(result.confidenceScore).toBeLessThanOrEqual(1);

          // If confidence < 0.6, flaggedForReview must be true
          if (result.confidenceScore < 0.6) {
            expect(result.flaggedForReview).toBe(true);
          }

          // postId should match the input report
          expect(result.postId).toBe(report.postId);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('classify() returns valid output even when OpenAI returns malformed JSON', async () => {
    await fc.assert(
      fc.asyncProperty(trailReportArb, async (report) => {
        const mockClient = createBrokenMockOpenAI();

        const result = await classify(report, KNOWN_TRAIL_NAMES, mockClient);

        // Should still return a valid classification (fallback to 'unrelated')
        expect(VALID_CLASSIFICATIONS).toContain(result.classification);

        // Confidence should still be in [0, 1]
        expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
        expect(result.confidenceScore).toBeLessThanOrEqual(1);

        // Low confidence from parse failure should flag for review
        expect(result.flaggedForReview).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Property 15: Fuzzy trail name extraction', () => {
  it('for any known trail name present in text (exact, case-insensitive), extractTrailNames() includes that trail', () => {
    const trailNameArb = fc.constantFrom(...KNOWN_TRAIL_NAMES);

    fc.assert(
      fc.property(
        trailNameArb,
        fc.constantFrom('', 'Just rode ', 'Anyone been to ', 'Trails are dry at ', 'Heading to '),
        fc.constantFrom('', ' today', ' this morning', ' looks great', ' is muddy'),
        (trailName, prefix, suffix) => {
          const text = `${prefix}${trailName}${suffix}`;
          const result = extractTrailNames(text, KNOWN_TRAIL_NAMES);
          expect(result).toContain(trailName);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('for any known trail name in UPPERCASE or lowercase, extractTrailNames() still finds it', () => {
    const trailNameArb = fc.constantFrom(...KNOWN_TRAIL_NAMES);

    const caseVariantArb = (name: string) =>
      fc.constantFrom(
        name.toUpperCase(),
        name.toLowerCase(),
        // Title case (first letter of each word capitalized)
        name.replace(/\b\w/g, (c) => c.toUpperCase())
      );

    fc.assert(
      fc.property(trailNameArb, (trailName) => {
        const variants = [
          trailName.toUpperCase(),
          trailName.toLowerCase(),
          trailName.replace(/\b\w/g, (c) => c.toUpperCase()),
        ];

        for (const variant of variants) {
          const text = `I just rode ${variant} and it was great`;
          const result = extractTrailNames(text, KNOWN_TRAIL_NAMES);
          expect(result).toContain(trailName);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('extractTrailNames() returns empty array for empty text or empty trail list', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        // Empty known trails list should always return empty
        expect(extractTrailNames(text, [])).toEqual([]);
        // Empty text should always return empty
        expect(extractTrailNames('', KNOWN_TRAIL_NAMES)).toEqual([]);
      }),
      { numRuns: 100 }
    );
  });
});
