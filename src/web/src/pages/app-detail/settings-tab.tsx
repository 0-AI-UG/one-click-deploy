import { post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, Field, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { Pencil, Lock, Settings as SettingsIcon, HardDrive, Globe, Cpu, Network } from "lucide-react";
import { InfoTip } from "./shared.tsx";
import type { AppData } from "../../types.ts";

export type IngressForm = {
  sticky: boolean;
  rate_limit_rps: number;
  ip_allowlist: string;
  health_check_path: string;
  compress: boolean;
  /** "off" = not raw-exposed; otherwise the pool protocol. */
  public_protocol: "off" | "tcp" | "udp";
  /** Requested public port; "" = auto-assign. */
  public_port: string;
  /** Whether HTTP basic auth is on. Backed by app.auth_enabled (the password
   *  itself is write-only — the server never sends it back). */
  auth_enabled: boolean;
  /** Write-only new password. Blank while enabled = keep the current password. */
  auth_password: string;
  /** Internal routing protocol: 'http' (L7) or 'tcp' (raw pass-through). */
  internal_protocol: "http" | "tcp";
};

const PUBLIC_PORT_RANGES = { tcp: "30000–30049", udp: "30050–30099" } as const;

interface SettingsTabProps {
  app: AppData;
  appId: number;
  nameEdit: string;
  setNameEdit: (v: string) => void;
  isPublic: boolean;
  setIsPublic: (v: boolean) => void;
  portEdit: number;
  setPortEdit: (v: number) => void;
  memEdit: number;
  setMemEdit: (v: number) => void;
  volumeForm: { size: number; mount_path: string };
  setVolumeForm: (f: { size: number; mount_path: string }) => void;
  ingressForm: IngressForm;
  setIngressForm: (f: IngressForm) => void;
  actionLoading: string | null;
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
  ops: ResourceOpsResult;
}

export function SettingsTab({
  app, appId,
  nameEdit, setNameEdit,
  isPublic, setIsPublic,
  portEdit, setPortEdit,
  memEdit, setMemEdit,
  volumeForm, setVolumeForm,
  ingressForm, setIngressForm,
  actionLoading, action, ops,
}: SettingsTabProps) {
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <Field label={<span className="flex items-center gap-2"><Pencil size={14} className="text-fg" /> App Name</span>}>
          <div className="flex gap-2 items-center">
            <input
              type="text"
              value={nameEdit}
              onChange={(e) => setNameEdit(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
              placeholder={app.name}
            />
            <PermissionGate permission="apps.deploy">
              <Btn
                size="sm"
                variant="primary"
                loading={actionLoading === "rename"}
                disabled={!nameEdit || nameEdit === app.name}
                onClick={() => action("rename", async () => {
                  await put(`/api/apps/${appId}/rename`, { name: nameEdit });
                })}
              >Rename</Btn>
            </PermissionGate>
          </div>
        </Field>

        <Field
          label={<span className="flex items-center gap-2"><Globe size={14} className="text-fg" /> Public Access</span>}
          hint={!isPublic ? "App will only be reachable over the internal network" : undefined}
        >
          <div className="flex justify-end">
            <Checkbox checked={isPublic} onChange={setIsPublic} label="Expose via public domain" />
          </div>
        </Field>

        <Field label={<span className="flex items-center gap-2"><SettingsIcon size={14} className="text-fg" /> Container Port</span>}>
          <input
            type="number"
            min={1}
            max={65535}
            value={portEdit || ""}
            onChange={(e) => setPortEdit(parseInt(e.target.value) || 0)}
            placeholder="3000"
          />
        </Field>

        <Field label={<span className="flex items-center gap-2"><Cpu size={14} className="text-fg" /> Memory Limit (MB) <InfoTip text="Container memory ceiling. 0 or blank uses the platform default (512 MB). Applied on save & redeploy." /></span>}>
          <input
            type="number"
            min={0}
            value={memEdit || ""}
            onChange={(e) => setMemEdit(parseInt(e.target.value) || 0)}
            placeholder="512 (platform default)"
          />
        </Field>
      </Card>

      <PermissionGate permission="apps.redeploy">
        <div className="flex justify-end">
          <Btn
            size="sm"
            variant="primary"
            loading={actionLoading === "save-settings" || ops.isBusyWith("redeploy")}
            disabled={!portEdit || ops.isBusy}
            onClick={() => action("save-settings", async () => {
              const res = (await post(`/api/apps/${appId}/redeploy`, {
                container_port: portEdit,
                public: isPublic,
                memory_mb: memEdit,
              })) as { op_id?: number };
              if (res?.op_id) {
                trackOperationInToast(res.op_id, "Saving & redeploying");
                ops.track(res.op_id);
              }
            })}
          >Save & Redeploy</Btn>
        </div>
      </PermissionGate>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Network size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Ingress</h3>
          <InfoTip text="Applied to the proxy config immediately on save — no rebuild or redeploy." />
        </div>

        <Field
          label={<span className="flex items-center gap-2"><Network size={14} className="text-fg" /> Internal Protocol <InfoTip text="How Traefik routes internal traffic on <app>.ocd.internal. HTTP = L7 routing (required for password protection and an active health-check path). TCP = raw pass-through for non-HTTP protocols. The OCD_INTERNAL_URL scheme refreshes on the next redeploy." /></span>}
        >
          <select
            value={ingressForm.internal_protocol}
            onChange={(e) => setIngressForm({ ...ingressForm, internal_protocol: e.target.value as IngressForm["internal_protocol"] })}
          >
            <option value="http">HTTP (L7 routing)</option>
            <option value="tcp">TCP (raw pass-through)</option>
          </select>
        </Field>

        <Field
          label={<span className="flex items-center gap-2"><Lock size={14} className="text-fg" /> Password Protection</span>}
          hint={ingressForm.internal_protocol === "tcp"
            ? "Requires HTTP internal routing — switch Internal Protocol to HTTP."
            : ingressForm.auth_enabled
              ? 'HTTP basic auth — visitors sign in with username "admin". Leave the field blank to keep the current password.'
              : "Gates the app behind HTTP basic auth."}
        >
          <div className="space-y-2">
            <div className="flex justify-end">
              <Checkbox
                checked={ingressForm.auth_enabled}
                disabled={ingressForm.internal_protocol === "tcp"}
                onChange={(v) => setIngressForm({ ...ingressForm, auth_enabled: v, auth_password: v ? ingressForm.auth_password : "" })}
                label="Require a password"
              />
            </div>
            {ingressForm.auth_enabled && (
              <input
                type="password"
                value={ingressForm.auth_password}
                onChange={(e) => setIngressForm({ ...ingressForm, auth_password: e.target.value })}
                placeholder={app.auth_enabled ? "(unchanged)" : "New password"}
              />
            )}
          </div>
        </Field>

        <Field
          label={<span className="flex items-center gap-2">Rate Limit</span>}
          hint="requests/sec on the public domain, 0 = unlimited"
        >
          <input
            type="number"
            min={0}
            value={ingressForm.rate_limit_rps || ""}
            onChange={(e) => setIngressForm({ ...ingressForm, rate_limit_rps: parseInt(e.target.value) || 0 })}
            placeholder="0 (unlimited)"
          />
        </Field>

        <Field
          label={<span className="flex items-center gap-2">IP Allowlist</span>}
          hint={ingressForm.ip_allowlist ? "only these IPs/CIDRs can reach the public domain" : undefined}
        >
          <input
            type="text"
            value={ingressForm.ip_allowlist}
            onChange={(e) => setIngressForm({ ...ingressForm, ip_allowlist: e.target.value })}
            placeholder="comma-separated IPs or CIDRs"
          />
        </Field>

        <Field
          label={<span className="flex items-center gap-2">Health Check Path <InfoTip text="Active HTTP health check — replicas failing this path leave rotation within seconds. Requires HTTP internal routing." /></span>}
        >
          <input
            type="text"
            value={ingressForm.health_check_path}
            onChange={(e) => setIngressForm({ ...ingressForm, health_check_path: e.target.value })}
            placeholder="/healthz"
            disabled={ingressForm.internal_protocol === "tcp"}
          />
        </Field>

        <Field label={<span className="flex items-center gap-2">Sticky Sessions</span>}>
          <div className="flex justify-end">
            <Checkbox
              checked={ingressForm.sticky}
              onChange={(v) => setIngressForm({ ...ingressForm, sticky: v })}
              label="Pin visitors to one replica"
            />
          </div>
        </Field>

        <Field label={<span className="flex items-center gap-2">Compression</span>}>
          <div className="flex justify-end">
            <Checkbox
              checked={ingressForm.compress}
              onChange={(v) => setIngressForm({ ...ingressForm, compress: v })}
              label="Compress responses on the public domain"
            />
          </div>
        </Field>

        <Field
          label={<span className="flex items-center gap-2">Public TCP/UDP Port <InfoTip text="Forwards a dedicated public port on the panel IP raw to the app's replicas — for game servers, databases, MQTT. Independent of the public domain. Blank port = auto-assign." /></span>}
          hint={app.public_address
            ? `reachable at ${app.public_address} (${(app.public_protocol || "tcp").toUpperCase()})`
            : ingressForm.public_protocol !== "off"
              ? `pool ${PUBLIC_PORT_RANGES[ingressForm.public_protocol]}`
              : undefined}
        >
          <div className="flex gap-2">
            <select
              value={ingressForm.public_protocol}
              onChange={(e) => setIngressForm({ ...ingressForm, public_protocol: e.target.value as IngressForm["public_protocol"] })}
            >
              <option value="off">Off</option>
              <option value="tcp">TCP</option>
              <option value="udp">UDP</option>
            </select>
            {ingressForm.public_protocol !== "off" && (
              <input
                type="number"
                value={ingressForm.public_port}
                onChange={(e) => setIngressForm({ ...ingressForm, public_port: e.target.value })}
                placeholder="auto"
              />
            )}
          </div>
        </Field>

        <PermissionGate permission="apps.redeploy">
          <div className="flex justify-end mt-3">
            <Btn
              size="sm"
              variant="primary"
              loading={actionLoading === "save-ingress"}
              onClick={() => action("save-ingress", async () => {
                // Password is write-only. Disabled → clear ("").  Enabled with a
                // typed value → set it. Enabled but blank → omit (keep current).
                const authField = !ingressForm.auth_enabled
                  ? { auth_password: "" }
                  : ingressForm.auth_password
                    ? { auth_password: ingressForm.auth_password }
                    : {};
                await put(`/api/apps/${appId}/ingress`, {
                  ...authField,
                  internal_protocol: ingressForm.internal_protocol,
                  sticky: ingressForm.sticky,
                  rate_limit_rps: ingressForm.rate_limit_rps,
                  ip_allowlist: ingressForm.ip_allowlist,
                  health_check_path: ingressForm.health_check_path,
                  compress: ingressForm.compress,
                  public_port: ingressForm.public_protocol === "off"
                    ? null
                    : (parseInt(ingressForm.public_port, 10) || "auto"),
                  ...(ingressForm.public_protocol !== "off" ? { public_protocol: ingressForm.public_protocol } : {}),
                });
              })}
            >Save Ingress</Btn>
          </div>
        </PermissionGate>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <HardDrive size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Persistent Volume</h3>
        </div>
        {app.volume_id ? (
          <>
            <div className="space-y-1 text-[10px] font-mono mb-3">
              <div className="flex justify-between"><span className="text-muted">Volume ID</span><span className="text-fg">{app.volume_id}</span></div>
              <div className="flex justify-between"><span className="text-muted">Mount</span><span className="text-fg">{app.volume_mount}</span></div>
            </div>
            <div className="flex items-center gap-1 mb-3">
              <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Detach Volume</span>
              <InfoTip text="Detaching keeps the volume in Hetzner but unmounts it from this app. The container will be recreated." />
            </div>
            <PermissionGate permission="volumes.manage">
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="danger"
                  loading={actionLoading === "detach-vol"}
                  onClick={async () => {
                    if (await confirm("Detach Volume", "Detach this volume? Data is preserved on the volume itself.", true)) {
                      await action("detach-vol", () => post(`/api/volumes/detach`, { app_id: appId }));
                    }
                  }}
                >Detach Volume</Btn>
              </div>
            </PermissionGate>
          </>
        ) : (
          <>
            <div className="flex items-center gap-1 mb-3">
              <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-fg">Attach Volume</span>
              <InfoTip text="Attach a new persistent volume. The container will be recreated with the volume mounted." />
            </div>
            <div>
              <Field label="Size (GB)">
                <input
                  type="number"
                  min={10}
                  value={volumeForm.size}
                  onChange={(e) => setVolumeForm({ ...volumeForm, size: parseInt(e.target.value) || 10 })}
                />
              </Field>
              <Field label="Mount Path">
                <input
                  type="text"
                  value={volumeForm.mount_path}
                  onChange={(e) => setVolumeForm({ ...volumeForm, mount_path: e.target.value })}
                  placeholder="/data"
                />
              </Field>
            </div>
            <PermissionGate permission="volumes.create">
              <div className="flex justify-end mt-3">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "attach-vol"}
                  onClick={() => action("attach-vol", () => post(`/api/volumes/attach`, {
                    app_id: appId,
                    size: volumeForm.size,
                    mount_path: volumeForm.mount_path || "/data",
                  }))}
                >Attach Volume</Btn>
              </div>
            </PermissionGate>
          </>
        )}
      </Card>
    </div>
  );
}
