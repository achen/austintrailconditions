import { formatDistanceToNow } from 'date-fns';

import { getTrailsWithConditions, getPredictionAccuracy } from '@/services/dashboard-service';
import FeedbackButton from './feedback-button';

export const dynamic = 'force-dynamic';

const CT = 'America/Chicago';

function formatCT(date: Date): string {
  return date.toLocaleString('en-US', {
    timeZone: CT,
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).replace(' ', '');
}


export default async function DashboardPage() {
  const [trails, accuracy] = await Promise.all([
    getTrailsWithConditions(),
    getPredictionAccuracy(),
  ]);

  const accuracyPercent = accuracy
    ? Math.round((accuracy.accurate / accuracy.total) * 100)
    : null;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-white shadow-sm sticky top-0 z-10">
        <div className="max-w-lg mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">Austin Trail Conditions</h1>
        </div>
      </header>

      <div className="max-w-lg mx-auto px-4 py-4">
        {accuracyPercent !== null && (
          <div className="bg-white rounded-lg shadow-sm border border-gray-100 p-4 mb-4 flex items-center gap-3">
            <span className="text-2xl font-bold text-blue-600">{accuracyPercent}%</span>
            <span className="text-sm text-gray-600">
              Prediction accuracy (last {accuracy!.total} rain events, within 2 hrs)
            </span>
          </div>
        )}
        {trails.length === 0 ? (
          <p className="text-gray-500 text-center py-8">No trails available.</p>
        ) : (
          <ul className="divide-y divide-gray-100 bg-white rounded-lg shadow-sm border border-gray-100">
            {trails.map((trail) => {
              const isRideable = trail.condition_status === 'Observed Dry' || trail.condition_status === 'Predicted Dry';
              const rowBg = isRideable ? 'bg-green-600 text-white' : 'bg-red-600 text-white';
              const isDrying = trail.condition_status === 'Predicted Wet';
              const statusLabels: Record<string, string> = {
                'Observed Dry': 'Observed Dry',
                'Observed Wet': 'Observed Wet',
                'Predicted Dry': 'Predicted Dry',
                'Predicted Wet': 'Predicted Wet',
                'Closed': 'Closed',
              };
              const statusLabel = statusLabels[trail.condition_status] ?? trail.condition_status;

              return (
                <li key={trail.id} className={`px-3 py-2 ${rowBg}`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-sm truncate">{trail.name}</span>
                    <span className="text-xs font-medium text-white/80 shrink-0">{statusLabel}</span>
                  </div>
                  <div className="flex items-center justify-between gap-2 mt-0.5">
                    {isDrying && trail.predicted_dry_time ? (
                      <span className="text-xs text-white/70">
                        dry {new Date(trail.predicted_dry_time) > new Date()
                          ? formatDistanceToNow(new Date(trail.predicted_dry_time), { addSuffix: true })
                          : 'soon'}
                      </span>
                    ) : (
                      <span />
                    )}
                    <span className="text-xs text-white/70">
                      {formatCT(new Date(trail.updated_at))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-4 text-center">
          <FeedbackButton />
        </div>
      </div>
    </main>
  );
}
