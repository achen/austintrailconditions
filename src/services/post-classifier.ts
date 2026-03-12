import OpenAI from 'openai';
import { TrailReport, ClassificationResult, Classification } from '@/types';
import { sql } from '@/lib/db';
import { notifyUnmatchedTrailPost } from '@/services/notification-service';

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
 * Extract trail names from text using fuzzy matching against a known trail list
 * and their aliases (segment names, nicknames).
 * Handles case variations and minor typos via Levenshtein distance.
 */
export function extractTrailNames(
  text: string,
  knownTrails: string[],
  aliasMap?: Map<string, string>
): string[] {
  if (!text || knownTrails.length === 0) return [];

  const lowerText = text.toLowerCase();
  const matched: string[] = [];

  // Check trail names
  for (const trail of knownTrails) {
    const lowerTrail = trail.toLowerCase();

    if (lowerText.includes(lowerTrail)) {
      matched.push(trail);
      continue;
    }

    const words = lowerText.split(/\s+/);
    const trailWords = lowerTrail.split(/\s+/);
    const windowSize = trailWords.length;

    for (let i = 0; i <= words.length - windowSize; i++) {
      const window = words.slice(i, i + windowSize).join(' ');
      const distance = levenshteinDistance(window, lowerTrail);
      const maxDistance = Math.max(1, Math.floor(lowerTrail.length * 0.25));

      if (distance <= maxDistance) {
        matched.push(trail);
        break;
      }
    }
  }

  // Check aliases — map back to parent trail name
  if (aliasMap) {
    for (const [alias, parentTrail] of Array.from(aliasMap.entries())) {
      const lowerAlias = alias.toLowerCase();

      if (lowerText.includes(lowerAlias)) {
        matched.push(parentTrail);
        continue;
      }

      // Fuzzy match aliases too
      const words = lowerText.split(/\s+/);
      const aliasWords = lowerAlias.split(/\s+/);
      const windowSize = aliasWords.length;

      for (let i = 0; i <= words.length - windowSize; i++) {
        const window = words.slice(i, i + windowSize).join(' ');
        const distance = levenshteinDistance(window, lowerAlias);
        const maxDistance = Math.max(1, Math.floor(lowerAlias.length * 0.25));

        if (distance <= maxDistance) {
          matched.push(parentTrail);
          break;
        }
      }
    }
  }

  return Array.from(new Set(matched));
}

/**
 * Build the system prompt for OpenAI classification.
 */
function buildSystemPrompt(knownTrails: string[], aliasMap?: Map<string, string>): string {
  // Build trail list with aliases for the AI
  let trailInfo = knownTrails.join(', ');
  if (aliasMap && aliasMap.size > 0) {
    // Group aliases by parent trail
    const grouped = new Map<string, string[]>();
    for (const [alias, parent] of Array.from(aliasMap.entries())) {
      if (!grouped.has(parent)) grouped.set(parent, []);
      grouped.get(parent)!.push(alias);
    }
    const lines = Array.from(grouped.entries())
      .map(([parent, aliases]) => `${parent} (also known as: ${aliases.join(', ')})`)
      .join('\n');
    trailInfo = knownTrails
      .map(t => {
        const aliases = grouped.get(t);
        return aliases ? `${t} (segments/aliases: ${aliases.join(', ')})` : t;
      })
      .join('\n');
  }

  return `You are a trail condition classifier for mountain bike trails near Austin, TX. Analyze the given Facebook post and classify it into one of these categories:

- "dry": The post indicates a trail is dry, rideable, or in good condition.
- "wet": The post indicates a trail is wet, muddy, or not rideable.
- "inquiry": The post is asking about trail conditions.
- "unrelated": The post is not about trail conditions.

Common slang in this community:
- "GTG" or "g2g" = "good to go" = dry/rideable
- "primo" = excellent condition = dry
- "tacky" = slightly moist but rideable = dry
- "hero dirt" = perfect conditions = dry
- "not g2g" or "not GTG" = not rideable = wet
- "chocolate cake" or "peanut butter" = very muddy = wet

Also provide a confidence score between 0 and 1 for your classification.

IMPORTANT: Trail systems have multiple segments. If someone mentions a segment name, it refers to the parent trail. For example, if someone says "Rim Job was great today", that refers to Brushy - West.

Known trails and their segments:
${trailInfo}

Respond ONLY with valid JSON in this exact format:
{"classification": "dry|wet|inquiry|unrelated", "confidenceScore": 0.0, "trailReferences": ["Trail Name"]}`;
}

