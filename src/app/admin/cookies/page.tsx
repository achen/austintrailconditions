'use client';

import { useState, FormEvent } from 'react';

/**
 * Admin page for updating Facebook cookies.
 * Provides a simple form to paste new cookies when they expire.
 */
export default function CookiesPage() {
  const [cookies, setCookies] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!cookies.trim()) return;

    setLoading(true);
    setResult(null);

    try {
      const res = await fetch('/api/admin/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookies: cookies.trim() }),
      });
      const data = await res.json();

      if (res.ok) {
        setResult({ ok: true, message: data.message || 'Cookies updated successfully' });
        setCookies('');
      } else {
        setResult({ ok: false, message: data.error || 'Failed to update cookies' });
      }
    } catch (err) {
      setResult({ ok: false, message: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Update Facebook Cookies</h1>
          <a href="/admin" className="text-sm text-blue-600 hover:underline">← Admin</a>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-6 space-y-4">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
          <p className="font-medium mb-2">How to get your Facebook cookies:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Open <a href="https://www.facebook.com" target="_blank" rel="noopener noreferrer" className="underline">facebook.com</a> in Chrome and log in</li>
            <li>Open DevTools (F12) → Application tab → Cookies → facebook.com</li>
            <li>Copy the values for: <code className="bg-blue-100 px-1 rounded">c_user</code>, <code className="bg-blue-100 px-1 rounded">xs</code>, <code className="bg-blue-100 px-1 rounded">fr</code>, <code className="bg-blue-100 px-1 rounded">datr</code></li>
            <li>Paste them below as a semicolon-separated string, e.g.: <code className="bg-blue-100 px-1 rounded text-xs">c_user=123;xs=abc;fr=def;datr=ghi</code></li>
          </ol>
        </div>

        {result && (
          <div className={`border rounded-lg p-4 text-sm ${result.ok ? 'bg-green-50 border-green-200 text-green-700' : 'bg-red-50 border-red-200 text-red-700'}`}>
            {result.message}
          </div>
        )}

        <form onSubmit={handleSubmit} className="bg-white rounded-lg shadow-sm border border-gray-100 p-5 space-y-4">
          <div>
            <label htmlFor="cookies" className="block text-sm font-medium text-gray-700 mb-1">
              Cookie String
            </label>
            <textarea
              id="cookies"
              rows={4}
              required
              value={cookies}
              onChange={(e) => setCookies(e.target.value)}
              placeholder="c_user=839115064;xs=16%3A8NyC...;fr=1m43s...;datr=Wdg7a..."
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !cookies.trim()}
            className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Validating…' : 'Update Cookies'}
          </button>
        </form>
      </div>
    </main>
  );
}
