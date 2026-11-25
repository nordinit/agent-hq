import { Suspense } from 'react';
import ApprovalsPage from '@/features/approvals/ApprovalsPage';

// ApprovalsPage reads ?agent= through useSearchParams, which Next requires under a Suspense boundary.
export default function ApprovalsRoute() {
  return (
    <Suspense
      fallback={(
        <div className="flex h-64 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-amber-400 border-t-transparent" />
        </div>
      )}
    >
      <ApprovalsPage />
    </Suspense>
  );
}
