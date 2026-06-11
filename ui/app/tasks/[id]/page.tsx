import { redirect } from 'next/navigation';
import RecurringTasksPage from '@/features/tasks/RecurringTasksPage';

export default async function TaskDeepLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === 'recurring') return <RecurringTasksPage />;
  redirect(`/tasks?id=${encodeURIComponent(id)}`);
}
