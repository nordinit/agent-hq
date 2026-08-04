import { Suspense } from 'react';
import RoutingPage from '@/features/routing/RoutingPage';

// RoutingPage reads ?trace_task= via useSearchParams, which opts the route into
// client-side rendering. Next requires that to sit under a Suspense boundary, or the
// static prerender of /routing fails the build outright.
export default function RoutingRoute() {
  return (
    <Suspense
      fallback={(
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
        </div>
      )}
    >
      <RoutingPage />
    </Suspense>
  );
}
