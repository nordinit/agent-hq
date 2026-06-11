'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/api';
import OnboardingWizard, { markOnboarded } from './OnboardingWizard';
import ChatWidget from '@/features/chat/ChatWidget';
import GettingStartedGuide from './GettingStartedGuide';
import { API_DOCS_ROUTE } from '@/lib/docsRoute';
import NotificationToasts from './NotificationToasts';

// Routes that should fill the full height without padding wrapper
const FULL_HEIGHT_ROUTES = ['/chat', '/tasks', API_DOCS_ROUTE];
// Route prefixes that should also fill full height
const FULL_HEIGHT_PREFIXES = ['/sprints/', '/workflows/'];
const WIDE_CONTENT_ROUTES = ['/routing'];

export default function MainContent({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const pathname = usePathname();
  const isFullHeight = FULL_HEIGHT_ROUTES.includes(pathname) || FULL_HEIGHT_PREFIXES.some(p => pathname.startsWith(p));
  const isWideContent = WIDE_CONTENT_ROUTES.includes(pathname);
  const isDocsRoute = pathname === API_DOCS_ROUTE;

  useEffect(() => {
    const check = () => {
      const stored = localStorage.getItem('sidebar-collapsed');
      if (stored !== null) {
        setCollapsed(stored === 'true');
      } else {
        setCollapsed(window.innerWidth < 768);
      }
    };
    check();
    window.addEventListener('sidebar-toggle', check);
    return () => window.removeEventListener('sidebar-toggle', check);
  }, []);

  useEffect(() => {
    const updateViewportHeight = () => {
      const height = Math.max(window.innerHeight, window.visualViewport?.height ?? 0);
      document.documentElement.style.setProperty('--app-viewport-height', `${height}px`);
    };
    let delayedUpdate: ReturnType<typeof setTimeout> | undefined;
    const scheduleViewportHeightUpdate = () => {
      updateViewportHeight();
      if (delayedUpdate) clearTimeout(delayedUpdate);
      delayedUpdate = setTimeout(updateViewportHeight, 250);
    };

    scheduleViewportHeightUpdate();
    window.addEventListener('resize', scheduleViewportHeightUpdate);
    window.addEventListener('orientationchange', scheduleViewportHeightUpdate);
    window.addEventListener('pageshow', scheduleViewportHeightUpdate);
    window.visualViewport?.addEventListener('resize', scheduleViewportHeightUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleViewportHeightUpdate);

    return () => {
      if (delayedUpdate) clearTimeout(delayedUpdate);
      window.removeEventListener('resize', scheduleViewportHeightUpdate);
      window.removeEventListener('orientationchange', scheduleViewportHeightUpdate);
      window.removeEventListener('pageshow', scheduleViewportHeightUpdate);
      window.visualViewport?.removeEventListener('resize', scheduleViewportHeightUpdate);
      window.visualViewport?.removeEventListener('scroll', scheduleViewportHeightUpdate);
    };
  }, []);

  // First-run detection: show onboarding if not yet onboarded
  // Server-side onboarding state is authoritative; localStorage is only a UI hint.
  useEffect(() => {
    api.getSetupStatus()
      .then(status => {
        if (status.onboarding_completed) {
          // Server says onboarding is done — sync localStorage and skip wizard
          markOnboarded();
          return;
        }
        if (!status.hasProjects) {
          setShowOnboarding(true);
        } else if (status.onboarding_provider_gate_passed) {
          // Projects exist and provider gate passed — mark silently
          markOnboarded();
        } else {
          // Projects exist but no providers yet — show onboarding to collect provider
          setShowOnboarding(true);
        }
      })
      .catch(() => {
        // API not available; fall back to the persisted local hint
        if (localStorage.getItem('agent-hq-onboarded') !== '1') {
          setShowOnboarding(true);
        }
      });
  }, []);

  // On desktop (md+): offset by sidebar width (collapsed = 56px / expanded = 240px)
  const desktopMargin = collapsed ? 'md:ml-14' : 'md:ml-60';

  return (
    <>
      {showOnboarding && (
        <OnboardingWizard onClose={() => setShowOnboarding(false)} />
      )}
    <main className={`order-1 md:order-none flex-1 min-h-0 overflow-hidden flex flex-col transition-all duration-200 ${desktopMargin}`}>
      {isFullHeight ? (
        <div className={`flex-1 min-h-0 flex flex-col overflow-x-hidden ${isDocsRoute ? 'overflow-y-auto' : 'overflow-y-auto md:overflow-hidden'}`}>
          {children}
        </div>
      ) : (
        <div className="flex-1 min-h-0 p-4 md:p-6 overflow-x-hidden overflow-y-auto md:overflow-y-auto">
          <div className={isWideContent ? 'mx-auto max-w-[96rem]' : 'max-w-7xl mx-auto'}>
            {children}
          </div>
        </div>
      )}
    </main>
      {!showOnboarding && pathname !== '/chat' && pathname !== API_DOCS_ROUTE && <ChatWidget />}
      {!showOnboarding && <GettingStartedGuide />}
      {!showOnboarding && <NotificationToasts />}
    </>
  );
}
