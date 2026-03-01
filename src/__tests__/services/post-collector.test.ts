import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchPosts } from '@/services/post-collector';

describe('PostCollector', () => {
  describe('fetchPosts', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('parses Facebook Graph API response correctly', async () => {
      const mockResponse = {
        data: [
          {
            id: '123_456',
            from: { name: 'Jane Rider' },
            message: 'Walnut Creek is dry and rideable!',
            created_time: '2024-07-15T10:30:00+0000',
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const posts = await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(posts).toHaveLength(1);
      expect(posts[0].postId).toBe('123_456');
      expect(posts[0].authorName).toBe('Jane Rider');
      expect(posts[0].postText).toBe('Walnut Creek is dry and rideable!');
      expect(posts[0].timestamp).toEqual(new Date('2024-07-15T10:30:00+0000'));
      expect(posts[0].trailReferences).toEqual([]);
      expect(posts[0].classification).toBeNull();
      expect(posts[0].confidenceScore).toBeNull();
      expect(posts[0].flaggedForReview).toBe(false);
    });

    it('returns empty array on API error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
      } as Response);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const posts = await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(posts).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('returns empty array when response has no data array', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'no data' }),
      } as Response);

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const posts = await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(posts).toEqual([]);
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('filters out posts without a message', async () => {
      const mockResponse = {
        data: [
          {
            id: '123_456',
            from: { name: 'Jane Rider' },
            message: 'Trail is great today!',
            created_time: '2024-07-15T10:30:00+0000',
          },
          {
            id: '123_789',
            from: { name: 'Photo Poster' },
            created_time: '2024-07-15T11:00:00+0000',
            // no message field
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const posts = await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(posts).toHaveLength(1);
      expect(posts[0].postId).toBe('123_456');
    });

    it('defaults author name to Unknown when from is missing', async () => {
      const mockResponse = {
        data: [
          {
            id: '123_456',
            message: 'Anonymous trail report',
            created_time: '2024-07-15T10:30:00+0000',
          },
        ],
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const posts = await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(posts[0].authorName).toBe('Unknown');
    });

    it('constructs the correct API URL without since parameter', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      await fetchPosts('group123', 'token456', undefined, 'https://graph.facebook.com/v18.0');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://graph.facebook.com/v18.0/group123/feed?access_token=token456&fields=id,from,message,created_time'
      );
    });

    it('includes since parameter as unix timestamp when provided', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ data: [] }),
      } as Response);

      const since = new Date('2024-07-15T00:00:00Z');
      await fetchPosts('group123', 'token456', since, 'https://graph.facebook.com/v18.0');

      const expectedTimestamp = Math.floor(since.getTime() / 1000);
      expect(fetchSpy).toHaveBeenCalledWith(
        `https://graph.facebook.com/v18.0/group123/feed?access_token=token456&fields=id,from,message,created_time&since=${expectedTimestamp}`
      );
    });
  });
});
