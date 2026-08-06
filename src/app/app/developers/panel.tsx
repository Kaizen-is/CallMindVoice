'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  createApiKeyAction,
  deleteWebhookAction,
  revokeApiKeyAction,
  saveWebhookAction,
} from '@/app/actions/ops';
import type { ApiKey, Webhook } from '@/lib/types';
import { fmtDateTime, relativeTime } from '@/lib/utils';
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader, Segmented } from '@/components/ui/primitives';
import { Field, Input, Select } from '@/components/ui/forms';
import { ConfirmDialog, Modal, useToast } from '@/components/ui/overlays';
import { CopyField } from '@/components/console/copy-field';
import { IconCode, IconKey, IconLink, IconPlus, IconTrash } from '@/components/icons';

const ENDPOINTS = [
  {
    method: 'POST',
    path: '/v1/answer',
    desc: 'Ask the agent a question and get a grounded answer with citations.',
    body: `{
  "question": "Kardiolog qabuli qancha turadi?",
  "language": "uz",
  "callId": null
}`,
    response: `{
  "answer": "Kardiolog qabuli 180 000 so'm...",
  "confidence": 0.91,
  "answered": true,
  "escalate": null,
  "citations": [
    { "documentTitle": "Narxlar 2026.pdf",
      "heading": "Qabul narxlari",
      "score": 0.94 }
  ],
  "timings": { "retrievalMs": 12, "llmMs": 240, "totalMs": 268 }
}`,
  },
  {
    method: 'GET',
    path: '/v1/calls',
    desc: 'List calls with transcripts, outcomes and latency.',
    body: '?limit=50&outcome=escalated&from=2026-08-01',
    response: `{
  "data": [
    { "id": "call_...", "from": "+99890...", "outcome": "resolved_by_ai",
      "language": "uz", "turns": 4, "durationMs": 61200,
      "avgLatencyMs": 540, "csat": 5 }
  ],
  "hasMore": false
}`,
  },
  {
    method: 'POST',
    path: '/v1/documents',
    desc: 'Push a document into the knowledge base and index it.',
    body: `{
  "title": "August price list",
  "text": "Terapevt qabuli — 120 000 so'm...",
  "sourceType": "txt"
}`,
    response: `{ "id": "doc_...", "chunks": 14, "status": "ready" }`,
  },
];

const WEBHOOK_EVENTS = [
  'call.started',
  'call.completed',
  'call.escalated',
  'escalation.resolved',
  'document.indexed',
];

