import { describe, it, expect, vi, beforeEach } from 'vitest';
import { extractTrailNames, classify } from '@/services/post-classifier';
import { TrailReport } from '@/types';

const KNOWN_TRAILS = [
  'Walnut Creek',
  'Brushy - West',
  'Emma Long',
  'St. Edwards',
  'McKinney Falls',
  'Spider Mountain',
];

function makeReport(overrides: Partial<TrailReport> = {}): TrailReport {
  return {
    postId: 'post-1',
    authorName: 'Test User',
    postText: 'Walnut Creek is dry today!',
    timestamp: new Date('2024-07-15T10:00:00Z'),
    trailReferences: [],
    classification: null,
    confidenceScore: null,
    flaggedForReview: false,
    ...overrides,
  };
}

describe('PostClassifier', () => {
  describe('extractTrailNames', () => {
    it('finds exact trail name match (case-insensitive)', () => {
      const result = extractTrailNames('walnut creek is looking good', KNOWN_TRAILS);
      expect(result).toEqual(['Walnut Creek']);
    });

    it('finds multiple trail names in one text', () => {
      const result = extractTrailNames(
        'Walnut Creek and Emma Long are both dry',
        KNOWN_TRAILS
      );
      expect(result).toContain('Walnut Creek');
      expect(result).toContain('Emma Long');
    });

    it('returns empty array for empty text', () => {
      expect(extractTrailNames('', KNOWN_TRAILS)).toEqual([]);
    });

    it('returns empty array for empty trail list', () => {
      expect(extractTrailNames('Walnut Creek is dry', [])).toEqual([]);
    });

    it('handles minor typos via fuzzy matching', () => {
      const result = extractTrailNames('walnut crek is dry', KNOWN_TRAILS);
      expect(result).toEqual(['Walnut Creek']);
    });

    it('does not match completely unrelated text', () => {
      const result = extractTrailNames('Going to the grocery store', KNOWN_TRAILS);
      expect(result).toEqual([]);
    });

    it('deduplicates matches', () => {
      const result = extractTrailNames(
        'Walnut Creek is great. Rode Walnut Creek again.',
        KNOWN_TRAILS
      );
      expect(result).toEqual(['Walnut Creek']);
    });

    it('matches trail names with special characters', () => {
      const result = extractTrailNames('Brushy - West is muddy', KNOWN_TRAILS);
      expect(result).toContain('Brushy - West');
    });
  });

  describe('classify', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('classifies a dry trail report with high confidence', async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      classification: 'dry',
                      confidenceScore: 0.95,
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      // Mock sql to avoid DB calls
      vi.mock('@/lib/db', () => ({
        sql: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }));

      const report = makeReport({ postText: 'Walnut Creek is dry and rideable!' });
      const result = await classify(report, KNOWN_TRAILS, mockOpenAI);

      expect(result.postId).toBe('post-1');
      expect(result.classification).toBe('dry');
      expect(result.confidenceScore).toBe(0.95);
      expect(result.flaggedForReview).toBe(false);
      expect(result.trailReferences).toContain('Walnut Creek');
    });

    it('flags low-confidence classifications for review', async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      classification: 'wet',
                      confidenceScore: 0.4,
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      vi.mock('@/lib/db', () => ({
        sql: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }));

      const report = makeReport({ postText: 'Maybe muddy at Emma Long?' });
      const result = await classify(report, KNOWN_TRAILS, mockOpenAI);

      expect(result.classification).toBe('wet');
      expect(result.confidenceScore).toBe(0.4);
      expect(result.flaggedForReview).toBe(true);
    });

    it('handles OpenAI API failure gracefully', async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: vi.fn().mockRejectedValue(new Error('API timeout')),
          },
        },
      } as any;

      vi.mock('@/lib/db', () => ({
        sql: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }));

      vi.spyOn(console, 'error').mockImplementation(() => {});

      const report = makeReport();
      const result = await classify(report, KNOWN_TRAILS, mockOpenAI);

      expect(result.classification).toBe('unrelated');
      expect(result.confidenceScore).toBe(0.0);
      expect(result.flaggedForReview).toBe(true);
    });

    it('handles malformed OpenAI response', async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [{ message: { content: 'not valid json' } }],
            }),
          },
        },
      } as any;

      vi.mock('@/lib/db', () => ({
        sql: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }));

      const report = makeReport();
      const result = await classify(report, KNOWN_TRAILS, mockOpenAI);

      expect(result.classification).toBe('unrelated');
      expect(result.confidenceScore).toBe(0.0);
      expect(result.flaggedForReview).toBe(true);
    });

    it('handles invalid classification value from OpenAI', async () => {
      const mockOpenAI = {
        chat: {
          completions: {
            create: vi.fn().mockResolvedValue({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      classification: 'maybe_dry',
                      confidenceScore: 0.8,
                    }),
                  },
                },
              ],
            }),
          },
        },
      } as any;

      vi.mock('@/lib/db', () => ({
        sql: vi.fn().mockResolvedValue({ rowCount: 1 }),
      }));

      const report = makeReport();
      const result = await classify(report, KNOWN_TRAILS, mockOpenAI);

      // Invalid classification should fall back to 'unrelated'
      expect(result.classification).toBe('unrelated');
    });
  });
});
