'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Bot,
  BookOpen,
  Zap,
  Menu,
  FolderOpen,
  Files,
  MessageSquare,
  ClipboardList,
  CalendarClock,
  Rocket,
  Workflow,
  BarChart3,
  GitBranch,
  Cpu,
  Settings,
  HelpCircle,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { beginGettingStartedGuide } from '@/lib/gettingStarted';
import { Button } from '@/components/ui/button';

const navItems = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/tasks', label: 'Tasks', icon: ClipboardList },
  { href: '/tasks/recurring', label: 'Recurring Tasks', icon: CalendarClock },
  { href: '/projects', label: 'Projects', icon: FolderOpen },
  { href: '/workflows', label: 'Workflows', icon: Rocket },
  { href: '/workflow-definitions', label: 'Workflow Definitions', icon: Workflow },
  { href: '/routing', label: 'Task Routing', icon: GitBranch },
  { href: '/model-routing', label: 'Model Routing', icon: Cpu },
  { href: '/telemetry', label: 'Telemetry', icon: BarChart3 },
  { href: '/capabilities', label: 'Capabilities', icon: BookOpen },
  { href: '/workspaces', label: 'Workspaces', icon: Files },
  { href: '/chat', label: 'Chat', icon: MessageSquare },
  { href: '/settings', label: 'Settings', icon: Settings },
];

const mobilePrimaryNavItems = [
  { href: '/', label: 'Home', shortLabel: 'Home', icon: LayoutDashboard },
  { href: '/tasks', label: 'Tasks', shortLabel: 'Tasks', icon: ClipboardList },
  { href: '/agents', label: 'Agents', shortLabel: 'Agents', icon: Bot },
  { href: '/projects', label: 'Projects', shortLabel: 'Projects', icon: FolderOpen },
  { href: '/chat', label: 'Chat', shortLabel: 'Chat', icon: MessageSquare },
];

const mobileOverflowNavItems = [
  { href: '/workflows', label: 'Workflows', description: 'Workflow boards and execution', icon: Rocket },
  { href: '/tasks/recurring', label: 'Recurring Tasks', description: 'Fixed-workflow task schedules', icon: CalendarClock },
  { href: '/workflow-definitions', label: 'Workflow Definitions', description: 'Workflow templates and outcomes', icon: Workflow },
  { href: '/routing', label: 'Task Routing', description: 'Dispatch rules, transitions, and contracts', icon: GitBranch },
  { href: '/model-routing', label: 'Model Routing', description: 'Provider and model policy', icon: Cpu },
  { href: '/telemetry', label: 'Telemetry', description: 'Runtime metrics and visibility', icon: BarChart3 },
  { href: '/capabilities', label: 'Capabilities', description: 'Skills, tools, and MCP servers', icon: BookOpen },
  { href: '/workspaces', label: 'Workspaces', description: 'Workspace files and artifacts', icon: Files },
  { href: '/settings', label: 'Settings', description: 'Display, providers, gateway, GitHub, logs, and API docs', icon: Settings },
];

