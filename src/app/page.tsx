import { formatDistanceToNow, format } from 'date-fns';
import type { ConditionStatus } from '@/types';
import { getTrailsWithConditions, getPredictionAccuracy } from '@/services/dashboard-service';

const STATUS_COLORS: Record<ConditionStatus, string> = {
  'Verified Rideable': 'bg-green-500',
  'Probably Rideable': 'bg-green-300',
  'Probably Not Rideable': 'bg-orange-400',
  'Verified Not Rideable': 'bg-red-500',
};

const STATUS_TEXT_COLORS: Record<ConditionStatus, string> = {
  'Verified Rideable': 'text-green-700',
  'Probably Rideable': 'text-green-600',
  'Probably Not Rideable': 'text-orange-600',
  'Verified Not Rideable': 'text-red-700',
};

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
        <div className="max-w-2xl mx-auto px-4 py-4">
          <h1 className="text-xl font-bold text-gray-900">Austin Trail Conditions</h1>
        </div>
      </header>

      <div className="max-w-2xl mx-auto px-4 py-4">
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
          <ul className="space-y-3">
            {trails.map((trail) => (
              <li
                key={trail.id}
                className="bg-white rounded-lg shadow-sm border border-gray-100 p-4"
              >
                <div className="flex items-start gap-3">
                  <span
                    className={`mt-1 w-3 h-3 rounded-full shrink-0 ${STATUS_COLORS[trail.condition_status]}`}
                    aria-label={trail.condition_status}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <h2 className="font-semibold text-gray-900 truncate">
                        {trail.name}
                      </h2>
                      <span
                        className={`text-xs font-medium whitespace-nowrap ${STATUS_TEXT_COLORS[trail.condition_status]}`}
                      >
                        {trail.condition_status}
                      </span>
                    </div>

                    {trail.predicted_dry_time &&
                      (trail.condition_status === 'Probably Not Rideable' ||
                        trail.condition_status === 'Probably Rideable') && (
                        <p className="text-sm text-gray-600 mt-1">
                          Estimated dry:{' '}
                          <span className="font-medium">
                            {new Date(trail.predicted_dry_time) > new Date()
                              ? formatDistanceToNow(new Date(trail.predicted_dry_time), {
                                  addSuffix: true,
                                })
                              : 'any time now'}
                          </span>
                        </p>
                      )}

                    <p className="text-xs text-gray-400 mt-1">
                      Updated {format(new Date(trail.updated_at), 'MMM d, h:mm a')}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
