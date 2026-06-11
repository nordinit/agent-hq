'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { resolveSettingsRouteTarget } from '@/lib/settingsRoute';

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get('tab');
    router.replace(resolveSettingsRouteTarget(tab, window.location.hash));
  }, [router]);

  return null;
}
