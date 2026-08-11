'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  addFaqAction,
  addStarterPackAction,
  addTextAction,
  addUrlAction,
  deleteDocumentAction,
  reindexDocumentAction,
  testRetrievalAction,
  uploadDocumentsAction,
} from '@/app/actions/knowledge';
import type { Document, UiLocale } from '@/lib/types';
import { translator, type Translate } from '@/lib/i18n';
import { cn, fmtBytes, fmtInt, relativeTime } from '@/lib/utils';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  IconButton,
  PageHeader,
  Progress,
  Segmented,
  Spinner,
} from '@/components/ui/primitives';
import { Field, FileDrop, Input, Textarea } from '@/components/ui/forms';
import { ConfirmDialog, Menu, Modal, useToast } from '@/components/ui/overlays';
import {
  IconAlert,
  IconBook,
  IconCheckCircle,
  IconDatabase,
  IconFileText,
  IconLink,
  IconMore,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconSparkle,
  IconTrash,
  IconX,
} from '@/components/icons';

interface Props {
  documents: Document[];
  stats: { documents: number; ready: number; chunks: number; tokens: number; bytes: number };
  locale: UiLocale;
  packTitle: string;
  packDescription: string;
  canEdit: boolean;
}

type AddMode = 'file' | 'url' | 'text' | 'faq';

function typeLabel(t: Translate, type: string): string {
  const map: Record<string, string> = {
    pdf: 'PDF',
    docx: 'Word',
    txt: t('kb.type.txt', 'Text'),
    md: 'Markdown',
    csv: t('kb.type.csv', 'Spreadsheet'),
    url: t('kb.type.url', 'Web page'),
    faq: 'FAQ',
  };
  return map[type] ?? type;
}