/**
 * Parse the OpenAI response into a classification and confidence score.
 * Falls back to "unrelated" with low confidence if parsing fails.
 */
function parseClassificationResponse(content: string): {
  classification: Classification;
  confidenceScore: number;
  trailReferences: string[];
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

    const trailReferences = Array.isArray(parsed.trailReferences)
      ? parsed.trailReferences.filter((t: unknown) => typeof t === 'string')
      : [];

    return { classification, confidenceScore, trailReferences };
  } catch {
    return { classification: 'unrelated', confidenceScore: 0.0, trailReferences: [] };
  }
}

/**
 * Classify a trail report using OpenAI.
 * Sends the post text to OpenAI for classification and trail matching.
 * The AI determines which trail(s) are referenced from the known trail list.
 * Flags posts with confidence < 0.6 for manual review.
 */
export async function classify(
  report: TrailReport,
  knownTrails: string[],
  openaiClient?: OpenAI
): Promise<ClassificationResult> {
  const client = openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Load aliases from DB
  const aliasResult = await sql`
    SELECT name, aliases FROM trails
    WHERE is_archived = false AND aliases IS NOT NULL AND array_length(aliases, 1) > 0
  `;
  const aliasMap = new Map<string, string>();
  for (const row of aliasResult.rows) {
    const parentName = row.name as string;
    const aliases = row.aliases as string[];
    for (const alias of aliases) {
      aliasMap.set(alias, parentName);
    }
  }

  let trailReferences: string[] = [];
  let classification: Classification;
  let confidenceScore: number;

  try {
    const response = await client.chat.completions.create({
      model: 'gpt-5.2',
      messages: [
        { role: 'system', content: buildSystemPrompt(knownTrails, aliasMap) },
        { role: 'user', content: report.postText },
      ],
      temperature: 0.1,
      max_completion_tokens: 100,
    });

    const content = response.choices[0]?.message?.content ?? '';
    const parsed = parseClassificationResponse(content);
    classification = parsed.classification;
    confidenceScore = parsed.confidenceScore;
    // Only keep trail names the AI returned that are actually in our known list
    trailReferences = parsed.trailReferences.filter(t => knownTrails.includes(t));
  } catch (error) {
    console.error('OpenAI classification error:', error);
    classification = 'unrelated';
    confidenceScore = 0.0;
  }

  // If this is a comment with no trail matches, inherit from the parent post
  if (trailReferences.length === 0 && report.parentPostId) {
    const parentResult = await sql`
      SELECT trail_references FROM trail_reports
      WHERE post_id = ${report.parentPostId}
        AND trail_references IS NOT NULL
        AND array_length(trail_references, 1) > 0
      LIMIT 1
    `;
    if (parentResult.rows.length > 0) {
      trailReferences = parentResult.rows[0].trail_references as string[];
    }
  }

  const flaggedForReview = confidenceScore < CONFIDENCE_THRESHOLD;

  // Alert if a dry/wet post couldn't be matched to any trail
  if (trailReferences.length === 0 && (classification === 'dry' || classification === 'wet')) {
    notifyUnmatchedTrailPost(report.postText, classification, confidenceScore, report.postId)
      .catch(err => console.error('Failed to send unmatched trail notification:', err));
  }

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