function isNavItemActive(pathname: string, href: string) {
  if (href === '/tasks') return pathname === '/tasks' || /^\/tasks\/\d+/.test(pathname);
  if (href.startsWith('/settings')) return pathname.startsWith('/settings');
  if (href === '/workflows') return pathname.startsWith('/workflows') || pathname.startsWith('/sprints');
  if (href === '/workflow-definitions') return pathname.startsWith('/workflow-definitions') || pathname.startsWith('/sprint-definitions');
  return href === '/'
    ? pathname === '/'
    : href === '/capabilities'
      ? pathname.startsWith('/capabilities') || pathname.startsWith('/skills')
      : pathname.startsWith(href);
}

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);

  useEffect(() => {
    // Default collapsed on mobile
    const stored = localStorage.getItem('sidebar-collapsed');
    if (stored !== null) {
      setCollapsed(stored === 'true');
    } else {
      setCollapsed(window.innerWidth < 768);
    }
  }, []);

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
    window.dispatchEvent(new Event('sidebar-toggle'));
  };

  useEffect(() => {
    setShowMobileMenu(false);
  }, [pathname]);

  useEffect(() => {
    if (!showMobileMenu) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [showMobileMenu]);

  const mobileOverflowActive = mobileOverflowNavItems.some(item => isNavItemActive(pathname, item.href));

  return (
    <>
      {/* Desktop sidebar — hidden on mobile */}
      <aside className={`hidden md:flex fixed left-0 top-0 bottom-0 bg-slate-950 border-r border-slate-800 flex-col z-[45] transition-all duration-200 ${collapsed ? 'w-14' : 'w-60'}`}>
        {/* Header */}
        {collapsed ? (
          <div className="flex flex-col items-center py-4 border-b border-slate-800 gap-3">
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Expand sidebar"
            >
              <Menu className="w-5 h-5" />
            </button>
            <Zap className="w-5 h-5 text-amber-400" />
          </div>
        ) : (
          <div className="px-4 py-4 border-b border-slate-800 flex items-start justify-between">
            <div className="flex items-center gap-2">
              <Zap className="text-amber-400 w-5 h-5 shrink-0" />
              <div>
                <span className="font-bold text-white text-base tracking-tight">Agent HQ</span>
                <p className="text-slate-500 text-xs">Agent Control Center</p>
              </div>
            </div>
            <button
              onClick={toggle}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors shrink-0 ml-2"
              title="Collapse sidebar"
            >
              <Menu className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* Nav */}
        <nav className={`flex-1 py-3 space-y-0.5 ${collapsed ? 'px-1' : 'px-3'}`}>
          {navItems.map(({ href, label, icon: Icon }) => {
            const isActive = isNavItemActive(pathname, href);
            return (
              <Link
                key={href}
                href={href}
                title={collapsed ? label : undefined}
                className={`flex items-center rounded-lg text-sm font-medium transition-colors ${
                  collapsed ? 'justify-center p-2.5' : 'gap-3 px-3 py-2.5'
                } ${isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:text-white hover:bg-slate-800/50'}`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'text-amber-400' : ''}`} />
                {!collapsed && label}
              </Link>
            );
          })}
        </nav>

        {/* Footer */}
        {!collapsed && (
          <div className="px-5 py-4 border-t border-slate-800">
            <button
              type="button"
              onClick={() => beginGettingStartedGuide(0)}
              className="mb-3 inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-medium text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              Getting Started
            </button>
            <p className="text-slate-600 text-xs">v1.0 · Phase 1+2</p>
          </div>
        )}
        {collapsed && (
          <div className="px-1 py-3 border-t border-slate-800 flex justify-center">
            <button
              type="button"
              onClick={() => beginGettingStartedGuide(0)}
              className="p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title="Replay getting started guide"
            >
              <HelpCircle className="w-4 h-4 text-amber-400" />
            </button>
          </div>
        )}
      </aside>

      {/* Mobile bottom tab bar with overflow for parity destinations */}
      <>
        {showMobileMenu && (
          <div className="md:hidden fixed inset-0 z-[55] bg-slate-950/80 backdrop-blur-sm" onClick={() => setShowMobileMenu(false)}>
            <div
              className="absolute inset-x-0 bottom-0 rounded-t-3xl border-t border-slate-700 bg-slate-950 shadow-2xl"
              onClick={event => event.stopPropagation()}
            >
              <div className="flex items-center justify-between px-4 pt-4 pb-3">
                <div>
                  <p className="text-sm font-semibold text-white">More destinations</p>
                  <p className="text-xs text-slate-400">Desktop-equivalent areas, optimized for mobile.</p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowMobileMenu(false)}
                  className="rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-white"
                  aria-label="Close navigation menu"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="max-h-[70vh] overflow-y-auto px-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))]">
                <div className="space-y-1">
                  {mobileOverflowNavItems.map(({ href, label, description, icon: Icon }) => {
                    const isActive = isNavItemActive(pathname, href);
                    return (
                      <Link
                        key={href}
                        href={href}
                        className={`flex items-center gap-3 rounded-2xl px-3 py-3 transition-colors ${
                          isActive ? 'bg-slate-900 text-white ring-1 ring-amber-500/30' : 'text-slate-300 hover:bg-slate-900/80 hover:text-white'
                        }`}
                      >
                        <div className={`rounded-xl p-2 ${isActive ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-800 text-slate-400'}`}>
                          <Icon className="w-4 h-4" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={`text-sm font-medium ${isActive ? 'text-white' : 'text-slate-200'}`}>{label}</p>
                          <p className="text-xs text-slate-500">{description}</p>
                        </div>
                      </Link>
                    );
                  })}
                </div>

                <div className="mt-4 border-t border-slate-800 pt-4">
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    onClick={() => {
                      setShowMobileMenu(false);
                      beginGettingStartedGuide(0);
                    }}
                    className="w-full justify-start rounded-2xl border border-slate-800 bg-slate-900/70 px-3 py-3 text-left text-slate-300 hover:border-slate-700"
                  >
                    <HelpCircle className="w-4 h-4 text-amber-400" />
                    Getting Started Guide
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <nav className="order-2 z-[45] w-full shrink-0 bg-slate-950 border-t border-slate-800 pb-[env(safe-area-inset-bottom,0px)] md:hidden">
          <div className="grid grid-cols-6 gap-1 px-1 py-1">
            {mobilePrimaryNavItems.map(({ href, label, shortLabel, icon: Icon }) => {
              const isActive = isNavItemActive(pathname, href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-2 py-2 transition-colors ${
                    isActive ? 'bg-slate-900 text-amber-400' : 'text-slate-500 hover:text-slate-300'
                  }`}
                  aria-label={label}
                >
                  <Icon className="w-5 h-5" />
                  <span className="text-[10px] font-medium leading-none text-center">{shortLabel}</span>
                </Link>
              );
            })}

            <button
              type="button"
              onClick={() => setShowMobileMenu(true)}
              className={`flex min-w-0 flex-col items-center gap-1 rounded-xl px-2 py-2 transition-colors ${
                showMobileMenu || mobileOverflowActive ? 'bg-slate-900 text-amber-400' : 'text-slate-500 hover:text-slate-300'
              }`}
              aria-label="More navigation destinations"
              aria-expanded={showMobileMenu}
            >
              <MoreHorizontal className="w-5 h-5" />
              <span className="text-[10px] font-medium leading-none text-center">More</span>
            </button>
          </div>
        </nav>
      </>
    </>
  );
}