export function DevelopersPanel({
  keys,
  hooks,
  tenantId,
  exampleNumber,
  canEdit,
}: {
  keys: ApiKey[];
  hooks: Webhook[];
  tenantId: string;
  exampleNumber: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [scopes, setScopes] = useState('read');
  const [busy, setBusy] = useState(false);
  const [confirmKey, setConfirmKey] = useState<ApiKey | null>(null);
  const [hookOpen, setHookOpen] = useState(false);
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState('call.completed');
  const [lang, setLang] = useState<'curl' | 'node' | 'python'>('curl');
  const [endpoint, setEndpoint] = useState(0);

  const refresh = () => start(() => router.refresh());
  const active = ENDPOINTS[endpoint];

  const snippet = () => {
    const base = 'https://api.ovoz.ai';
    if (lang === 'curl') {
      return active.method === 'GET'
        ? `curl "${base}${active.path}${active.body}" \\\n  -H "Authorization: Bearer $OVOZ_API_KEY"`
        : `curl -X POST ${base}${active.path} \\\n  -H "Authorization: Bearer $OVOZ_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '${active.body.replace(/\n\s*/g, ' ')}'`;
    }
    if (lang === 'node') {
      return active.method === 'GET'
        ? `const res = await fetch(\n  "${base}${active.path}${active.body}",\n  { headers: { Authorization: \`Bearer \${process.env.OVOZ_API_KEY}\` } },\n);\nconst data = await res.json();`
        : `const res = await fetch("${base}${active.path}", {\n  method: "POST",\n  headers: {\n    Authorization: \`Bearer \${process.env.OVOZ_API_KEY}\`,\n    "Content-Type": "application/json",\n  },\n  body: JSON.stringify(${active.body.replace(/\n/g, '\n  ')}),\n});\nconst data = await res.json();`;
    }
    return active.method === 'GET'
      ? `import os, requests\n\nres = requests.get(\n    "${base}${active.path}${active.body}",\n    headers={"Authorization": f"Bearer {os.environ['OVOZ_API_KEY']}"},\n)\ndata = res.json()`
      : `import os, requests\n\nres = requests.post(\n    "${base}${active.path}",\n    headers={"Authorization": f"Bearer {os.environ['OVOZ_API_KEY']}"},\n    json=${active.body.replace(/\n/g, '\n    ')},\n)\ndata = res.json()`;
  };

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Developers"
        subtitle="Keys, webhooks and the REST surface for wiring the agent into whatever your team already uses."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card padded={false}>
          <div className="flex items-center justify-between gap-3 px-5 py-4 hairline-b">
            <div className="flex items-center gap-2">
              <IconKey size={16} className="text-ink-3" />
              <h3 className="text-[14px] font-semibold text-ink">API keys</h3>
            </div>
            {canEdit && (
              <Button size="xs" variant="secondary" icon={<IconPlus size={13} />} onClick={() => setCreating(true)}>
                New key
              </Button>
            )}
          </div>
          {keys.length ? (
            <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
              {keys.map((k) => (
                <div key={k.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-ink">{k.name}</span>
                      <Badge tone={k.revoked_at ? 'danger' : 'success'}>
                        {k.revoked_at ? 'Revoked' : k.scopes}
                      </Badge>
                    </div>
                    <p className="mt-0.5 font-mono text-[11.5px] text-ink-3">
                      {k.prefix}••••••••  · created {relativeTime(k.created_at)}
                      {k.last_used && ` · used ${relativeTime(k.last_used)}`}
                    </p>
                  </div>
                  {canEdit && !k.revoked_at && (
                    <Button size="xs" variant="ghost" onClick={() => setConfirmKey(k)}>
                      <IconTrash size={14} />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<IconKey size={20} />}
              title="No keys yet"
              description="Create one to call the API from your own systems."
            />
          )}
        </Card>

        <Card padded={false}>
          <div className="flex items-center justify-between gap-3 px-5 py-4 hairline-b">
            <div className="flex items-center gap-2">
              <IconLink size={16} className="text-ink-3" />
              <h3 className="text-[14px] font-semibold text-ink">Webhooks</h3>
            </div>
            {canEdit && (
              <Button size="xs" variant="secondary" icon={<IconPlus size={13} />} onClick={() => setHookOpen(true)}>
                Add
              </Button>
            )}
          </div>
          {hooks.length ? (
            <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
              {hooks.map((h) => (
                <div key={h.id} className="px-5 py-3">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink">
                      {h.url}
                    </span>
                    {canEdit && (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={async () => {
                          await deleteWebhookAction(h.id);
                          refresh();
                        }}
                      >
                        <IconTrash size={14} />
                      </Button>
                    )}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {h.events.split(',').map((e) => (
                      <Badge key={e} tone="neutral">
                        {e.trim()}
                      </Badge>
                    ))}
                  </div>
                  <p className="mt-1.5 font-mono text-[11px] text-ink-3">
                    signing secret {h.secret.slice(0, 14)}••••
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState
              icon={<IconLink size={20} />}
              title="No webhooks"
              description="Get a signed POST whenever a call completes or escalates."
            />
          )}
        </Card>
      </div>

      <Card className="mt-4" padded={false}>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hairline-b">
          <div className="flex items-center gap-2">
            <IconCode size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">REST API</h3>
          </div>
          <Segmented
            size="sm"
            value={lang}
            onChange={setLang}
            options={[
              { value: 'curl', label: 'cURL' },
              { value: 'node', label: 'Node' },
              { value: 'python', label: 'Python' },
            ]}
          />
        </div>

        <div className="grid gap-0 md:grid-cols-[220px_1fr]">
          <div className="hairline-b md:border-b-0 md:hairline-r">
            {ENDPOINTS.map((e, i) => (
              <button
                key={e.path}
                onClick={() => setEndpoint(i)}
                className={`block w-full px-5 py-3 text-left transition-colors ${
                  endpoint === i ? 'bg-brand-soft' : 'hover:bg-surface-2'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Badge tone={e.method === 'GET' ? 'info' : 'success'}>{e.method}</Badge>
                  <span className="font-mono text-[12px] text-ink">{e.path}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="p-5">
            <p className="text-[13px] text-ink-2">{active.desc}</p>
            <div className="mt-4 space-y-4">
              <div>
                <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  Request
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
                  {snippet()}
                </pre>
              </div>
              <div>
                <div className="mb-1.5 text-[11.5px] font-semibold tracking-wide text-ink-3 uppercase">
                  Response
                </div>
                <pre className="overflow-x-auto rounded-[10px] bg-surface-3 p-3.5 font-mono text-[11.5px] leading-relaxed text-ink">
                  {active.response}
                </pre>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="mt-4">
        <CardHeader
          title="Tenant identifiers"
          subtitle="You will need these when opening a support ticket or wiring an integration."
        />
        <div className="mt-4 space-y-3">
          <CopyField label="Tenant ID" value={tenantId} />
          <CopyField label="Primary number" value={exampleNumber} />
        </div>
      </Card>

      {/* new key */}
      <Modal
        open={creating}
        onClose={() => {
          setCreating(false);
          setNewKey(null);
        }}
        title={newKey ? 'Copy your key now' : 'Create an API key'}
        description={
          newKey
            ? 'This is the only time it will be shown. We store a hash, not the key itself.'
            : 'Scope it to what the integration actually needs.'
        }
        footer={
          newKey ? (
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setCreating(false);
                setNewKey(null);
                refresh();
              }}
            >
              Done
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                loading={busy}
                onClick={async () => {
                  setBusy(true);
                  const res = await createApiKeyAction(keyName, scopes);
                  setBusy(false);
                  if (res.ok && res.key) setNewKey(res.key);
                  else toast.error('Could not create the key');
                }}
              >
                Create
              </Button>
            </>
          )
        }
      >
        {newKey ? (
          <CopyField value={newKey} />
        ) : (
          <div className="space-y-4">
            <Field label="Name">
              <Input
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="CRM integration"
              />
            </Field>
            <Field label="Scope">
              <Select value={scopes} onChange={(e) => setScopes(e.target.value)}>
                <option value="read">Read only — calls, analytics, documents</option>
                <option value="read,write">Read and write — also index documents</option>
                <option value="read,write,admin">Full access</option>
              </Select>
            </Field>
          </div>
        )}
      </Modal>

      {/* webhook */}
      <Modal
        open={hookOpen}
        onClose={() => setHookOpen(false)}
        title="Add a webhook"
        description="We POST a signed JSON payload. Verify the signature with the secret shown afterwards."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setHookOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const res = await saveWebhookAction(hookUrl, hookEvents);
                setBusy(false);
                if (res.ok) {
                  toast.success('Registered', res.message);
                  setHookOpen(false);
                  setHookUrl('');
                  refresh();
                } else toast.error('Could not register', res.message);
              }}
            >
              Register
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Endpoint URL" hint="Must be HTTPS.">
            <Input
              value={hookUrl}
              onChange={(e) => setHookUrl(e.target.value)}
              placeholder="https://crm.yourcompany.uz/hooks/ovoz"
            />
          </Field>
          <Field label="Event">
            <Select value={hookEvents} onChange={(e) => setHookEvents(e.target.value)}>
              {WEBHOOK_EVENTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
              <option value={WEBHOOK_EVENTS.join(',')}>All events</option>
            </Select>
          </Field>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(confirmKey)}
        onClose={() => setConfirmKey(null)}
        danger
        confirmLabel="Revoke"
        title={`Revoke “${confirmKey?.name ?? ''}”?`}
        description="Any integration using this key stops working immediately."
        onConfirm={async () => {
          if (!confirmKey) return;
          await revokeApiKeyAction(confirmKey.id);
          toast.success('Revoked');
          refresh();
        }}
      />
    </div>
  );
}