export function KnowledgeManager({ documents, stats, locale, packTitle, packDescription, canEdit }: Props) {
  const router = useRouter();
  const toast = useToast();
  const t = translator(locale);
  const [, start] = useTransition();

  const [adding, setAdding] = useState(false);
  const [mode, setMode] = useState<AddMode>('file');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Document | null>(null);
  const [inspecting, setInspecting] = useState(false);

  const refresh = () => start(() => router.refresh());

  const handleUpload = async (files: File[]) => {
    setBusy(true);
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    const res = await uploadDocumentsAction(fd);
    setBusy(false);
    if (res.ok) {
      toast.success(t('kb.toast.indexed', 'Indexed'), res.message);
      setAdding(false);
      refresh();
    } else {
      toast.error(t('kb.toast.uploadFailed', 'Upload failed'), res.message);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px]">
      <PageHeader
        title={t('kb.title')}
        subtitle={t('kb.subtitle')}
        actions={
          <>
            <Button variant="secondary" icon={<IconSearch size={15} />} onClick={() => setInspecting(true)}>
              {t('kb.inspect.open', 'Test retrieval')}
            </Button>
            {canEdit && (
              <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => setAdding(true)}>
                {t('kb.add')}
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MiniStat label={t('kb.stat.documents', 'Documents')} value={fmtInt(stats.documents)} icon={<IconFileText size={16} />} />
        <MiniStat label={t('kb.stat.passages', 'Indexed passages')} value={fmtInt(stats.chunks)} icon={<IconDatabase size={16} />} />
        <MiniStat label={t('kb.stat.tokens', 'Tokens')} value={fmtInt(stats.tokens)} icon={<IconBook size={16} />} />
        <MiniStat label={t('kb.stat.size', 'Source size')} value={fmtBytes(stats.bytes)} icon={<IconFileText size={16} />} />
      </div>

      <Card className="mt-4" padded={false}>
        {documents.length ? (
          <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
            {documents.map((d) => (
              <DocumentRow
                key={d.id}
                doc={d}
                t={t}
                locale={locale}
                canEdit={canEdit}
                onDelete={() => setConfirm(d)}
                onReindex={async () => {
                  const res = await reindexDocumentAction(d.id);
                  if (res.ok) toast.success(t('kb.toast.reindexed', 'Reindexed'), res.message);
                  else toast.error(t('kb.toast.reindexFailed', 'Could not reindex'), res.message);
                  refresh();
                }}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<IconBook size={20} />}
            title={t('kb.empty')}
            description={t('kb.emptyHint')}
            action={
              canEdit ? (
                <div className="flex flex-wrap justify-center gap-2">
                  <Button
                    variant="primary"
                    icon={<IconSparkle size={15} />}
                    loading={busy}
                    onClick={async () => {
                      setBusy(true);
                      const res = await addStarterPackAction();
                      setBusy(false);
                      if (res.ok) {
                        toast.success(t('kb.toast.packLoaded', 'Starter pack loaded'), res.message);
                        refresh();
                      } else toast.error(t('kb.toast.failed', 'Failed'), res.message);
                    }}
                  >
                    {t('kb.loadPack', 'Load {name}').replace('{name}', packTitle)}
                  </Button>
                  <Button variant="secondary" onClick={() => setAdding(true)}>
                    {t('kb.uploadOwn', 'Upload my own')}
                  </Button>
                </div>
              ) : undefined
            }
          />
        )}
      </Card>

      {documents.length > 0 && canEdit && (
        <p className="mt-3 text-[12.5px] text-ink-3">
          {t(
            'kb.tip',
            'Tip: {desc} — the starter pack is safe to delete once your own documents are in.',
          ).replace('{desc}', packDescription.toLowerCase())}
        </p>
      )}

      {/* ── add knowledge ── */}
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t('kb.add')}
        description={t('kb.add.desc', 'Anything you add here becomes something your agent is allowed to say.')}
        size="lg"
      >
        <Segmented
          className="mb-5"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'file', label: t('kb.add.files', 'Files') },
            { value: 'url', label: t('kb.type.url', 'Web page') },
            { value: 'text', label: t('kb.add.text', 'Paste text') },
            { value: 'faq', label: 'FAQ' },
          ]}
        />
        {mode === 'file' && (
          <FileDrop
            onFiles={handleUpload}
            busy={busy}
            dropLabel={t('filedrop.drop', 'Drop files or')}
            browseLabel={t('filedrop.browse', 'browse')}
          />
        )}
        {mode === 'url' && (
          <UrlForm
            t={t}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        )}
        {mode === 'text' && (
          <TextForm
            t={t}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        )}
        {mode === 'faq' && (
          <FaqForm
            t={t}
            onDone={() => {
              setAdding(false);
              refresh();
            }}
          />
        )}
      </Modal>

      <RetrievalInspector t={t} open={inspecting} onClose={() => setInspecting(false)} />

      <ConfirmDialog
        open={Boolean(confirm)}
        onClose={() => setConfirm(null)}
        danger
        confirmLabel={t('common.delete', 'Delete')}
        title={t('kb.confirm.title', 'Delete “{title}”?').replace('{title}', confirm?.title ?? '')}
        description={t(
          'kb.confirm.desc',
          'Its passages are removed from the index immediately. Your agent will stop answering from it.',
        )}
        onConfirm={async () => {
          if (!confirm) return;
          const res = await deleteDocumentAction(confirm.id);
          if (res.ok) toast.success(t('kb.toast.deleted', 'Deleted'), res.message);
          else toast.error(t('kb.toast.deleteFailed', 'Could not delete'), res.message);
          refresh();
        }}
      />
    </div>
  );
}

/* ── rows ────────────────────────────────────────────────────── */

function MiniStat({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-[12px] bg-surface p-4 shadow-e1 hairline">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-3 text-ink-3">
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-[17px] font-semibold text-ink tabular">{value}</div>
        <div className="text-[12px] text-ink-3">{label}</div>
      </div>
    </div>
  );
}

