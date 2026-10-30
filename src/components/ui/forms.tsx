'use client';

import {
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';
import { IconCheck, IconChevronDown, IconUpload } from '@/components/icons';

const FIELD_BASE =
  'w-full rounded-[10px] bg-surface text-ink hairline px-3 text-[13.5px] transition-all duration-150 placeholder:text-ink-3 focus:outline-none focus:border-[rgb(var(--brand)/0.6)] focus:ring-[3px] focus:ring-[rgb(var(--brand)/0.14)] disabled:opacity-50 disabled:bg-surface-3';

export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
  htmlFor,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={htmlFor} className="flex items-center gap-1 text-[12.5px] font-medium text-ink-2">
          {label}
          {required && <span className="text-danger">*</span>}
        </label>
      )}
      {children}
      {error ? (
        <p className="text-[12px] text-danger">{error}</p>
      ) : hint ? (
        <p className="text-[12px] leading-relaxed text-ink-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({
  className,
  icon,
  suffix,
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode; suffix?: ReactNode; invalid?: boolean }) {
  if (icon || suffix) {
    return (
      <div className="relative flex items-center">
        {icon && <span className="pointer-events-none absolute left-3 text-ink-3">{icon}</span>}
        <input
          className={cn(
            FIELD_BASE,
            'h-9.5',
            icon && 'pl-9.5',
            suffix && 'pr-11',
            invalid && 'border-[rgb(var(--danger)/0.5)]',
            className,
          )}
          {...rest}
        />
        {suffix && <span className="absolute right-3 text-[12px] text-ink-3">{suffix}</span>}
      </div>
    );
  }
  return <input className={cn(FIELD_BASE, 'h-9.5', invalid && 'border-[rgb(var(--danger)/0.5)]', className)} {...rest} />;
}

export function Textarea({
  className,
  rows = 4,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={rows} className={cn(FIELD_BASE, 'resize-y py-2.5 leading-relaxed', className)} {...rest} />;
}

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select className={cn(FIELD_BASE, 'h-9.5 cursor-pointer appearance-none pr-9', className)} {...rest}>
        {children}
      </select>
      <IconChevronDown size={15} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3" />
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const control = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-[24px] w-[42px] shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 disabled:opacity-45',
        checked ? 'bg-brand' : 'bg-[rgb(var(--text)/0.18)]',
      )}
    >
      <span
        className={cn(
          'inline-block h-[19px] w-[19px] rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.25)] transition-transform duration-200',
          checked ? 'translate-x-[20px]' : 'translate-x-[3px]',
        )}
      />
    </button>
  );
  if (!label) return <span className={className}>{control}</span>;
  return (
    <div className={cn('flex items-start justify-between gap-4', className)}>
      <div className="min-w-0">
        <label htmlFor={id} className="block cursor-pointer text-[13.5px] font-medium text-ink">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{description}</p>}
      </div>
      {control}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('flex cursor-pointer items-center gap-2.5 select-none', className)}>
      <span
        onClick={(e) => {
          e.preventDefault();
          onChange(!checked);
        }}
        className={cn(
          'flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-all duration-150',
          checked
            ? 'border-brand bg-brand text-white'
            : 'border-[rgb(var(--line)/0.28)] bg-surface hover:border-[rgb(var(--line)/0.45)]',
        )}
      >
        {checked && <IconCheck size={12} strokeWidth={3} />}
      </span>
      {label && <span className="text-[13.5px] text-ink">{label}</span>}
    </label>
  );
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  label,
  format,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: ReactNode;
  format?: (v: number) => string;
  className?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className={cn('space-y-2', className)}>
      {label && (
        <div className="flex items-baseline justify-between">
          <span className="text-[12.5px] font-medium text-ink-2">{label}</span>
          <span className="text-[12.5px] tabular text-ink">{format ? format(value) : value.toFixed(2)}</span>
        </div>
      )}
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-[0_1px_4px_rgb(0_0_0/0.3)] [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white"
        style={{
          background: `linear-gradient(90deg, rgb(var(--brand)) ${pct}%, rgb(var(--text)/0.12) ${pct}%)`,
        }}
      />
    </div>
  );
}

export function FileDrop({
  onFiles,
  accept = '.pdf,.docx,.txt,.md,.csv',
  multiple = true,
  className,
  hint,
  dropLabel,
  browseLabel,
  busy,
}: {
  onFiles: (files: File[]) => void;
  accept?: string;
  multiple?: boolean;
  className?: string;
  hint?: string;
  dropLabel?: string;
  browseLabel?: string;
  busy?: boolean;
}) {
  const [over, setOver] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
      onClick={() => !busy && ref.current?.click()}
      className={cn(
        'flex cursor-pointer flex-col items-center justify-center rounded-[14px] border-2 border-dashed px-6 py-10 text-center transition-all duration-200',
        over
          ? 'border-brand bg-brand-soft'
          : 'border-[rgb(var(--line)/0.2)] bg-surface-2 hover:border-[rgb(var(--brand)/0.45)] hover:bg-surface-3',
        busy && 'pointer-events-none opacity-60',
        className,
      )}
    >
      <input
        ref={ref}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          e.target.value = '';
        }}
      />
      <div
        className={cn(
          'mb-3 flex h-11 w-11 items-center justify-center rounded-[12px] transition-colors',
          over ? 'bg-brand text-white' : 'bg-surface-3 text-ink-2',
        )}
      >
        <IconUpload size={20} />
      </div>
      <p className="text-[14px] font-medium text-ink">
        {dropLabel ?? 'Drop files or'} <span className="text-brand">{browseLabel ?? 'browse'}</span>
      </p>
      <p className="mt-1 text-[12.5px] text-ink-3">{hint ?? 'PDF, DOCX, TXT, MD, CSV — up to 25 MB each'}</p>
    </div>
  );
}
