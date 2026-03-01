'use client';

import { useState } from 'react';

export default function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim()) return;
    setStatus('sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, email: email || undefined }),
      });
      if (res.ok) {
        setStatus('sent');
        setMessage('');
        setEmail('');
        setTimeout(() => { setOpen(false); setStatus('idle'); }, 2000);
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
      >
        Send Feedback
      </button>
    );
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-end sm:items-center justify-center z-50 p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-lg shadow-lg w-full max-w-sm p-4 space-y-3"
      >
        <div className="flex justify-between items-center">
          <h2 className="text-sm font-semibold text-gray-900">Send Feedback</h2>
          <button type="button" onClick={() => { setOpen(false); setStatus('idle'); }} className="text-gray-400 hover:text-gray-600 text-lg">&times;</button>
        </div>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder="Trail status wrong? Have a suggestion?"
          className="w-full border border-gray-200 rounded p-2 text-sm text-gray-900 resize-none h-24 focus:outline-none focus:ring-1 focus:ring-blue-400"
          required
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Your email (optional)"
          className="w-full border border-gray-200 rounded p-2 text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <button
          type="submit"
          disabled={status === 'sending' || status === 'sent'}
          className="w-full bg-green-600 text-white text-sm font-medium py-2 rounded hover:bg-green-700 disabled:opacity-50 transition-colors"
        >
          {status === 'sending' ? 'Sending...' : status === 'sent' ? 'Sent!' : status === 'error' ? 'Failed — try again' : 'Send'}
        </button>
      </form>
    </div>
  );
}
