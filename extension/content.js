/**
 * Content script — runs on the Facebook group page.
 * Extracts posts from the visible feed when triggered by the popup.
 */

function extractPosts() {
  const articles = document.querySelectorAll('div[role="article"]');
  const posts = [];

  for (const article of articles) {
    try {
      // Skip nested articles (comments inside posts)
      if (article.parentElement?.closest('div[role="article"]')) continue;

      // Extract post text from dir="auto" divs (Facebook's text containers)
      let postText = '';
      const textEls = article.querySelectorAll('div[dir="auto"]');
      for (const el of textEls) {
        const text = el.textContent?.trim();
        // Skip short strings (buttons, labels) and pick the longest text block
        if (text && text.length > 20 && text.length > postText.length) {
          postText = text;
        }
      }
      if (!postText || postText.length < 10) continue;

      // Extract author name
      let authorName = 'Unknown';
      // Facebook puts author name in a link with strong tag, or in h3/h4
      const authorEl = article.querySelector('h3 a strong, h4 a strong, a[role="link"] strong');
      if (authorEl) {
        const name = authorEl.textContent?.trim();
        if (name && name.length > 0 && name.length < 100) {
          authorName = name;
        }
      }

      // Extract post ID from permalink
      let postId = '';
      const links = article.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/\/permalink\/(\d+)|\/posts\/(\d+)|story_fbid=(\d+)/);
        if (match) {
          postId = match[1] || match[2] || match[3];
          break;
        }
      }
      if (!postId) {
        postId = 'ext-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      }

      // Extract timestamp
      let timestamp = new Date().toISOString();
      const timeEl = article.querySelector('a[href*="/permalink/"] span, abbr[data-utime], time[datetime]');
      if (timeEl) {
        const utime = timeEl.getAttribute('data-utime');
        const datetime = timeEl.getAttribute('datetime');
        if (utime) {
          timestamp = new Date(parseInt(utime) * 1000).toISOString();
        } else if (datetime) {
          timestamp = new Date(datetime).toISOString();
        }
      }

      posts.push({
        postId,
        authorName,
        postText: postText.slice(0, 2000),
        timestamp,
      });
    } catch (e) {
      console.warn('Failed to parse post:', e);
    }
  }

  return posts;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'scrape') {
    const posts = extractPosts();
    sendResponse({ posts });
  }
  return true; // Keep channel open for async response
});
