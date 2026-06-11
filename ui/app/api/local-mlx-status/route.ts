import { NextResponse } from 'next/server';
import { getAgentHqBaseUrl } from '@/lib/agentHqBaseUrl';

export async function GET() {
  try {
    const res = await fetch(`${getAgentHqBaseUrl()}/api/v1/agents/local-mlx/status`, {
      signal: AbortSignal.timeout(8000),
      cache: 'no-store',
    });
    const data = await res.json();
    return NextResponse.json(data, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ online: false });
  }
}
