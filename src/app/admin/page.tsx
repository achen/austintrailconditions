'use client';

import { useEffect, useState, FormEvent } from 'react';

/**
 * Admin page for trail management.
 * Requirements: 6.1, 6.2, 6.3, 6.4
 */

interface Trail {
  id: string;
  name: string;
  description: string | null;
  primaryStationId: string;
  dryingRateInPerDay: number;
  maxDryingDays: number;
  updatesEnabled: boolean;
  isArchived: boolean;
  conditionStatus: string;
}

interface TrailFormData {
  name: string;
  description: string;
  primaryStationId: string;
  dryingRateInPerDay: string;
  maxDryingDays: string;
  updatesEnabled: boolean;
}

const EMPTY_FORM: TrailFormData = {
  name: '',
  description: '',
  primaryStationId: '',
  dryingRateInPerDay: '2.5',
  maxDryingDays: '3',
  updatesEnabled: true,
};

export default function AdminPage() {
  const [trails, setTrails] = useState<Trail[]>([]);
  const [form, setForm] = useState<TrailFormData>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function fetchTrails() {
    try {
      const res = await fetch('/api/trails');
      if (!res.ok) throw new Error('Failed to load trails');
      const data: Trail[] = await res.json();
      setTrails(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trails');
    }
  }

  useEffect(() => {
    fetchTrails();
  }, []);

  function clearMessages() {
    setError(null);
    setSuccess(null);
  }

  function startEdit(trail: Trail) {
    clearMessages();
    setEditingId(trail.id);
    setForm({
      name: trail.name,
      description: trail.description ?? '',
      primaryStationId: trail.primaryStationId,
      dryingRateInPerDay: String(trail.dryingRateInPerDay),
      maxDryingDays: String(trail.maxDryingDays),
      updatesEnabled: trail.updatesEnabled,
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    clearMessages();
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    clearMessages();
    setLoading(true);

    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      primaryStationId: form.primaryStationId.trim(),
      dryingRateInPerDay: parseFloat(form.dryingRateInPerDay),
      maxDryingDays: parseInt(form.maxDryingDays, 10),
      updatesEnabled: form.updatesEnabled,
    };

    try {
      if (editingId) {
        const res = await fetch(`/api/trails/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to update trail');
        }
        setSuccess(`Updated "${payload.name}"`);
      } else {
        const res = await fetch('/api/trails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || 'Failed to create trail');
        }
        setSuccess(`Created "${payload.name}"`);
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
      await fetchTrails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  async function handleArchive(trail: Trail) {
    if (!confirm(`Archive "${trail.name}"? It will no longer appear on the dashboard.`)) return;
    clearMessages();
    setLoading(true);
    try {
      const res = await fetch(`/api/trails/${trail.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to archive trail');
      }
      setSuccess(`Archived "${trail.name}"`);
      await fetchTrails();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-bold text-gray-900">Trail Admin</h1>
          <a href="/" className="text-sm text-blue-600 hover:underline">
            ← Dashboard
          </a>
        </div>
      </header>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
            {error}
          </div>
        )}
        {success && (
          <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg text-sm">
            {success}
          </div>
        )}

        {/* Trail Form */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-100 p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {editingId ? 'Edit Trail' : 'Add Trail'}
          </h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                Name
              </label>
              <input
                id="name"
                type="text"
                required
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <input
                id="description"
                type="text"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="primaryStationId" className="block text-sm font-medium text-gray-700 mb-1">
                  Station ID
                </label>
                <input
                  id="primaryStationId"
                  type="text"
                  required
                  value={form.primaryStationId}
                  onChange={(e) => setForm({ ...form, primaryStationId: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="dryingRate" className="block text-sm font-medium text-gray-700 mb-1">
                  Drying Rate (in/day)
                </label>
                <input
                  id="dryingRate"
                  type="number"
                  required
                  step="0.1"
                  min="0"
                  value={form.dryingRateInPerDay}
                  onChange={(e) => setForm({ ...form, dryingRateInPerDay: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label htmlFor="maxDays" className="block text-sm font-medium text-gray-700 mb-1">
                  Max Days
                </label>
                <input
                  id="maxDays"
                  type="number"
                  required
                  min="0"
                  value={form.maxDryingDays}
                  onChange={(e) => setForm({ ...form, maxDryingDays: e.target.value })}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                id="updatesEnabled"
                type="checkbox"
                checked={form.updatesEnabled}
                onChange={(e) => setForm({ ...form, updatesEnabled: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <label htmlFor="updatesEnabled" className="text-sm text-gray-700">
                Weather updates enabled
              </label>
            </div>

            <div className="flex gap-3">
              <button
                type="submit"
                disabled={loading}
                className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {loading ? 'Saving…' : editingId ? 'Update Trail' : 'Add Trail'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="bg-gray-100 text-gray-700 px-4 py-2 rounded-md text-sm font-medium hover:bg-gray-200"
                >
                  Cancel
                </button>
              )}
            </div>
          </form>
        </section>

        {/* Trail List */}
        <section className="bg-white rounded-lg shadow-sm border border-gray-100 p-5">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            Active Trails ({trails.length})
          </h2>
          {trails.length === 0 ? (
            <p className="text-gray-500 text-sm">No active trails.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {trails.map((trail) => (
                <li key={trail.id} className="py-3 flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-gray-900 truncate">{trail.name}</p>
                    <p className="text-xs text-gray-500">
                      Station: {trail.primaryStationId} · Rate: {trail.dryingRateInPerDay} in/day · Max: {trail.maxDryingDays}d
                      {!trail.updatesEnabled && ' · Updates off'}
                    </p>
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => startEdit(trail)}
                      className="text-sm text-blue-600 hover:underline"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => handleArchive(trail)}
                      className="text-sm text-red-600 hover:underline"
                    >
                      Archive
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
