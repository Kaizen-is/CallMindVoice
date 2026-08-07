'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { Button, IconButton } from './primitives';
import { IconAlert, IconCheckCircle, IconInfo, IconX } from '@/components/icons';

/* ═══ Modal ════════════════════════════════════════════════════ */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!mounted || !open) return null;

  const width = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl', xl: 'max-w-4xl' }[size];

  return createPortal(
    <div className="fixed inset-0 z-100 flex items-center justify-center p-4">
      <div
        className="animate-fade absolute inset-0 bg-black/35 backdrop-blur-[3px] dark:bg-black/60"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={cn(
          'animate-scale-in relative w-full overflow-hidden rounded-[18px] bg-overlay shadow-e4 hairline',
          width,
        )}
      >
        {(title || description) && (
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4">
            <div className="min-w-0">
              {title && <h2 className="text-[16.5px] font-semibold text-ink">{title}</h2>}
              {description && <p className="mt-1 text-[13px] leading-relaxed text-ink-3">{description}</p>}
            </div>
            <IconButton label="Close" size="sm" onClick={onClose} className="-mt-1 -mr-2">
              <IconX size={17} />
            </IconButton>
          </div>
        )}
        {children && <div className="max-h-[65vh] overflow-y-auto px-6 pb-5">{children}</div>}
        {footer && (
          <div className="flex items-center justify-end gap-2 bg-surface-2 px-6 py-3.5 hairline-t">{footer}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

/* ═══ Drawer / Sheet ═══════════════════════════════════════════ */

export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  width = 480,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!mounted || !open) return null;

  return createPortal(
    <div className="fixed inset-0 z-100">
      <div className="animate-fade absolute inset-0 bg-black/30 backdrop-blur-[2px] dark:bg-black/55" onClick={onClose} />
      <aside
        className="animate-slide-left absolute inset-y-0 right-0 flex max-w-full flex-col bg-overlay shadow-e4 hairline"
        style={{ width }}
      >
        {title && (
          <header className="flex items-center justify-between gap-3 px-5 py-4 hairline-b">
            <h2 className="text-[15.5px] font-semibold text-ink">{title}</h2>
            <IconButton label="Close" size="sm" onClick={onClose}>
              <IconX size={17} />
            </IconButton>
          </header>
        )}
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
        {footer && <footer className="bg-surface-2 px-5 py-3.5 hairline-t">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

/* ═══ Toasts ═══════════════════════════════════════════════════ */

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

const ToastCtx = createContext<{
  toast: (t: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
}>({ toast: () => {}, success: () => {}, error: () => {} });

export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);

  const toast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = ++seq.current;
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== id)), 4600);
  }, []);

  const success = useCallback((title: string, description?: string) => toast({ tone: 'success', title, description }), [toast]);
  const error = useCallback((title: string, description?: string) => toast({ tone: 'error', title, description }), [toast]);

  return (
    <ToastCtx.Provider value={{ toast, success, error }}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-200 flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            className="animate-scale-in pointer-events-auto flex items-start gap-3 rounded-[12px] bg-overlay p-3.5 shadow-e3 hairline"
          >
            <span
              className={cn(
                'mt-px shrink-0',
                t.tone === 'success' ? 'text-success' : t.tone === 'error' ? 'text-danger' : 'text-info',
              )}
            >
              {t.tone === 'success' ? <IconCheckCircle size={18} /> : t.tone === 'error' ? <IconAlert size={18} /> : <IconInfo size={18} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] font-medium text-ink">{t.title}</p>
              {t.description && <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-3">{t.description}</p>}
            </div>
            <button
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
              className="-mt-0.5 -mr-0.5 shrink-0 rounded p-1 text-ink-3 transition-colors hover:text-ink"
              aria-label="Dismiss"
            >
              <IconX size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ═══ Dropdown menu ════════════════════════════════════════════ */

export function Menu({
  trigger,
  items,
  align = 'right',
  width = 200,
  header,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: Array<
    | { type: 'separator' }
    | { type: 'label'; label: string }
    | { type?: 'item'; label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean }
  >;
  align?: 'left' | 'right';
  width?: number;
  /** Optional non-interactive block rendered at the top (e.g. a profile card). */
  header?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      {trigger({ open, toggle: () => setOpen((v) => !v) })}
      {open && (
        <div
          className={cn(
            'animate-scale-in absolute z-50 mt-1.5 overflow-hidden rounded-[12px] bg-overlay p-1 shadow-e3 hairline',
            align === 'right' ? 'right-0' : 'left-0',
          )}
          style={{ width, transformOrigin: align === 'right' ? 'top right' : 'top left' }}
          role="menu"
        >
          {header}
          {items.map((it, i) => {
            if (it.type === 'separator') {
              return <div key={i} className="my-1 h-px bg-[rgb(var(--line)/var(--line-alpha))]" />;
            }
            if (it.type === 'label') {
              return (
                <div
                  key={i}
                  className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-[0.07em] text-ink-3 uppercase"
                >
                  {it.label}
                </div>
              );
            }
            return (
              <button
                key={i}
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  it.onClick();
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40',
                  it.danger ? 'text-danger hover:bg-danger-soft' : 'text-ink hover:bg-surface-3',
                )}
              >
                {it.icon}
                {it.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
