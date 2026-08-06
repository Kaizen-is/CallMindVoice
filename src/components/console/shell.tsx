'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { translator, LOCALE_SHORT } from '@/lib/i18n';
import type { UiLocale, SafeUser, Tenant } from '@/lib/types';
import { setLocaleAction, signOutAction } from '@/app/actions/auth';
import { Avatar, Badge, IconButton, StatusDot } from '@/components/ui/primitives';
import { Menu } from '@/components/ui/overlays';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  FlagEN,
  FlagRU,
  FlagUZ,
  IconBook,
  IconChart,
  IconChevronLeft,
  IconCode,
  IconCreditCard,
  IconGlobe,
  IconHash,
  IconHeadset,
  IconHome,
  IconInbox,
  IconLogout,
  IconMenu,
  IconSettings,
  IconSparkle,
  IconUsers,
  IconWave,
  IconX,
  Logo,
} from '@/components/icons';

export interface ShellCounts {
  waitingEscalations: number;
  activeCalls: number;
  documents: number;
}

interface NavItem {
  href: string;
  labelKey: string;
  icon: ReactNode;
  badge?: number;
  pulse?: boolean;
}

export function ConsoleShell({
  user,
  tenant,
  counts,
  children,
}: {
  user: SafeUser;
  tenant: Tenant;
  counts: ShellCounts;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const locale = (user.locale ?? 'en') as UiLocale;
  const t = translator(locale);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem('ovoz-nav') === 'collapsed');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => setMobileOpen(false), [pathname]);

  const toggleCollapse = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem('ovoz-nav', next ? 'collapsed' : 'open');
    } catch {
      /* ignore */
    }
  };

  const groups: Array<{ title: string; items: NavItem[] }> = [
    {
      title: t('nav.section.build'),
      items: [
        { href: '/app', labelKey: 'nav.overview', icon: <IconHome size={17} /> },
        {
          href: '/app/knowledge',
          labelKey: 'nav.knowledge',
          icon: <IconBook size={17} />,
          badge: counts.documents === 0 ? undefined : undefined,
        },
        { href: '/app/agent', labelKey: 'nav.agent', icon: <IconSparkle size={17} /> },
        { href: '/app/playground', labelKey: 'nav.playground', icon: <IconWave size={17} /> },
      ],
    },
    {
      title: t('nav.section.operate'),
      items: [
        {
          href: '/app/live',
          labelKey: 'nav.live',
          icon: <IconHeadset size={17} />,
          badge: counts.activeCalls || undefined,
          pulse: counts.activeCalls > 0,
        },
        {
          href: '/app/inbox',
          labelKey: 'nav.inbox',
          icon: <IconInbox size={17} />,
          badge: counts.waitingEscalations || undefined,
          pulse: counts.waitingEscalations > 0,
        },
        { href: '/app/calls', labelKey: 'nav.calls', icon: <IconHash size={17} /> },
      ],
    },
    {
      title: t('nav.section.measure'),
      items: [{ href: '/app/analytics', labelKey: 'nav.analytics', icon: <IconChart size={17} /> }],
    },
    {
      title: t('nav.section.manage'),
      items: [
        { href: '/app/numbers', labelKey: 'nav.numbers', icon: <IconGlobe size={17} /> },
        { href: '/app/team', labelKey: 'nav.team', icon: <IconUsers size={17} /> },
        { href: '/app/billing', labelKey: 'nav.billing', icon: <IconCreditCard size={17} /> },
        { href: '/app/developers', labelKey: 'nav.developers', icon: <IconCode size={17} /> },
        { href: '/app/settings', labelKey: 'nav.settings', icon: <IconSettings size={17} /> },
      ],
    },
  ];

  const isActive = (href: string) =>
    href === '/app' ? pathname === '/app' : pathname.startsWith(href);

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className={cn('flex h-16 items-center gap-2.5 px-4', collapsed && 'justify-center px-0')}>
        <Link href="/app" className="flex items-center gap-2.5">
          <Logo size={26} />
          {!collapsed && (
            <span className="text-[16px] font-semibold tracking-[-0.02em] text-ink">Ovoz</span>
          )}
        </Link>
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 pb-4">
        {groups.map((group) => (
          <div key={group.title}>
            {!collapsed && (
              <div className="mb-1.5 px-2.5 text-[10.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
                {group.title}
              </div>
            )}
            <div className="space-y-0.5">
              {group.items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    title={collapsed ? t(item.labelKey) : undefined}
                    className={cn(
                      'group relative flex items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13.5px] font-medium transition-all duration-150',
                      collapsed && 'justify-center px-0',
                      active
                        ? 'bg-surface-3 text-ink'
                        : 'text-ink-2 hover:bg-surface-3/60 hover:text-ink',
                    )}
                  >
                    {active && (
                      <span className="absolute top-1/2 -left-3 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-brand" />
                    )}
                    <span className={cn('shrink-0', active ? 'text-brand' : 'text-ink-3')}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="flex-1 truncate">{t(item.labelKey)}</span>}
                    {!collapsed && item.badge ? (
                      <Badge tone={item.pulse ? 'danger' : 'neutral'} className="px-1.5 py-0 tabular">
                        {item.badge}
                      </Badge>
                    ) : null}
                    {collapsed && item.badge ? (
                      <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-danger" />
                    ) : null}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className={cn('px-3 pb-3', collapsed && 'px-2')}>
        <button
          onClick={toggleCollapse}
          className={cn(
            'hidden w-full items-center gap-2 rounded-[9px] px-2.5 py-2 text-[12.5px] text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink lg:flex',
            collapsed && 'justify-center px-0',
          )}
        >
          <IconChevronLeft size={15} className={cn('transition-transform', collapsed && 'rotate-180')} />
          {!collapsed && t('shell.collapse')}
        </button>
      </div>
    </div>
  );

  const flag: Record<UiLocale, ReactNode> = {
    en: <FlagEN size={16} />,
    ru: <FlagRU size={16} />,
    uz: <FlagUZ size={16} />,
    'uz-Cyrl': <FlagUZ size={16} />,
  };

  return (
    <div className="flex min-h-screen bg-sunken">
      {/* desktop sidebar */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 bg-surface transition-[width] duration-200 hairline-r lg:block',
          collapsed ? 'w-[68px]' : 'w-[236px]',
        )}
      >
        {sidebar}
      </aside>

      {/* mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-100 lg:hidden">
          <div className="animate-fade absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="animate-slide-left absolute inset-y-0 left-0 w-[264px] bg-surface shadow-e4">
            <div className="absolute top-4 right-3">
              <IconButton label="Close menu" size="sm" onClick={() => setMobileOpen(false)}>
                <IconX size={17} />
              </IconButton>
            </div>
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex h-16 items-center gap-3 glass px-4 hairline-b sm:px-6">
          <IconButton
            label="Open menu"
            size="sm"
            className="lg:hidden"
            onClick={() => setMobileOpen(true)}
          >
            <IconMenu size={19} />
          </IconButton>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2.5">
              <span className="truncate text-[14px] font-semibold text-ink">{tenant.name}</span>
              {tenant.plan === 'trial' && <Badge tone="brand">Trial</Badge>}
            </div>
            <div className="flex items-center gap-2 text-[11.5px] text-ink-3">
              <StatusDot tone={counts.activeCalls > 0 ? 'success' : 'neutral'} pulse={counts.activeCalls > 0} />
              {counts.activeCalls === 0
                ? t('shell.quiet')
                : counts.activeCalls === 1
                  ? t('shell.liveOne')
                  : t('shell.liveMany').replace('{n}', String(counts.activeCalls))}
            </div>
          </div>

          <Menu
            width={180}
            trigger={({ toggle }) => (
              <button
                onClick={toggle}
                className="inline-flex h-9 items-center gap-2 rounded-[9px] px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
              >
                {flag[locale]}
                <span className="hidden sm:inline">{LOCALE_SHORT[locale]}</span>
              </button>
            )}
            items={[
              { label: 'O‘zbekcha', icon: <FlagUZ size={16} />, onClick: () => void setLocaleAction('uz') },
              { label: 'Ўзбекча', icon: <FlagUZ size={16} />, onClick: () => void setLocaleAction('uz-Cyrl') },
              { label: 'Русский', icon: <FlagRU size={16} />, onClick: () => void setLocaleAction('ru') },
              { label: 'English', icon: <FlagEN size={16} />, onClick: () => void setLocaleAction('en') },
            ]}
          />

          <ThemeToggle />

          <Menu
            width={220}
            trigger={({ toggle }) => (
              <button onClick={toggle} className="rounded-full transition-transform active:scale-95">
                <Avatar name={user.name} hue={user.avatar_hue} size={32} presence="online" />
              </button>
            )}
            items={[
              { label: user.email, onClick: () => {}, disabled: true },
              { type: 'separator' },
              { label: t('nav.settings'), icon: <IconSettings size={15} />, onClick: () => (window.location.href = '/app/settings') },
              { label: t('nav.team'), icon: <IconUsers size={15} />, onClick: () => (window.location.href = '/app/team') },
              { type: 'separator' },
              {
                label: t('common.signOut'),
                icon: <IconLogout size={15} />,
                danger: true,
                onClick: () => void signOutAction(),
              },
            ]}
          />
        </header>

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
