import { notFound } from 'next/navigation';
import RecurringTasksPage from '@/features/tasks/RecurringTasksPage';
import TaskDetailPage from '@/features/tasks/TaskDetailPage';

export default async function TaskDeepLinkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === 'recurring') return <RecurringTasksPage />;
  if (!/^\d+$/.test(id)) notFound();
  return <TaskDetailPage taskId={Number(id)} />;
}
