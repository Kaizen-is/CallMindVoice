'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { signUpAction, type FormState } from '@/app/actions/auth';
import { Button } from '@/components/ui/primitives';
import { Field, Input, Select } from '@/components/ui/forms';
import { INDUSTRIES } from '@/lib/catalog';
import { IconAlert, IconCheck, IconEye, IconEyeOff, IconLock } from '@/components/icons';

const initial: FormState = {};

const BENEFITS = [
  'A working voice agent in the time it takes to make coffee',
  'Uzbek, Russian and English out of the box',
  'Every answer traceable to the document it came from',
  'Nothing to install — your team just opens a browser',
];

export function SignupForm() {
  const [state, action, pending] = useActionState(signUpAction, initial);
  const [show, setShow] = useState(false);
  const [password, setPassword] = useState('');

  const strength = scorePassword(password);

  return (
    <div className="grid w-full max-w-4xl gap-10 lg:grid-cols-[1fr_400px] lg:items-center">
      <div className="hidden lg:block">
        <h1 className="text-[34px] leading-[1.12] font-semibold tracking-[-0.03em] text-ink text-balance-pretty">
          Fourteen days to find out
          <br />
          if this works for you.
        </h1>
        <p className="mt-5 max-w-md text-[15.5px] leading-relaxed text-ink-2">
          No card, no sales call. Upload one document and phone your own agent — you will know
          within the hour whether it can carry your calls.
        </p>
        <ul className="mt-8 space-y-3">
          {BENEFITS.map((b) => (
            <li key={b} className="flex items-start gap-2.5 text-[14px] text-ink-2">
              <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                <IconCheck size={12} strokeWidth={3} />
              </span>
              {b}
            </li>
          ))}
        </ul>
      </div>

      <div className="animate-fade-up rounded-[18px] bg-surface p-7 shadow-e3 hairline">
        <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-ink">Create your agent</h2>
        <p className="mt-1.5 text-[13.5px] text-ink-2">Takes about a minute.</p>

        <form action={action} className="mt-6 space-y-4">
          {state.error && (
            <div className="flex items-start gap-2.5 rounded-[10px] bg-danger-soft p-3 text-[13px] text-danger">
              <IconAlert size={16} className="mt-px shrink-0" />
              {state.error}
            </div>
          )}

          <Field label="Company" htmlFor="company" required>
            <Input id="company" name="company" required placeholder="Medline Clinic" autoComplete="organization" />
          </Field>

          <Field label="What do you do?" htmlFor="industry">
            <Select id="industry" name="industry" defaultValue="clinic">
              {INDUSTRIES.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Your name" htmlFor="name" required>
            <Input id="name" name="name" required placeholder="Aziz Karimov" autoComplete="name" />
          </Field>

          <Field label="Work email" htmlFor="email" required>
            <Input id="email" name="email" type="email" required placeholder="you@company.uz" autoComplete="email" />
          </Field>

          <Field
            label="Password"
            htmlFor="password"
            required
            hint={password ? undefined : 'At least 8 characters.'}
          >
            <div className="relative">
              <Input
                id="password"
                name="password"
                type={show ? 'text' : 'password'}
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                icon={<IconLock size={15} />}
                className="pr-10"
                autoComplete="new-password"
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

          {password && (
            <div className="flex items-center gap-2">
              <div className="flex h-1 flex-1 gap-1">
                {[0, 1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`h-full flex-1 rounded-full transition-colors ${
                      i < strength.score
                        ? strength.score <= 1
                          ? 'bg-danger'
                          : strength.score === 2
                            ? 'bg-warning'
                            : 'bg-success'
                        : 'bg-[rgb(var(--text)/0.12)]'
                    }`}
                  />
                ))}
              </div>
              <span className="w-14 text-right text-[11.5px] text-ink-3">{strength.label}</span>
            </div>
          )}

          <Button type="submit" variant="primary" size="lg" full loading={pending}>
            Create account
          </Button>

          <p className="text-center text-[11.5px] leading-relaxed text-ink-3">
            By continuing you agree to the service terms and privacy policy.
          </p>
        </form>

        <p className="mt-5 text-center text-[13px] text-ink-3">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-brand hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}

function scorePassword(pw: string): { score: number; label: string } {
  if (!pw) return { score: 0, label: '' };
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) || /[^\w\s]/.test(pw)) score++;
  const labels = ['Weak', 'Weak', 'Fair', 'Good', 'Strong'];
  return { score, label: labels[score] };
}
