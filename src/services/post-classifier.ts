import OpenAI from 'openai';
import { TrailReport, ClassificationResult, Classification } from '@/types';
import { sql } from '@/lib/db';

const VALID_CLASSIFICATIONS: Classification[] = ['dry', 'wet', 'inquiry', 'unrelated'];
const CONFIDENCE_THRESHOLD = 0.6;

/**
 * Compute Levenshtein distance between two strings.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}

/**
 * Extract trail names from text using fuzzy matching against a known trail list.
 * Handles case variations and minor typos via Levenshtein distance.
 */
export function extractTrailNames(text: string, knownTrails: string[]): string[] {
  if (!text || knownTrails.length === 0) return [];

  const lowerText = text.toLowerCase();
  const matched: string[] = [];

  for (const trail of knownTrails) {
    const lowerTrail = trail.toLowerCase();

    // Exact substring match (case-insensitive)
    if (lowerText.includes(lowerTrail)) {
      matched.push(trail);
      continue;
    }

    // Fuzzy match: split text into sliding windows of similar length to the trail name
    // and check Levenshtein distance
    const words = lowerText.split(/\s+/);
    const trailWords = lowerTrail.split(/\s+/);
    const windowSize = trailWords.length;

    for (let i = 0; i <= words.length - windowSize; i++) {
      const window = words.slice(i, i + windowSize).join(' ');
      const distance = levenshteinDistance(window, lowerTrail);
      // Allow up to ~25% character difference for fuzzy matching
      const maxDistance = Math.max(1, Math.floor(lowerTrail.length * 0.25));

      if (distance <= maxDistance) {
        matched.push(trail);
        break;
      }
    }
  }

  return Array.from(new Set(matched));
}

/**
 * Build the system prompt for OpenAI classification.
 */
function buildSystemPrompt(knownTrails: string[]): string {
  return `You are a trail condition classifier for mountain bike trails. Analyze the given Facebook post and classify it into one of these categories:

- "dry": The post indicates a trail is dry, rideable, or in good condition.
- "wet": The post indicates a trail is wet, muddy, or not rideable.
- "inquiry": The post is asking about trail conditions.
- "unrelated": The post is not about trail conditions.

Also provide a confidence score between 0 and 1 for your classification.

Known trails: ${knownTrails.join(', ')}

Respond ONLY with valid JSON in this exact format:
{"classification": "dry|wet|inquiry|unrelated", "confidenceScore": 0.0}`;
}

/**
 * Parse the OpenAI response into a classification and confidence score.
 * Falls back to "unrelated" with low confidence if parsing fails.
 */
function parseClassificationResponse(content: string): {
  classification: Classification;
  confidenceScore: number;
} {
  try {
    const parsed = JSON.parse(content);

    const classification = VALID_CLASSIFICATIONS.includes(parsed.classification)
      ? (parsed.classification as Classification)
      : 'unrelated';

    const confidenceScore =
      typeof parsed.confidenceScore === 'number' &&
      parsed.confidenceScore >= 0 &&
      parsed.confidenceScore <= 1
        ? parsed.confidenceScore
        : 0.5;

    return { classification, confidenceScore };
  } catch {
    return { classification: 'unrelated', confidenceScore: 0.0 };
  }
}

/**
 * Classify a trail report using OpenAI.
 * Sends the post text to OpenAI for classification and extracts trail names via fuzzy matching.
 * Flags posts with confidence < 0.6 for manual review.
 */
export async function classify(
  report: TrailReport,
  knownTrails: string[],
  openaiClient?: OpenAI
): Promise<ClassificationResult> {
  const client = openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const trailReferences = extractTrailNames(report.postText, knownTrails);

  let classification: Classification;
  let confidenceScore: number;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(knownTrails) },
        { role: 'user', content: report.postText },
      ],
      temperature: 0.1,
      max_tokens: 100,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const parsed = parseClassificationResponse(content);
    classification = parsed.classification;
    confidenceScore = parsed.confidenceScore;
  } catch (error) {
    console.error('OpenAI classification error:', error);
    // On API failure, mark as unrelated with zero confidence so it gets flagged
    classification = 'unrelated';
    confidenceScore = 0.0;
  }

  const flaggedForReview = confidenceScore < CONFIDENCE_THRESHOLD;

  // Update the trail report in the database with classification results
  await sql`
    UPDATE trail_reports
    SET
      classification = ${classification},
      confidence_score = ${confidenceScore},
      trail_references = ${trailReferences as string[]},
      flagged_for_review = ${flaggedForReview}
    WHERE post_id = ${report.postId}
  `;

  return {
    postId: report.postId,
    classification,
    trailReferences,
    confidenceScore,
    flaggedForReview,
  };
}
