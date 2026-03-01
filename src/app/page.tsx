import { formatDistanceToNow, format } from 'date-fns';

import { getTrailsWithConditions, getPredictionAccuracy } from '@/services/dashboard-service';
import FeedbackButton from './feedback-button';


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
              const isRideable = trail.condition_status === 'Verified Rideable' || trail.condition_status === 'Probably Rideable';
              const statusColor = 'text-white/80';
              const rowBg = isRideable ? 'bg-green-600 text-white' : 'bg-red-600 text-white';
              const isDrying = trail.condition_status === 'Probably Not Rideable' || trail.condition_status === 'Probably Rideable';

              return (
                <li key={trail.id} className={`flex items-center gap-2 px-3 py-2 ${rowBg}`}>
                  <span className="font-medium text-sm truncate flex-1">{trail.name}</span>
                  {isDrying && trail.predicted_dry_time ? (
                    <span className="text-xs text-white/70 w-28 text-right shrink-0">
                      dry {new Date(trail.predicted_dry_time) > new Date()
                        ? formatDistanceToNow(new Date(trail.predicted_dry_time), { addSuffix: true })
                        : 'soon'}
                    </span>
                  ) : (
                    <span className="w-28 shrink-0" />
                  )}
                  <span className={`text-xs font-medium w-20 text-right shrink-0 ${statusColor}`}>
                    {trail.condition_status === 'Closed' ? 'Closed' : trail.condition_status.replace('Verified ', '').replace('Probably ', '~')}
                  </span>
                  <span className={`text-xs w-24 text-right shrink-0 text-white/70`}>
                    {format(new Date(trail.updated_at), 'M/d h:mma')}
                  </span>
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
