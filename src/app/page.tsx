import Link from 'next/link';
import './landing.css';
import { LandingCall } from '@/components/marketing/landing-call';
import { RoiCalculator } from '@/components/marketing/roi-calculator';
import { ThemeToggle } from '@/components/theme-toggle';
import { LinkButton } from '@/components/ui/primitives';
import { UZS_RATES } from '@/lib/catalog';
import { fmtUzs } from '@/lib/utils';
import { IconPhone, Wordmark } from '@/components/icons';
import { currentSession } from '@/lib/auth';
import { resolveUiLocale } from '@/lib/locale-server';
import { translator, type Translate } from '@/lib/i18n';
import { LocaleSwitcher } from '@/components/locale-switcher';
import type { UiLocale } from '@/lib/types';

/*
 * The landing page. It shares the console's CallMind red; its own type lives in
 * ./landing.css, scoped to `.lp`. One bold element — the call you can hear in
 * the hero — and everything after it quiet: lists and tables rather than card
 * grids, sentence-case headings without eyebrow labels.
 */

export default async function LandingPage() {
  const session = await currentSession();
  // Signed-in visitors follow their saved locale; anonymous visitors follow the
  // `ovoz_locale` cookie set by the header switcher; otherwise default to Uzbek (Latin).
  const locale = await resolveUiLocale(session?.user.locale);
  const t = translator(locale);

  return (
    <div className="lp relative min-h-screen">
      <Nav signedIn={Boolean(session)} locale={locale} t={t} />
      <Hero signedIn={Boolean(session)} locale={locale} t={t} />
      <HowItWorks t={t} />
      <CallFlow t={t} />
      <Languages t={t} />
      <Features t={t} />
      <Roi t={t} locale={locale} />
      <Pricing t={t} />
      <Security t={t} />
      <FinalCta signedIn={Boolean(session)} t={t} />
      <Footer t={t} />
    </div>
  );
}

/* ═══ nav ═══════════════════════════════════════════════════════ */

