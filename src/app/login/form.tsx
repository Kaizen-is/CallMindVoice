'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { signInAction, type FormState } from '@/app/actions/auth';
import { Button } from '@/components/ui/primitives';
import { Field, Input } from '@/components/ui/forms';
import { IconAlert, IconEye, IconEyeOff, IconLock, IconSparkle } from '@/components/icons';

const initial: FormState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(signInAction, initial);
  const [show, setShow] = useState(false);

  return (
    <div className="w-full max-w-[400px]">
      <div className="animate-fade-up rounded-[18px] bg-surface p-7 shadow-e3 hairline">
        <h1 className="text-[22px] font-semibold tracking-[-0.025em] text-ink">Welcome back</h1>
        <p className="mt-1.5 text-[13.5px] text-ink-2">Sign in to your Ovoz console.</p>

        <form action={action} className="mt-6 space-y-4">
          {state.error && (
            <div className="flex items-start gap-2.5 rounded-[10px] bg-danger-soft p-3 text-[13px] text-danger">
              <IconAlert size={16} className="mt-px shrink-0" />
              {state.error}
            </div>
          )}

          <Field label="Work email" htmlFor="email">
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@company.uz"
            />
          </Field>

          <Field label="Password" htmlFor="password">
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                icon={<IconLock size={15} />}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShow((s) => !s)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-ink-3 transition-colors hover:text-ink"
              >
                {show ? <IconEyeOff size={16} /> : <IconEye size={16} />}
              </button>
            </div>
          </Field>

          <Button type="submit" variant="primary" size="lg" full loading={pending}>
            Sign in
          </Button>
        </form>

        <p className="mt-5 text-center text-[13px] text-ink-3">
          No account yet?{' '}
          <Link href="/signup" className="font-medium text-brand hover:underline">
            Create one
          </Link>
        </p>
      </div>

      <div className="animate-fade-up mt-4 rounded-[14px] bg-surface-2 p-4 hairline" style={{ animationDelay: '80ms' }}>
        <div className="flex items-start gap-2.5">
          <IconSparkle size={16} className="mt-px shrink-0 text-brand" />
          <div className="text-[12.5px] leading-relaxed text-ink-2">
            <span className="font-medium text-ink">Demo account.</span> Sign in with{' '}
            <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
              demo@medline.uz
            </code>{' '}
            /{' '}
            <code className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[11.5px] text-ink">
              ovozdemo2026
            </code>{' '}
            to explore a clinic with a month of call history already loaded.
          </div>
        </div>
      </div>
    </div>
  );
}
