'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Loader2, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { dispatchAtlasWidgetCommand } from '@/lib/atlasWidget';
import {
  GETTING_STARTED_CHANGED_EVENT,
  GETTING_STARTED_STEPS,
  completeGettingStartedGuide,
  dismissGettingStartedGuide,
  getGettingStartedSnapshot,
  setGettingStartedStep,
  type GettingStartedSnapshot,
} from '@/lib/gettingStarted';

type FocusRect = { top: number; left: number; width: number; height: number };

const CARD_WIDTH = 380;
const CARD_HEIGHT_ESTIMATE = 220;
const VIEWPORT_MARGIN = 24;
const FOCUS_PADDING = 14;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(value, max));
}

function getInitialSnapshot(): GettingStartedSnapshot {
  if (typeof window === 'undefined') {
    return { status: 'not_started', stepIndex: 0 };
  }
  return getGettingStartedSnapshot();
}

function expandRect(rect: FocusRect): FocusRect {
  return {
    top: Math.max(0, rect.top - FOCUS_PADDING),
    left: Math.max(0, rect.left - FOCUS_PADDING),
    width: rect.width + FOCUS_PADDING * 2,
    height: rect.height + FOCUS_PADDING * 2,
  };
}

export default function GettingStartedGuide() {
  const router = useRouter();
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<GettingStartedSnapshot>(getInitialSnapshot);
  const [targetRect, setTargetRect] = useState<FocusRect | null>(null);
  const [cardHeight, setCardHeight] = useState(CARD_HEIGHT_ESTIMATE);
  const measureFrameRef = useRef<number | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appliedEnterCommandRef = useRef<string | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const isActive = snapshot.status === 'active';
  const step = isActive ? GETTING_STARTED_STEPS[snapshot.stepIndex] ?? null : null;

  useEffect(() => {
    const syncFromStorage = () => setSnapshot(getGettingStartedSnapshot());
    syncFromStorage();
    window.addEventListener(GETTING_STARTED_CHANGED_EVENT, syncFromStorage as EventListener);
    return () => window.removeEventListener(GETTING_STARTED_CHANGED_EVENT, syncFromStorage as EventListener);
  }, []);

  useEffect(() => {
    if (!isActive || !step) return;
    if (pathname !== step.route) {
      router.push(step.route);
    }
  }, [isActive, pathname, router, step]);

  useEffect(() => {
    appliedEnterCommandRef.current = null;
  }, [snapshot.stepIndex]);

  useEffect(() => {
    if (!isActive || !step?.enterCommand || pathname !== step.route) return;
    const commandKey = `${snapshot.stepIndex}:${pathname}`;
    if (appliedEnterCommandRef.current === commandKey) return;
    appliedEnterCommandRef.current = commandKey;
    dispatchAtlasWidgetCommand(step.enterCommand);
  }, [isActive, pathname, snapshot.stepIndex, step]);

  useEffect(() => {
    if (!isActive || !step || pathname !== step.route) {
      setTargetRect(null);
      return;
    }

    const measureTarget = () => {
      const target = document.querySelector(step.selector) as HTMLElement | null;
      if (!target) {
        setTargetRect(null);
        retryTimeoutRef.current = setTimeout(() => {
          measureFrameRef.current = requestAnimationFrame(measureTarget);
        }, 120);
        return;
      }

      const rect = target.getBoundingClientRect();
      const nextRect = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
      setTargetRect(nextRect);

      const isOffscreen = rect.top < 80 || rect.bottom > window.innerHeight - 80;
      if (isOffscreen) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    };

    const handleLayoutChange = () => {
      if (measureFrameRef.current != null) cancelAnimationFrame(measureFrameRef.current);
      measureFrameRef.current = requestAnimationFrame(measureTarget);
    };

    handleLayoutChange();
    window.addEventListener('resize', handleLayoutChange);
    window.addEventListener('scroll', handleLayoutChange, true);

    return () => {
      window.removeEventListener('resize', handleLayoutChange);
      window.removeEventListener('scroll', handleLayoutChange, true);
      if (measureFrameRef.current != null) cancelAnimationFrame(measureFrameRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
    };
  }, [isActive, pathname, step]);

  useEffect(() => {
    if (!isActive) return;

    const measureCard = () => {
      const nextHeight = cardRef.current?.getBoundingClientRect().height ?? CARD_HEIGHT_ESTIMATE;
      setCardHeight((current) => (Math.abs(current - nextHeight) < 1 ? current : nextHeight));
    };

    measureCard();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measureCard);
      return () => window.removeEventListener('resize', measureCard);
    }

    const observer = new ResizeObserver(measureCard);
    if (cardRef.current) observer.observe(cardRef.current);
    window.addEventListener('resize', measureCard);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measureCard);
    };
  }, [isActive, snapshot.stepIndex, pathname]);

  const focusRect = useMemo(() => (targetRect ? expandRect(targetRect) : null), [targetRect]);

  const cardStyle = useMemo(() => {
    if (!focusRect || typeof window === 'undefined') {
      return {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
      } as const;
    }

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const spaceLeft = focusRect.left;
    const spaceRight = viewportWidth - (focusRect.left + focusRect.width);
    const spaceBelow = viewportHeight - (focusRect.top + focusRect.height);
    const canPlaceLeft = spaceLeft >= CARD_WIDTH + VIEWPORT_MARGIN + 18;
    const canPlaceRight = spaceRight >= CARD_WIDTH + VIEWPORT_MARGIN + 18;
    const placeBelow = spaceBelow >= cardHeight + VIEWPORT_MARGIN;

    if (canPlaceLeft || canPlaceRight) {
      const preferredSide = step?.preferredCardSide;
      const shouldPlaceLeft = preferredSide === 'left'
        ? canPlaceLeft || !canPlaceRight
        : preferredSide === 'right'
          ? !canPlaceRight && canPlaceLeft
          : canPlaceLeft;
      const left = shouldPlaceLeft
        ? clamp(focusRect.left - CARD_WIDTH - 18, VIEWPORT_MARGIN, viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN)
        : clamp(focusRect.left + focusRect.width + 18, VIEWPORT_MARGIN, viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN);

      const top = clamp(
        focusRect.top + focusRect.height / 2 - cardHeight / 2,
        VIEWPORT_MARGIN,
        viewportHeight - cardHeight - VIEWPORT_MARGIN,
      );

      return { top, left } as const;
    }

    const top = placeBelow
      ? clamp(focusRect.top + focusRect.height + 18, VIEWPORT_MARGIN, viewportHeight - cardHeight - VIEWPORT_MARGIN)
      : clamp(focusRect.top - cardHeight - 18, VIEWPORT_MARGIN, viewportHeight - cardHeight - VIEWPORT_MARGIN);

    const left = clamp(
      focusRect.left + focusRect.width / 2 - CARD_WIDTH / 2,
      VIEWPORT_MARGIN,
      viewportWidth - CARD_WIDTH - VIEWPORT_MARGIN,
    );

    return { top, left } as const;
  }, [cardHeight, focusRect, step]);

  if (!isActive || !step) return null;

  const stepNumber = snapshot.stepIndex + 1;
  const totalSteps = GETTING_STARTED_STEPS.length;
  const waitingForRoute = pathname !== step.route;

  const finishGuide = () => {
    completeGettingStartedGuide();
  };

  const handleNext = () => {
    if (snapshot.stepIndex >= totalSteps - 1) {
      finishGuide();
      return;
    }
    setGettingStartedStep(snapshot.stepIndex + 1);
  };

  const handleBack = () => {
    if (snapshot.stepIndex <= 0) return;
    setGettingStartedStep(snapshot.stepIndex - 1);
  };

  const overlayStyle = 'fixed bg-black/60 z-[70]';

  return (
    <>
      {focusRect ? (
        <>
          <div className={overlayStyle} style={{ top: 0, left: 0, width: '100%', height: focusRect.top }} />
          <div className={overlayStyle} style={{ top: focusRect.top, left: 0, width: focusRect.left, height: focusRect.height }} />
          <div className={overlayStyle} style={{ top: focusRect.top, left: focusRect.left + focusRect.width, right: 0, height: focusRect.height }} />
          <div className={overlayStyle} style={{ top: focusRect.top + focusRect.height, left: 0, width: '100%', bottom: 0 }} />
          <div
            className="fixed z-[71] rounded-2xl border-2 border-amber-400 shadow-[0_0_0_1px_rgba(251,191,36,0.25),0_0_35px_rgba(251,191,36,0.2)] pointer-events-none"
            style={focusRect}
          />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60 z-[70]" />
      )}

      <div
        ref={cardRef}
        className="fixed z-[72] flex max-h-[calc(100vh-48px)] w-[min(380px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-500 bg-slate-950 ring-1 ring-black/60 shadow-2xl shadow-black/80 pointer-events-auto"
        style={cardStyle}
      >
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-slate-700/60">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-[0.2em] text-amber-400/90">
              <Sparkles className="w-3.5 h-3.5" />
              Getting Started
            </div>
            <h2 className="mt-2 text-lg font-semibold text-white">{step.title}</h2>
            <p className="mt-1 text-xs text-slate-400">
              Step {stepNumber} of {totalSteps}
            </p>
          </div>
          <button
            onClick={dismissGettingStartedGuide}
            className="mt-0.5 rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-slate-800 hover:text-white"
            aria-label="Skip tutorial"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">
          {waitingForRoute ? (
            <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
              <Loader2 className="w-4 h-4 text-amber-400 animate-spin" />
              Opening {step.route === '/' ? 'dashboard' : step.route.replace('/', '').replace('-', ' ')}…
            </div>
          ) : (
            <p className="text-sm leading-relaxed font-medium text-white">{step.description}</p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 px-5 py-4 border-t border-slate-700/60">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              onClick={handleBack}
              disabled={snapshot.stepIndex === 0 || waitingForRoute}
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
            <Button variant="ghost" onClick={dismissGettingStartedGuide}>
              Skip tutorial
            </Button>
          </div>

          <Button variant="primary" onClick={handleNext} disabled={waitingForRoute}>
            {step.continueLabel ?? 'Continue'}
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </>
  );
}