function Nav({ signedIn, locale, t }: { signedIn: boolean; locale: UiLocale; t: Translate }) {
  const links: Array<[string, string]> = [
    [t('lp.nav.how'), '#how'],
    [t('lp.nav.languages'), '#languages'],
    [t('lp.nav.platform'), '#features'],
    [t('lp.nav.roi'), '#roi'],
    [t('lp.nav.pricing'), '#pricing'],
  ];
  return (
    // suppressHydrationWarning: some browser extensions inject attributes (e.g.
    // `zn_id`) onto the sticky header before React hydrates; this stops that
    // extension noise from tripping a hydration mismatch on this element.
    <header className="sticky top-0 z-50 w-full glass hairline-b" suppressHydrationWarning>
      <div
        className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:gap-6 sm:px-5"
        suppressHydrationWarning
      >
        <Link href="/" className="shrink-0">
          <Wordmark />
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {links.map(([label, href]) => (
            <a
              key={href}
              href={href}
              className="rounded-[8px] px-3 py-2 text-[14px] text-ink-2 transition-colors hover:text-ink"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-1 sm:gap-2">
          <LocaleSwitcher locale={locale} />
          <ThemeToggle />
          {signedIn ? (
            <LinkButton href="/app" variant="primary" size="sm">
              {t('lp.nav.openConsole')}
            </LinkButton>
          ) : (
            <>
              <LinkButton href="/login" variant="ghost" size="sm" className="hidden sm:inline-flex">
                {t('lp.nav.signin')}
              </LinkButton>
              <LinkButton href="/signup" variant="primary" size="sm">
                {t('lp.nav.startFree')}
              </LinkButton>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/* ═══ hero: the call is the hero ════════════════════════════════ */

function Hero({ signedIn, locale, t }: { signedIn: boolean; locale: UiLocale; t: Translate }) {
  const callLang = locale === 'ru' ? 'ru' : locale === 'en' ? 'en' : 'uz';
  return (
    <section className="mx-auto max-w-6xl px-5 pt-14 pb-20 sm:pt-20 sm:pb-24">
      <div className="grid items-start gap-12 lg:grid-cols-[1fr_1.05fr] lg:gap-14">
        <div className="lg:pt-6">
          <p className="text-[14px] text-ink-3">{t('lp.hero.badge')}</p>
          <h1 className="lp-display mt-4 text-[36px] text-balance-pretty sm:text-[48px]">
            {t('lp.hero.title1')} {t('lp.hero.title2')}
          </h1>
          <p className="mt-6 max-w-[34rem] text-[17px] leading-relaxed text-ink-2">{t('lp.hero.sub')}</p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <LinkButton href={signedIn ? '/app' : '/signup'} variant="primary" size="lg">
              {signedIn ? t('lp.hero.ctaConsole') : t('lp.hero.ctaStart')}
            </LinkButton>
            <LinkButton href="/login" variant="secondary" size="lg" icon={<IconPhone size={16} />}>
              {t('lp.hero.ctaDemo')}
            </LinkButton>
          </div>
          <ul className="mt-8 space-y-1.5 text-[14px] text-ink-3">
            {[t('lp.hero.trust1'), t('lp.hero.trust2'), t('lp.hero.trust3')].map((label) => (
              <li key={label}>{label}</li>
            ))}
          </ul>
        </div>

        <LandingCall
          initialLang={callLang}
          labels={{
            title: t('lp.call.title'),
            play: t('lp.call.play'),
            pause: t('lp.call.pause'),
            caller: t('lp.call.caller'),
            agent: t('lp.call.agent'),
            source: t('lp.call.source'),
            note: t('lp.call.note'),
          }}
        />
      </div>
    </section>
  );
}

/* ═══ how it works — a real sequence, so it is numbered ═════════ */

function HowItWorks({ t }: { t: Translate }) {
  const steps = [
    { title: t('lp.how.s1t'), body: t('lp.how.s1b') },
    { title: t('lp.how.s2t'), body: t('lp.how.s2b') },
    { title: t('lp.how.s3t'), body: t('lp.how.s3b') },
  ];
  return (
    <section id="how" className="scroll-mt-20 hairline-t border-t">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead title={t('lp.how.title')} subtitle={t('lp.how.sub')} />
        <ol className="mt-12 grid gap-10 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title}>
              <span className="lp-display text-[28px] text-brand">{i + 1}</span>
              <h3 className="mt-3 text-[17px] font-semibold text-ink">{s.title}</h3>
              <p className="mt-2 max-w-[22rem] text-[15px] leading-relaxed text-ink-2">{s.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ═══ a call, step by step, with its time budget ════════════════ */

function CallFlow({ t }: { t: Translate }) {
  const budget = [
    { label: t('lp.lat.b1'), ms: 180 },
    { label: t('lp.lat.b2'), ms: 45 },
    { label: t('lp.lat.b3'), ms: 240 },
    { label: t('lp.lat.b4'), ms: 120 },
  ];
  const total = budget.reduce((a, b) => a + b.ms, 0);
  const steps = [t('lp.lat.step1'), t('lp.lat.step2'), t('lp.lat.step3'), t('lp.lat.step4')];

  return (
    <section className="bg-sunken">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead title={t('lp.lat.title')} subtitle={t('lp.lat.sub')} />
          <ol className="mt-8 space-y-4">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-4">
                <span className="w-5 shrink-0 text-[15px] font-semibold text-brand tabular">{i + 1}</span>
                <p className="text-[15px] leading-relaxed text-ink-2">{step}</p>
              </li>
            ))}
          </ol>
        </div>

        <div className="self-center">
          <div className="flex items-baseline justify-between hairline-b pb-3">
            <span className="text-[14px] text-ink-2">{t('lp.lat.target')}</span>
            <span className="lp-display text-[26px] text-ink tabular">{total} ms</span>
          </div>
          <div className="mt-5 flex h-3 w-full overflow-hidden rounded-full bg-surface-3">
            {budget.map((b, i) => (
              <div
                key={b.label}
                className={'bg-brand'}
                style={{ width: `${(b.ms / total) * 100}%`, opacity: 1 - i * 0.15 }}
              />
            ))}
          </div>
          <table className="mt-5 w-full text-[14px]">
            <tbody>
              {budget.map((b) => (
                <tr key={b.label} className="hairline-b">
                  <td className="py-2.5 text-ink-2">{b.label}</td>
                  <td className="py-2.5 text-right text-ink tabular">{b.ms} ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

/* ═══ languages ═════════════════════════════════════════════════ */

function Languages({ t }: { t: Translate }) {
  const features = [
    { title: t('lp.lang.f1t'), desc: t('lp.lang.f1d') },
    { title: t('lp.lang.f2t'), desc: t('lp.lang.f2d') },
    { title: t('lp.lang.f3t'), desc: t('lp.lang.f3d') },
  ];
  // Sample dialogue stays in its own language — it demonstrates the languages
  // themselves, so it is intentionally not driven by the UI locale.
  const samples = [
    { name: 'O‘zbekcha', q: 'Kardiolog qabuli qancha turadi?', a: 'Kardiolog qabuli 180 000 so‘m.' },
    { name: 'Русский', q: 'Вы принимаете страховой полис?', a: 'Да, мы работаем с четырьмя страховыми.' },
    { name: 'English', q: 'What time do you close on Saturdays?', a: 'Saturdays we are open 10 until 3.' },
  ];

  return (
    <section id="languages" className="scroll-mt-20">
      <div className="mx-auto grid max-w-6xl gap-12 px-5 py-20 lg:grid-cols-2 lg:gap-16">
        <div>
          <SectionHead title={t('lp.lang.title')} subtitle={t('lp.lang.sub')} />
          <dl className="mt-8 space-y-5">
            {features.map((f) => (
              <div key={f.title}>
                <dt className="text-[15.5px] font-semibold text-ink">{f.title}</dt>
                <dd className="mt-1 text-[15px] leading-relaxed text-ink-2">{f.desc}</dd>
              </div>
            ))}
          </dl>
        </div>
        <ul className="self-center">
          {samples.map((s) => (
            <li key={s.name} className="hairline-b py-5 first:pt-0">
              <div className="text-[13px] font-medium text-ink-3">{s.name}</div>
              <p className="mt-1.5 text-[16px] text-ink-2">{s.q}</p>
              <p className="lp-agent mt-1 text-[16px]">{s.a}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ═══ features ══════════════════════════════════════════════════ */

function Features({ t }: { t: Translate }) {
  const features = [
    { title: t('lp.feat.f1t'), body: t('lp.feat.f1b') },
    { title: t('lp.feat.f2t'), body: t('lp.feat.f2b') },
    { title: t('lp.feat.f3t'), body: t('lp.feat.f3b') },
    { title: t('lp.feat.f4t'), body: t('lp.feat.f4b') },
    { title: t('lp.feat.f5t'), body: t('lp.feat.f5b') },
    { title: t('lp.feat.f6t'), body: t('lp.feat.f6b') },
  ];
  return (
    <section id="features" className="scroll-mt-20 bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead title={t('lp.feat.title')} subtitle={t('lp.feat.sub')} />
        <dl className="mt-12 grid gap-x-14 sm:grid-cols-2">
          {features.map((f) => (
            <div key={f.title} className="hairline-t py-6">
              <dt className="text-[16px] font-semibold text-ink">{f.title}</dt>
              <dd className="mt-2 max-w-[32rem] text-[15px] leading-relaxed text-ink-2">{f.body}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ═══ roi ═══════════════════════════════════════════════════════ */

function Roi({ t, locale }: { t: Translate; locale: UiLocale }) {
  return (
    <section id="roi" className="scroll-mt-20">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead title={t('lp.roi.title')} subtitle={t('lp.roi.sub')} />
        <div className="mt-10 rounded-[20px] bg-surface p-7 shadow-e1 hairline sm:p-9">
          <RoiCalculator locale={locale} />
        </div>
      </div>
    </section>
  );
}

/* ═══ pricing — three rates, so a table ═════════════════════════ */

function Pricing({ t }: { t: Translate }) {
  // Prepaid balance model: three per-minute rates come straight from the catalog
  // (single source of truth); only the words around them are localised.
  const perMin = `/${t('lp.roicalc.min')}`;
  const rows = [
    { title: t('lp.price.c1title'), rate: UZS_RATES.realTalkPerMin, desc: t('lp.price.c1desc') },
    { title: t('lp.price.c2title'), rate: UZS_RATES.ttsPerMin, desc: t('lp.price.c2desc') },
    { title: t('lp.price.c3title'), rate: UZS_RATES.sttPerMin, desc: t('lp.price.c3desc') },
  ];
  return (
    <section id="pricing" className="scroll-mt-20 bg-sunken">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead title={t('lp.price.title')} subtitle={t('lp.price.sub')} />
        <div className="mt-10">
          {rows.map((r) => (
            <div
              key={r.title}
              className="grid gap-2 hairline-t py-6 sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-10"
            >
              <div>
                <h3 className="text-[17px] font-semibold text-ink">{r.title}</h3>
                <p className="mt-1.5 max-w-[40rem] text-[15px] leading-relaxed text-ink-2">{r.desc}</p>
              </div>
              <div className="whitespace-nowrap sm:text-right">
                <span className="lp-display text-[26px] text-ink tabular">{fmtUzs(r.rate)}</span>
                <span className="ml-1 text-[14px] text-ink-3">{perMin}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ═══ security ══════════════════════════════════════════════════ */

function Security({ t }: { t: Translate }) {
  const items = [
    { title: t('lp.sec.i1t'), desc: t('lp.sec.i1d') },
    { title: t('lp.sec.i2t'), desc: t('lp.sec.i2d') },
    { title: t('lp.sec.i3t'), desc: t('lp.sec.i3d') },
    { title: t('lp.sec.i4t'), desc: t('lp.sec.i4d') },
  ];
  return (
    <section>
      <div className="mx-auto max-w-6xl px-5 py-20">
        <SectionHead title={t('lp.sec.title')} subtitle={t('lp.sec.sub')} />
        <dl className="mt-10 grid gap-x-14 sm:grid-cols-2">
          {items.map((i) => (
            <div key={i.title} className="hairline-t py-6">
              <dt className="text-[16px] font-semibold text-ink">{i.title}</dt>
              <dd className="mt-2 text-[15px] leading-relaxed text-ink-2">{i.desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/* ═══ cta + footer ══════════════════════════════════════════════ */

function FinalCta({ signedIn, t }: { signedIn: boolean; t: Translate }) {
  return (
    <section className="bg-[rgb(23_23_27)] text-white dark:bg-[rgb(var(--bg-sunken))]">
      <div className="mx-auto max-w-6xl px-5 py-20">
        <h2 className="lp-display max-w-[40rem] text-[30px] text-balance-pretty sm:text-[38px]">
          {t('lp.cta.title1')} {t('lp.cta.title2')}
        </h2>
        <p className="mt-5 max-w-[36rem] text-[16px] leading-relaxed text-white/75">{t('lp.cta.sub')}</p>
        <div className="mt-8 flex flex-wrap items-center gap-3">
          <LinkButton href={signedIn ? '/app' : '/signup'} variant="primary" size="lg">
            {signedIn ? t('lp.hero.ctaConsole') : t('lp.cta.create')}
          </LinkButton>
          {!signedIn && (
            <Link href="/login" className="px-2 text-[15px] text-white/80 underline-offset-4 hover:text-white hover:underline">
              {t('lp.nav.signin')}
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function Footer({ t }: { t: Translate }) {
  return (
    <footer className="hairline-t border-t">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="text-[13px] text-ink-3">{t('lp.footer.tagline')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-[13px] text-ink-3">
          <a href="#how" className="transition-colors hover:text-ink">{t('lp.nav.how')}</a>
          <a href="#pricing" className="transition-colors hover:text-ink">{t('lp.nav.pricing')}</a>
          <Link href="/login" className="transition-colors hover:text-ink">{t('lp.nav.signin')}</Link>
          <span>© {new Date().getFullYear()} CallMind AI</span>
        </div>
      </div>
    </footer>
  );
}

/* ═══ shared ════════════════════════════════════════════════════ */

function SectionHead({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="max-w-[40rem]">
      <h2 className="lp-display text-[26px] text-ink text-balance-pretty sm:text-[32px]">{title}</h2>
      {subtitle && <p className="mt-4 text-[16px] leading-relaxed text-ink-2">{subtitle}</p>}
    </div>
  );
}
