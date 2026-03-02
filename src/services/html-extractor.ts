import OpenAI from 'openai';

export interface ExtractedPost {
  postId: string;
  authorName: string;
  postText: string;
  timestamp: string;
  comments: Array<{
    authorName: string;
    commentText: string;
  }>;
}

const EXTRACTION_PROMPT = `You are an HTML parser for Facebook group posts. Given the HTML of a Facebook post article, extract:

1. The main post text (what the author wrote)
2. The author name if visible
3. Any comments and their authors

IMPORTANT:
- The post text is usually in div[dir="auto"] elements NOT inside nested div[role="article"] elements
- Comments are inside nested div[role="article"] elements
- Ignore UI text like "Like", "Reply", "Share", timestamps, "Write a comment", etc.
- Ignore photo/video captions that are just file descriptions
- Return ONLY the actual human-written content

Respond with JSON:
{
  "postText": "the main post content",
  "authorName": "Author Name or Unknown",
  "comments": [
    {"authorName": "Commenter Name", "commentText": "their comment"}
  ]
}`;

/**
 * Use AI to extract post text and comments from raw Facebook HTML.
 * Returns extracted posts with the original postId preserved.
 */
export async function extractFromHtml(
  posts: Array<{ postId: string; postHtml: string; timestamp: string }>,
  openaiClient?: OpenAI
): Promise<ExtractedPost[]> {
  const client = openaiClient ?? new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const results: ExtractedPost[] = [];

  for (const post of posts) {
    try {
      const response = await client.chat.completions.create({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: EXTRACTION_PROMPT },
          { role: 'user', content: post.postHtml },
        ],
        temperature: 0,
        max_tokens: 2000,
      });

      const content = response.choices[0]?.message?.content ?? '';
      const parsed = JSON.parse(content);

      if (parsed.postText && parsed.postText.trim().length > 0) {
        results.push({
          postId: post.postId,
          authorName: parsed.authorName || 'Unknown',
          postText: parsed.postText.trim().slice(0, 2000),
          timestamp: post.timestamp,
          comments: (parsed.comments || []).map((c: { authorName?: string; commentText?: string }) => ({
            authorName: c.authorName || 'Unknown',
            commentText: (c.commentText || '').trim().slice(0, 2000),
          })).filter((c: { commentText: string }) => c.commentText.length > 0),
        });
      }
    } catch (err) {
      console.error(`AI extraction failed for ${post.postId}:`, err);
    }
  }

  return results;
}
