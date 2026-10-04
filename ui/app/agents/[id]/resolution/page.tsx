'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { AgentResolutionGraph } from '@/components/agents/AgentResolutionGraph';
export default function AgentResolutionPage() {
  const params = useParams();
  const id = Number(params?.id);
  if (!Number.isSafeInteger(id) || id <= 0) return <p>Invalid agent ID.</p>;
  return <div className="space-y-4"><Link href={`/agents/${id}`} className="text-sm text-slate-400 hover:text-white">← Agent details</Link><AgentResolutionGraph key={id} agentId={id} /></div>;
}