function DocumentRow({
  doc,
  t,
  locale,
  canEdit,
  onDelete,
  onReindex,
}: {
  doc: Document;
  t: Translate;
  locale: UiLocale;
  canEdit: boolean;
  onDelete: () => void;
  onReindex: () => void;
}) {
  const indexing = ['queued', 'parsing', 'chunking', 'embedding'].includes(doc.status);
  return (
    <div className="flex items-center gap-3 px-5 py-3.5">
      <span
        className={cn(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]',
          doc.status === 'ready'
            ? 'bg-success-soft text-success'
            : doc.status === 'failed'
              ? 'bg-danger-soft text-danger'
              : 'bg-brand-soft text-brand-ink',
        )}
      >
        {doc.status === 'ready' ? (
          <IconCheckCircle size={17} />
        ) : doc.status === 'failed' ? (
          <IconAlert size={17} />
        ) : (
          <Spinner size={16} />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-ink">{doc.title}</span>
          <Badge tone="neutral">{typeLabel(t, doc.source_type)}</Badge>
          {doc.language !== 'auto' && <Badge tone="brand">{doc.language.toUpperCase()}</Badge>}
        </div>
        {indexing ? (
          <div className="mt-1.5 max-w-[280px]">
            <Progress value={doc.progress} height={4} />
            <span className="mt-1 block text-[11.5px] text-ink-3 capitalize">{doc.status}…</span>
          </div>
        ) : doc.status === 'failed' ? (
          <p className="mt-0.5 truncate text-[12px] text-danger">{doc.error}</p>
        ) : (
          <p className="mt-0.5 truncate text-[12px] text-ink-3">
            {fmtInt(doc.chunk_count)} {t('kb.row.passages', 'passages')} · {fmtInt(doc.token_count)}{' '}
            {t('kb.row.tokens', 'tokens')} · {doc.source_ref ?? t('kb.row.pasted', 'pasted')} ·{' '}
            {relativeTime(doc.created_at, locale)}
          </p>
        )}
      </div>

      {canEdit && (
        <Menu
          width={190}
          align="right"
          trigger={({ toggle }) => (
            <IconButton label={t('kb.row.actions', 'Document actions')} size="sm" onClick={toggle}>
              <IconMore size={17} />
            </IconButton>
          )}
          items={[
            { label: t('kb.row.reindex', 'Rebuild index'), icon: <IconRefresh size={15} />, onClick: onReindex },
            { type: 'separator' },
            { label: t('common.delete', 'Delete'), icon: <IconTrash size={15} />, danger: true, onClick: onDelete },
          ]}
        />
      )}
    </div>
  );
}

/* ── add forms ───────────────────────────────────────────────── */

function UrlForm({ t, onDone }: { t: Translate; onDone: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <Field
        label={t('kb.url.address', 'Page address')}
        hint={t('kb.url.hint', 'We fetch the page, strip the navigation and index the readable text.')}
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://yourcompany.uz/prices"
          icon={<IconLink size={15} />}
        />
      </Field>
      <Button
        variant="primary"
        full
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const res = await addUrlAction(url);
          setBusy(false);
          if (res.ok) {
            toast.success(t('kb.toast.imported', 'Imported'), res.message);
            onDone();
          } else toast.error(t('kb.toast.importFailed', 'Could not import'), res.message);
        }}
      >
        {t('kb.url.submit', 'Import page')}
      </Button>
    </div>
  );
}

function TextForm({ t, onDone }: { t: Translate; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <Field label={t('kb.form.title', 'Title')}>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('kb.text.titlePlaceholder', 'Opening hours and prices')}
        />
      </Field>
      <Field
        label={t('kb.text.body', 'Text')}
        hint={t('kb.text.hint', 'One fact per line works best — the indexer keeps each line retrievable on its own.')}
      >
        <Textarea
          rows={10}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Ish vaqti\nDushanba–juma 09:00–18:00\nShanba 10:00–15:00'}
        />
      </Field>
      <Button
        variant="primary"
        full
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const res = await addTextAction(title, text);
          setBusy(false);
          if (res.ok) {
            toast.success(t('kb.toast.indexed', 'Indexed'), res.message);
            onDone();
          } else toast.error(t('kb.toast.indexFailed', 'Could not index'), res.message);
        }}
      >
        {t('kb.text.submit', 'Add to knowledge base')}
      </Button>
    </div>
  );
}

