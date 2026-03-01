const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const scrapeBtn = document.getElementById('scrapeBtn');
const apiUrlInput = document.getElementById('apiUrl');
const apiSecretInput = document.getElementById('apiSecret');

// Load saved config
chrome.storage?.local?.get(['apiUrl', 'apiSecret'], (data) => {
  if (data.apiUrl) apiUrlInput.value = data.apiUrl;
  if (data.apiSecret) apiSecretInput.value = data.apiSecret;
});

// Save config on change
apiUrlInput.addEventListener('change', () => {
  chrome.storage?.local?.set({ apiUrl: apiUrlInput.value });
});
apiSecretInput.addEventListener('change', () => {
  chrome.storage?.local?.set({ apiSecret: apiSecretInput.value });
});

function setStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = 'status ' + type;
}

scrapeBtn.addEventListener('click', async () => {
  const apiUrl = apiUrlInput.value.trim().replace(/\/$/, '');
  const apiSecret = apiSecretInput.value.trim();

  if (!apiUrl) {
    setStatus('Please enter your API URL first.', 'error');
    return;
  }
  if (!apiSecret) {
    setStatus('Please enter your Cron Secret.', 'error');
    return;
  }

  scrapeBtn.disabled = true;
  setStatus('Scraping posts from page...', 'info');

  try {
    // Get the active tab
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url?.includes('facebook.com/groups/325119181430845')) {
      setStatus('Please navigate to the Austin Trail Conditions Facebook group first.', 'warning');
      scrapeBtn.disabled = false;
      return;
    }

    // Send message to content script to scrape
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'scrape' });
    const posts = response?.posts || [];

    if (posts.length === 0) {
      setStatus('No posts found on page. Try scrolling down first.', 'warning');
      scrapeBtn.disabled = false;
      return;
    }

    countEl.textContent = posts.length;
    countEl.style.display = 'block';
    setStatus(`Found ${posts.length} posts. Sending to API...`, 'info');

    // Send to API
    const apiResponse = await fetch(`${apiUrl}/api/scrape/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiSecret}`,
      },
      body: JSON.stringify({ posts }),
    });

    if (!apiResponse.ok) {
      const err = await apiResponse.text();
      throw new Error(`API error ${apiResponse.status}: ${err}`);
    }

    const result = await apiResponse.json();
    setStatus(
      `Sent ${posts.length} posts. Stored: ${result.stored}, Classified: ${result.classified}`,
      'success'
    );
  } catch (err) {
    setStatus('Error: ' + err.message, 'error');
  } finally {
    scrapeBtn.disabled = false;
  }
});
