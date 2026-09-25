'use client';

import { usePathname } from 'next/navigation';
import Sidebar from './Sidebar';
import MainContent from './MainContent';

/** The sign-in page stands alone: the app chrome calls the API, which needs a session first. */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') {
    return <main className="flex-1 min-h-0 overflow-y-auto">{children}</main>;
  }
  return (
    <>
      <Sidebar />
      <MainContent>{children}</MainContent>
    </>
  );
}