function FaqForm({ t, onDone }: { t: Translate; onDone: () => void }) {
  const toast = useToast();
  const [title, setTitle] = useState(t('kb.faq.defaultTitle', 'Frequently asked questions'));
  const [pairs, setPairs] = useState([{ q: '', a: '' }]);
  const [busy, setBusy] = useState(false);
  const answered = pairs.filter((p) => p.q.trim()).length;

  return (
    <div className="space-y-4">
      <Field label={t('kb.form.title', 'Title')}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <div className="space-y-3">
        {pairs.map((p, i) => (
          <div key={i} className="rounded-[11px] bg-surface-2 p-3.5">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-ink-3">
                {t('kb.faq.question', 'Question {n}').replace('{n}', String(i + 1))}
              </span>
              {pairs.length > 1 && (
                <IconButton
                  label={t('kb.faq.remove', 'Remove')}
                  size="xs"
                  onClick={() => setPairs((ps) => ps.filter((_, j) => j !== i))}
                >
                  <IconX size={14} />
                </IconButton>
              )}
            </div>
            <Input
              value={p.q}
              onChange={(e) =>
                setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))
              }
              placeholder={t('kb.faq.qPlaceholder', 'What a caller actually says')}
              className="mb-2"
            />
            <Textarea
              rows={2}
              value={p.a}
              onChange={(e) =>
                setPairs((ps) => ps.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))
              }
              placeholder={t('kb.faq.aPlaceholder', 'The answer, phrased the way you would say it out loud')}
            />
          </div>
        ))}
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={<IconPlus size={14} />}
        onClick={() => setPairs((ps) => [...ps, { q: '', a: '' }])}
      >
        {t('kb.faq.addAnother', 'Add another')}
      </Button>
      <Button
        variant="primary"
        full
        loading={busy}
        onClick={async () => {
          setBusy(true);
          const res = await addFaqAction(title, pairs);
          setBusy(false);
          if (res.ok) {
            toast.success(t('kb.toast.indexed', 'Indexed'), res.message);
            onDone();
          } else toast.error(t('kb.toast.indexFailed', 'Could not index'), res.message);
        }}
      >
        {answered === 0
          ? t('kb.faq.submitEmpty', 'Add questions')
          : answered === 1
            ? t('kb.faq.submitOne', 'Add 1 question')
            : t('kb.faq.submitOther', 'Add {n} questions').replace('{n}', String(answered))}
      </Button>
    </div>
  );
}

/* ── retrieval inspector ─────────────────────────────────────── */

interface Hit {
  documentTitle: string;
  heading: string | null;
  snippet: string;
  text: string;
  score: number;
  lexical: number;
  dense: number;
}

function RetrievalInspector({ t, open, onClose }: { t: Translate; open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    confidence: number;
    tookMs: number;
    strategy: string;
    totalChunks: number;
    hits: Hit[];
  } | null>(null);

  const run = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setResult(await testRetrievalAction(query));
    setBusy(false);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      title={t('kb.inspect.title', 'Retrieval inspector')}
      description={t(
        'kb.inspect.desc',
        'See exactly which passages a question pulls, and how confident the engine is. This is the same path a live call takes.',
      )}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex gap-2"
      >
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('kb.inspect.placeholder', 'Type a question a caller would ask…')}
          icon={<IconSearch size={15} />}
          className="flex-1"
        />
        <Button type="submit" variant="primary" loading={busy}>
          {t('common.search', 'Search')}
        </Button>
      </form>

      {result && (
        <div className="mt-5">
          <div className="mb-4 flex flex-wrap gap-2">
            <Badge tone={result.confidence >= 0.55 ? 'success' : 'warning'}>
              {t('kb.inspect.confidence', 'confidence')} {result.confidence.toFixed(2)}
            </Badge>
            <Badge tone="neutral">{result.tookMs} ms</Badge>
            <Badge tone="neutral">{result.strategy}</Badge>
            <Badge tone="neutral">
              {t('kb.inspect.searched', '{n} passages searched').replace('{n}', fmtInt(result.totalChunks))}
            </Badge>
          </div>

          {result.hits.length ? (
            <div className="space-y-2.5">
              {result.hits.map((h, i) => (
                <div key={i} className="rounded-[11px] bg-surface-2 p-4">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] font-medium text-ink">
                      {h.documentTitle}
                      {h.heading && <span className="text-ink-3"> › {h.heading}</span>}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <ScorePill label={t('kb.inspect.fused', 'fused')} value={h.score} tone="brand" />
                      <ScorePill label={t('kb.inspect.lexical', 'lexical')} value={h.lexical} />
                      <ScorePill label={t('kb.inspect.dense', 'dense')} value={h.dense} />
                    </div>
                  </div>
                  <p className="text-[13px] leading-relaxed whitespace-pre-line text-ink-2">
                    {h.text}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<IconAlert size={20} />}
              title={t('kb.inspect.emptyTitle', 'Nothing matched')}
              description={t(
                'kb.inspect.emptyDesc',
                'A live caller asking this would be handed to a person. Add a document or an FAQ entry to cover it.',
              )}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

function ScorePill({ label, value, tone }: { label: string; value: number; tone?: 'brand' }) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-0.5 text-[11px] tabular',
        tone === 'brand' ? 'bg-brand-soft text-brand-ink' : 'bg-surface-3 text-ink-3',
      )}
    >
      {label} {value.toFixed(2)}
    </span>
  );
}
