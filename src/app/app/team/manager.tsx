'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { changeRoleAction, inviteMemberAction, setMemberStatusAction } from '@/app/actions/ops';
import { ROLE_LABEL } from '@/lib/catalog';
import type { Role, SafeUser } from '@/lib/types';
import { relativeTime } from '@/lib/utils';
import { Avatar, Badge, Button, Card, PageHeader } from '@/components/ui/primitives';
import { Field, Input, Select } from '@/components/ui/forms';
import { Menu, Modal, useToast } from '@/components/ui/overlays';
import { IconMore, IconPlus, IconShield, IconUsers } from '@/components/icons';

type Member = SafeUser & { handled: number };

const ROLE_HINT: Record<Role, string> = {
  owner: 'Everything, including billing and closing the account.',
  admin: 'Configure the agent, knowledge base, numbers and team.',
  operator: 'Take escalated calls and see call history.',
  analyst: 'Read-only access to analytics and call records.',
};

export function TeamManager({
  members,
  audit,
  currentUserId,
  canEdit,
}: {
  members: Member[];
  audit: Array<{ id: string; actor_name: string | null; action: string; target: string | null; created_at: string }>;
  currentUserId: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  const [inviting, setInviting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'operator' as Role, password: '' });

  const refresh = () => start(() => router.refresh());

  return (
    <div className="mx-auto max-w-[1100px]">
      <PageHeader
        title="Team"
        subtitle="Who can see and change what. Operators are the people who pick up escalated calls."
        actions={
          canEdit ? (
            <Button variant="primary" icon={<IconPlus size={15} />} onClick={() => setInviting(true)}>
              Add a person
            </Button>
          ) : undefined
        }
      />

      <Card padded={false}>
        <div className="divide-y divide-[rgb(var(--line)/var(--line-alpha))]">
          {members.map((m) => (
            <div key={m.id} className="flex flex-wrap items-center gap-3 px-5 py-4">
              <Avatar
                name={m.name}
                hue={m.avatar_hue}
                size={38}
                presence={m.presence as 'online' | 'away' | 'offline'}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-medium text-ink">{m.name}</span>
                  {m.id === currentUserId && <Badge tone="brand">You</Badge>}
                  {m.status === 'disabled' && <Badge tone="danger">Disabled</Badge>}
                </div>
                <p className="mt-0.5 truncate text-[12.5px] text-ink-3">
                  {m.email}
                  {m.handled > 0 && ` · ${m.handled} calls handled`}
                  {m.last_seen_at && ` · last seen ${relativeTime(m.last_seen_at)}`}
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <Badge tone={m.role === 'owner' ? 'violet' : 'neutral'}>{ROLE_LABEL[m.role]}</Badge>
                {canEdit && m.id !== currentUserId && (
                  <Menu
                    width={200}
                    trigger={({ toggle }) => (
                      <Button size="xs" variant="ghost" onClick={toggle} aria-label="Member actions">
                        <IconMore size={16} />
                      </Button>
                    )}
                    items={[
                      ...(['admin', 'operator', 'analyst'] as Role[]).map((r) => ({
                        label: `Make ${ROLE_LABEL[r].toLowerCase()}`,
                        disabled: m.role === r,
                        onClick: async () => {
                          const res = await changeRoleAction(m.id, r);
                          if (res.ok) toast.success(res.message);
                          else toast.error(res.message);
                          refresh();
                        },
                      })),
                      { type: 'separator' as const },
                      {
                        label: m.status === 'disabled' ? 'Restore access' : 'Revoke access',
                        danger: m.status !== 'disabled',
                        onClick: async () => {
                          const res = await setMemberStatusAction(
                            m.id,
                            m.status === 'disabled' ? 'active' : 'disabled',
                          );
                          if (res.ok) toast.success(res.message);
                          else toast.error(res.message);
                          refresh();
                        },
                      },
                    ]}
                  />
                )}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <IconUsers size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">What each role can do</h3>
          </div>
          <div className="space-y-2.5">
            {(Object.keys(ROLE_HINT) as Role[]).map((r) => (
              <div key={r} className="flex gap-3">
                <Badge tone={r === 'owner' ? 'violet' : 'neutral'} className="mt-0.5 shrink-0">
                  {ROLE_LABEL[r]}
                </Badge>
                <p className="text-[12.5px] leading-relaxed text-ink-2">{ROLE_HINT[r]}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card padded={false}>
          <div className="flex items-center gap-2 px-5 py-4 hairline-b">
            <IconShield size={16} className="text-ink-3" />
            <h3 className="text-[14px] font-semibold text-ink">Audit log</h3>
          </div>
          <div className="max-h-[320px] divide-y divide-[rgb(var(--line)/var(--line-alpha))] overflow-y-auto">
            {audit.map((a) => (
              <div key={a.id} className="flex items-baseline gap-2 px-5 py-2.5 text-[12.5px]">
                <span className="font-medium text-ink">{a.actor_name ?? 'system'}</span>
                <span className="text-ink-2">{a.action.replace(/[._]/g, ' ')}</span>
                <span className="ml-auto shrink-0 text-[11.5px] text-ink-3">
                  {relativeTime(a.created_at)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Modal
        open={inviting}
        onClose={() => setInviting(false)}
        title="Add someone to the team"
        description="They can sign in immediately with the password you set here."
        footer={
          <>
            <Button size="sm" variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                const res = await inviteMemberAction(form);
                setBusy(false);
                if (res.ok) {
                  toast.success('Added', res.message);
                  setInviting(false);
                  setForm({ name: '', email: '', role: 'operator', password: '' });
                  refresh();
                } else toast.error('Could not add', res.message);
              }}
            >
              Add
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Role" hint={ROLE_HINT[form.role]}>
            <Select
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value as Role })}
            >
              <option value="admin">Admin</option>
              <option value="operator">Operator</option>
              <option value="analyst">Analyst</option>
            </Select>
          </Field>
          <Field label="Temporary password" hint="At least 8 characters. Ask them to change it after signing in.">
            <Input
              type="text"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </Field>
        </div>
      </Modal>
    </div>
  );
}
