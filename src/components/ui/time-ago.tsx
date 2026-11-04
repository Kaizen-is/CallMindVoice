'use client';

/**
 * "6 seconds ago", rendered so hydration never fails on it. The server and the
 * browser compute relative time a moment apart, so the text can legitimately
 * differ by a second; a mismatch there made React rebuild the whole page on the
 * client (and drop the theme class with it). The `suppressHydrationWarning` on
 * this one element accepts that difference, and nothing else.
 */
import { relativeTime } from '@/lib/utils';

export function TimeAgo({
  iso,
  locale,
  className,
}: {
  iso: string | null | undefined;
  locale?: Parameters<typeof relativeTime>[1];
  className?: string;
}) {
  return (
    <time dateTime={iso ?? undefined} className={className} suppressHydrationWarning>
      {relativeTime(iso, locale)}
    </time>
  );
}
