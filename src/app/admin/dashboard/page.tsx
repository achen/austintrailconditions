'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface AdminTrail {
  id: string;
  name: string;
  condition_status: string;
  max_absorbable_in: number;
  max_drying_days: number;
  updates_enabled: boolean;
  primary_station_id: string;
  updated_at: string;
  active_rain_in: number;
  rain_start: string | null;
  recent_rain_total: number;
  recent_event_count: number;
  remaining_moisture_in: number | null;
  predicted_dry_time: string | null;
  dried_so_far: number | null;
}

interface RainEvent {
  id: string;
  start_timestamp: string;
  end_timestamp: string | null;
  total_precipitation_in: number;
  is_active: boolean;
}

interface Post {
  post_id: string;
  author_name: string;
  post_text: string;
  timestamp: string;
  classification: string | null;
  confidence_score: number | null;
  trail_references: string[];
  flagged_for_review: boolean;
  is_comment: boolean;
  parent_post_id: string | null;
  applied_status: string | null;
  applied_at: string | null;
}

type Tab = 'trails' | 'posts';

function formatDate(d: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function classColor(c: string | null): string {
  switch (c) {
    case 'dry': return 'bg-green-100 text-green-800';
    case 'wet': return 'bg-red-100 text-red-800';
    case 'inquiry': return 'bg-yellow-100 text-yellow-800';
    default: return 'bg-gray-100 text-gray-600';
  }
}

function statusColor(s: string): string {
  if (s === 'Observed Dry' || s === 'Predicted Dry' || s === 'Open') return 'bg-green-100 text-green-800';
  if (s === 'Predicted Wet' || s === 'Observed Wet') return 'bg-red-100 text-red-800';
  if (s === 'Closed') return 'bg-gray-200 text-gray-700';
  return 'bg-gray-100 text-gray-600';
}

export default function DashboardPage() {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('trails');
  const [trails, setTrails] = useState<AdminTrail[]>([]);
  const [posts, setPosts] = useState<Post[]>([]);
  const [postFilter, setPostFilter] = useState<string>('');
  const [expandedTrail, setExpandedTrail] = useState<string | null>(null);
  const [rainEvents, setRainEvents] = useState<RainEvent[]>([]);
  const [editing, setEditing] = useState<{ id: string; field: string; value: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const checkAuth = useCallback(async () => {
    const res = await fetch('/api/admin/auth');
    if (!res.ok) router.push('/admin/login');
  }, [router]);

  const fetchTrails = useCallback(async () => {
    const res = await fetch('/api/admin/trails');
    if (res.ok) setTrails(await res.json());
  }, []);

  const fetchPosts = useCallback(async () => {
    const url = postFilter ? `/api/admin/posts?classification=${postFilter}` : '/api/admin/posts';
    const res = await fetch(url);
    if (res.ok) setPosts(await res.json());
  }, [postFilter]);

  useEffect(() => { checkAuth(); }, [checkAuth]);
  useEffect(() => {
    setLoading(true);
    if (tab === 'trails') fetchTrails().finally(() => setLoading(false));
    else fetchPosts().finally(() => setLoading(false));
  }, [tab, fetchTrails, fetchPosts]);

  async function loadRainEvents(trailId: string) {
    if (expandedTrail === trailId) { setExpandedTrail(null); return; }
    setExpandedTrail(trailId);
    const res = await fetch(`/api/admin/rain-events?trailId=${trailId}`);
    if (res.ok) setRainEvents(await res.json());
  }

  async function saveEdit() {
    if (!editing) return;
    setSaving(true);
    const payload: Record<string, number> = {};
    if (editing.field === 'maxAbsorbableIn') payload.maxAbsorbableIn = parseFloat(editing.value);
    if (editing.field === 'maxDryingDays') payload.maxDryingDays = parseInt(editing.value, 10);

    await fetch(`/api/admin/trails/${editing.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    setEditing(null);
    setSaving(false);
    fetchTrails();
  }

  async function handleLogout() {
    await fetch('/api/admin/auth', { method: 'DELETE' });
    router.push('/admin/login');
  }

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <h1 className="text-lg font-bold text-gray-900">Admin Dashboard</h1>
          <div className="flex items-center gap-3">
            <a href="/" className="text-sm text-blue-600 hover:underline">Dashboard</a>
            <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-700">Logout</button>
          </div>
        </div>
        <div className="max-w-5xl mx-auto px-4 flex gap-1 border-t border-gray-100">
          <button
            onClick={() => setTab('trails')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'trails' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >Trails &amp; Rain</button>
          <button
            onClick={() => setTab('posts')}
            className={`px-4 py-2 text-sm font-medium border-b-2 ${tab === 'posts' ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >Facebook Posts</button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-4">
        {loading ? (
          <p className="text-gray-500 text-sm py-8 text-center">Loading…</p>
        ) : tab === 'trails' ? (
          <TrailsTab
            trails={trails}
            expandedTrail={expandedTrail}
            rainEvents={rainEvents}
            editing={editing}
            saving={saving}
            onExpand={loadRainEvents}
            onStartEdit={(id, field, value) => setEditing({ id, field, value })}
            onEditChange={(value) => editing && setEditing({ ...editing, value })}
            onSaveEdit={saveEdit}
            onCancelEdit={() => setEditing(null)}
          />
        ) : (
          <PostsTab
            posts={posts}
            filter={postFilter}
            onFilterChange={(f) => setPostFilter(f)}
          />
        )}
      </div>
    </main>
  );
}

function TrailsTab({ trails, expandedTrail, rainEvents, editing, saving, onExpand, onStartEdit, onEditChange, onSaveEdit, onCancelEdit }: {
  trails: AdminTrail[];
  expandedTrail: string | null;
  rainEvents: RainEvent[];
  editing: { id: string; field: string; value: string } | null;
  saving: boolean;
  onExpand: (id: string) => void;
  onStartEdit: (id: string, field: string, value: string) => void;
  onEditChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="space-y-2">
      {trails.map((t) => (
        <div key={t.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-medium text-sm text-gray-900 truncate">{t.name}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${statusColor(t.condition_status)}`}>{t.condition_status}</span>
              </div>
              <button onClick={() => onExpand(t.id)} className="text-xs text-blue-600 hover:underline shrink-0">
                {expandedTrail === t.id ? 'Hide' : 'Rain Events'}
              </button>
            </div>

            <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs text-gray-600">
              <div>
                <span className="text-gray-400">Active Rain:</span>{' '}
                <span className="font-mono">{Number(t.active_rain_in).toFixed(2)}″</span>
              </div>
              <div>
                <span className="text-gray-400">7d Total:</span>{' '}
                <span className="font-mono">{Number(t.recent_rain_total).toFixed(2)}″</span>
                <span className="text-gray-400"> ({t.recent_event_count} events)</span>
              </div>
              <div>
                <span className="text-gray-400">Remaining:</span>{' '}
                <span className="font-mono">{t.remaining_moisture_in != null ? Number(t.remaining_moisture_in).toFixed(3) + '″' : '—'}</span>
              </div>
              <div>
                <span className="text-gray-400">Dried:</span>{' '}
                <span className="font-mono">{t.dried_so_far != null ? Number(t.dried_so_far).toFixed(3) + '″' : '—'}</span>
              </div>
            </div>

            <div className="mt-2 flex items-center gap-4 text-xs">
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Max Absorbable:</span>
                {editing?.id === t.id && editing.field === 'maxAbsorbableIn' ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      step="0.05"
                      min="0"
                      value={editing.value}
                      onChange={(e) => onEditChange(e.target.value)}
                      className="w-16 border border-blue-300 rounded px-1 py-0.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                      autoFocus
                      aria-label="Max absorbable inches"
                    />
                    <button onClick={onSaveEdit} disabled={saving} className="text-blue-600 hover:underline">Save</button>
                    <button onClick={onCancelEdit} className="text-gray-400 hover:underline">Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={() => onStartEdit(t.id, 'maxAbsorbableIn', String(t.max_absorbable_in))}
                    className="font-mono text-blue-600 hover:underline cursor-pointer"
                    title="Click to edit"
                  >
                    {Number(t.max_absorbable_in).toFixed(2)}″
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <span className="text-gray-400">Max Days:</span>
                {editing?.id === t.id && editing.field === 'maxDryingDays' ? (
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      min="0"
                      value={editing.value}
                      onChange={(e) => onEditChange(e.target.value)}
                      className="w-12 border border-blue-300 rounded px-1 py-0.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
                      autoFocus
                      aria-label="Max drying days"
                    />
                    <button onClick={onSaveEdit} disabled={saving} className="text-blue-600 hover:underline">Save</button>
                    <button onClick={onCancelEdit} className="text-gray-400 hover:underline">Cancel</button>
                  </span>
                ) : (
                  <button
                    onClick={() => onStartEdit(t.id, 'maxDryingDays', String(t.max_drying_days))}
                    className="font-mono text-blue-600 hover:underline cursor-pointer"
                    title="Click to edit"
                  >
                    {t.max_drying_days}
                  </button>
                )}
              </div>
              <span className="text-gray-400">Station: {t.primary_station_id}</span>
              {t.predicted_dry_time && (
                <span className="text-gray-400">Dry: {formatDate(t.predicted_dry_time)}</span>
              )}
            </div>
          </div>

          {expandedTrail === t.id && (
            <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
              <h4 className="text-xs font-medium text-gray-500 mb-2">Recent Rain Events</h4>
              {rainEvents.length === 0 ? (
                <p className="text-xs text-gray-400">No rain events found.</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-400">
                      <th className="pb-1">Start</th>
                      <th className="pb-1">End</th>
                      <th className="pb-1 text-right">Precip</th>
                      <th className="pb-1 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rainEvents.map((re) => (
                      <tr key={re.id} className="border-t border-gray-100">
                        <td className="py-1 font-mono">{formatDate(re.start_timestamp)}</td>
                        <td className="py-1 font-mono">{formatDate(re.end_timestamp)}</td>
                        <td className="py-1 text-right font-mono">{Number(re.total_precipitation_in).toFixed(3)}″</td>
                        <td className="py-1 text-right">
                          {re.is_active ? (
                            <span className="text-blue-600">Active</span>
                          ) : (
                            <span className="text-gray-400">Ended</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function PostsTab({ posts, filter, onFilterChange }: {
  posts: Post[];
  filter: string;
  onFilterChange: (f: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500">Filter:</span>
        {['', 'dry', 'wet', 'inquiry', 'unrelated'].map((f) => (
          <button
            key={f}
            onClick={() => onFilterChange(f)}
            className={`text-xs px-2 py-1 rounded ${filter === f ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            {f || 'All'}
          </button>
        ))}
      </div>

      {posts.length === 0 ? (
        <p className="text-gray-500 text-sm py-8 text-center">No posts found.</p>
      ) : (
        <div className="space-y-2">
          {posts.map((p) => (
            <div key={p.post_id} className={`bg-white rounded-lg border p-3 ${p.flagged_for_review ? 'border-yellow-300' : 'border-gray-200'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-gray-700">{p.author_name}</span>
                    <span className="text-xs text-gray-400">{formatDate(p.timestamp)}</span>
                    {p.is_comment && <span className="text-xs text-gray-400 italic">comment</span>}
                    {p.flagged_for_review && <span className="text-xs text-yellow-600">⚠ flagged</span>}
                  </div>
                  <p className="text-sm text-gray-800 whitespace-pre-wrap break-words">{p.post_text.slice(0, 500)}{p.post_text.length > 500 ? '…' : ''}</p>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className={`px-1.5 py-0.5 rounded ${classColor(p.classification)}`}>
                  {p.classification || 'unclassified'}
                </span>
                {p.confidence_score != null && (
                  <span className="text-gray-400">conf: {(Number(p.confidence_score) * 100).toFixed(0)}%</span>
                )}
                {p.trail_references?.length > 0 && (
                  <span className="text-gray-500">→ {p.trail_references.join(', ')}</span>
                )}
                {p.applied_status && (
                  <span className="text-green-600">Applied: {p.applied_status}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
