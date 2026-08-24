import {
  Badge,
  Button,
  Card,
  ConfirmModal,
  EmptyState,
  Input,
  Label,
  Modal,
  Select,
  Spinner,
  roleTone,
} from "../components/ui";
import { apiGet, apiSend, InvitationView, MemberView } from "../lib/api";
import { fmtDate } from "../lib/format";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Award, MailPlus, UserMinus, Users } from "lucide-react";
import { useState } from "react";

export function TeamPage() {
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    tone?: "danger" | "warning" | "primary";
    action: () => void;
  } | null>(null);

  const membersQuery = useQuery({
    queryKey: ["team-members"],
    queryFn: () => apiGet<{ members: MemberView[] }>("/api/team/members"),
  });
  const invitesQuery = useQuery({
    queryKey: ["team-invitations"],
    queryFn: () =>
      apiGet<{ invitations: InvitationView[] }>("/api/team/invitations"),
  });

  const self = membersQuery.data?.members.find((m) => m.self);
  const isAdmin = self?.role === "owner" || self?.role === "admin";
  const isOwner = self?.role === "owner";

  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: string }) =>
      apiSend("PATCH", `/api/team/members/${id}/role`, { role }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-members"] }),
    onError: (e: Error) => setNotice(e.message),
  });

  const removeMember = useMutation({
    mutationFn: (id: string) => apiSend("DELETE", `/api/team/members/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
    },
    onError: (e: Error) => setNotice(e.message),
  });

  const cancelInvite = useMutation({
    mutationFn: (id: string) =>
      apiSend("POST", `/api/team/invitations/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["team-invitations"] }),
    onError: (e: Error) => setNotice(e.message),
  });

  const transfer = useMutation({
    mutationFn: (memberId: string) =>
      apiSend("POST", "/api/team/transfer-ownership", { memberId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      setNotice("Ownership transferred.");
    },
    onError: (e: Error) => setNotice(e.message),
  });

  if (membersQuery.isLoading || invitesQuery.isLoading)
    return <Spinner label="Loading team…" />;
  if (membersQuery.error || invitesQuery.error)
    return (
      <EmptyState
        title="Could not load team"
        description={(membersQuery.error || invitesQuery.error)?.message}
      />
    );

  const members = membersQuery.data!.members;
  const invitations = invitesQuery.data!.invitations.filter(
    (i) => i.status === "pending",
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Team</h1>
          <p className="text-sm text-gray-500">
            People with access to this workspace.
          </p>
        </div>
        {isAdmin && (
          <Button onClick={() => setInviting(true)}>
            <MailPlus size={15} /> Invite member
          </Button>
        )}
      </div>

      {notice && (
        <div className="rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800">
          {notice}
        </div>
      )}

      <Card
        title={`Members (${members.length})`}
        subtitle="Roles control who can manage this workspace."
      >
        {members.length === 0 ? (
          <EmptyState icon={<Users size={36} />} title="No members" />
        ) : (
          <div className="-m-5">
            <ul className="divide-y divide-gray-50">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gray-200 text-sm font-semibold text-gray-600">
                    {(m.name || m.email)[0]?.toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {m.name}
                      {m.self && (
                        <span className="ml-1 text-xs font-normal text-gray-400">
                          (you)
                        </span>
                      )}
                    </p>
                    <p className="truncate text-xs text-gray-500">{m.email}</p>
                  </div>
                  {isAdmin && !m.self && (
                    <Select
                      value={m.role}
                      disabled={setRole.isPending}
                      onChange={(v) => {
                        if (m.role === "owner" && !isOwner) {
                          setNotice(
                            "Only the owner can change an owner's role.",
                          );
                          return;
                        }
                        setConfirmAction({
                          title: "Change member role?",
                          message: `Are you sure you want to change ${m.name}'s role from ${m.role} to ${v}?`,
                          confirmLabel: "Change Role",
                          tone: "primary",
                          action: () => setRole.mutate({ id: m.id, role: v as string }),
                        });
                      }}
                      options={["owner", "admin", "member", "viewer"].map(
                        (r) => ({
                          value: r,
                          label: r,
                          disabled: r === "owner" && m.role === "owner",
                        }),
                      )}
                    />
                  )}
                  {!isAdmin && <Badge tone={roleTone(m.role)}>{m.role}</Badge>}
                  {isOwner && m.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setConfirmAction({
                          title: "Transfer workspace ownership?",
                          message: `Are you sure you want to transfer ownership to ${m.name}? You will become an admin and will no longer have exclusive owner privileges.`,
                          confirmLabel: "Transfer Ownership",
                          tone: "warning",
                          action: () => transfer.mutate(m.id),
                        });
                      }}
                    >
                      <Award size={13} /> Make owner
                    </Button>
                  )}
                  {isAdmin && !m.self && m.role !== "owner" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmAction({
                          title: `Remove ${m.name}?`,
                          message: `Are you sure you want to remove ${m.name} from this workspace? They will lose access to all resources immediately.`,
                          confirmLabel: "Remove Member",
                          tone: "danger",
                          action: () => removeMember.mutate(m.id),
                        });
                      }}
                    >
                      <UserMinus size={13} className="text-red-500" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      {invitations.length > 0 && (
        <Card title={`Pending invitations (${invitations.length})`}>
          <div className="-m-5">
            <ul className="divide-y divide-gray-50">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-gray-800">
                      {inv.email}
                    </p>
                    <p className="text-xs text-gray-500">
                      {inv.role} ·{" "}
                      {inv.expired ? "expired" : "awaiting response"}
                    </p>
                  </div>
                  <Badge tone={inv.expired ? "red" : "amber"}>
                    {inv.expired ? "Expired" : "Pending"}
                  </Badge>
                  {isAdmin && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setConfirmAction({
                          title: "Cancel invitation?",
                          message: `Are you sure you want to cancel the pending invitation to ${inv.email}?`,
                          confirmLabel: "Cancel Invitation",
                          tone: "danger",
                          action: () => cancelInvite.mutate(inv.id),
                        });
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Card>
      )}

      {inviting && (
        <InviteModal
          onClose={() => setInviting(false)}
          onInvited={() => {
            setInviting(false);
            qc.invalidateQueries({ queryKey: ["team-invitations"] });
          }}
          onError={(msg) => setNotice(msg)}
          defaultEmail=""
        />
      )}

      <ConfirmModal
        open={confirmAction != null}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (confirmAction) {
            confirmAction.action();
            setConfirmAction(null);
          }
        }}
        title={confirmAction?.title ?? "Confirm Action"}
        confirmLabel={confirmAction?.confirmLabel ?? "Confirm"}
        tone={confirmAction?.tone ?? "danger"}
        message={<p>{confirmAction?.message}</p>}
      />
    </div>
  );
}

function InviteModal({
  onClose,
  onInvited,
  onError,
  defaultEmail,
}: {
  onClose: () => void;
  onInvited: () => void;
  onError: (msg: string) => void;
  defaultEmail: string;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [role, setRole] = useState("member");
  const [sending, setSending] = useState(false);

  const submit = async () => {
    setSending(true);
    try {
      await apiSend("POST", "/api/team/invitations", {
        email: email.trim(),
        role,
      });
      onInvited();
    } catch (err) {
      onError((err as Error).message);
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Invite a member"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={sending}>
            Send invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label>Email address</Label>
          <Input
            type="email"
            placeholder="teammate@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div>
          <Label>Role</Label>
          <Select
            value={role}
            onChange={(v) => setRole(v as string)}
            options={[
              {
                value: "member",
                label: "Member — can use the API and view analytics",
              },
              {
                value: "admin",
                label: "Admin — can also manage providers, keys, team",
              },
              { value: "viewer", label: "Viewer — read-only access" },
            ]}
          />
        </div>
      </div>
    </Modal>
  );
}
