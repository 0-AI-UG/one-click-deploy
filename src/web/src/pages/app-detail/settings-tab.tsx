import { post, put } from "../../api/client.ts";
import { Card, Btn, Checkbox, Field, confirm } from "../../components/ui.tsx";
import { NeoSelect } from "../../components/neo-select.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { trackOperationInToast, type ResourceOpsResult } from "../../hooks/useOperation.ts";
import { Pencil, Lock, Settings as SettingsIcon, HardDrive, Globe, Cpu, Network } from "lucide-react";
import { HealthCheckField, InfoTip } from "./shared.tsx";
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
  /** Post-deploy HTTP probe on/off. L7-only; applies on the next (re)deploy/scale. */
  health_check: boolean;
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
  cpuEdit: number;
  setCpuEdit: (v: number) => void;
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
  cpuEdit, setCpuEdit,
  volumeForm, setVolumeForm,
  ingressForm, setIngressForm,
  actionLoading, action, ops,
}: SettingsTabProps) {
  // Password, active health-check paths and cookie sticky sessions are HTTP/L7
  // concepts; raw-TCP internal routing can't carry them, so they only render
  // when the internal protocol is HTTP.
  const httpRouted = ingressForm.internal_protocol === "http";
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
            <PermissionGate permission="apps.rename" appId={appId} environmentId={app.environment_id}>
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
          label={<span className="flex items-center gap-2"><Globe size={14} className="text-fg" /> Public Domain <InfoTip text="Serve the app on a public HTTPS domain. Off = internal network only. (The public TCP/UDP port is separate.)" /></span>}
          hint={!isPublic ? "No public domain; the app's HTTP is internal-only" : undefined}
        >
          <div className="flex justify-start">
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

        <Field label={<span className="flex items-center gap-2"><HardDrive size={14} className="text-fg" /> Memory Limit (MB) <InfoTip text="Container memory cap. Blank/0 = default (512 MB)." /></span>}>
          <input
            type="number"
            min={0}
            value={memEdit || ""}
            onChange={(e) => setMemEdit(parseInt(e.target.value) || 0)}
            placeholder="512 (platform default)"
          />
        </Field>

        <Field label={<span className="flex items-center gap-2"><Cpu size={14} className="text-fg" /> CPU Limit (cores) <InfoTip text="Container CPU cap in cores (fractional ok, e.g. 0.5). Blank/0 = default (1)." /></span>}>
          <input
            type="number"
            min={0}
            step={0.1}
            value={cpuEdit || ""}
            onChange={(e) => setCpuEdit(parseFloat(e.target.value) || 0)}
            placeholder="1 (platform default)"
          />
        </Field>

        <PermissionGate permission="apps.redeploy" appId={appId} environmentId={app.environment_id}>
          <div className="flex justify-end mt-3">
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
                  cpu_limit: cpuEdit,
                })) as { op_id?: number };
                if (res?.op_id) {
                  trackOperationInToast(res.op_id, "Saving & redeploying");
                  ops.track(res.op_id);
                }
              })}
            >Save & Redeploy</Btn>
          </div>
        </PermissionGate>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Network size={14} className="text-fg" />
          <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Ingress</h3>
          <InfoTip text="Applied to the proxy config immediately on save; no rebuild or redeploy." />
        </div>

        <Field
          label={<span className="flex items-center gap-2"><Network size={14} className="text-fg" /> Internal Protocol <InfoTip text="How Traefik reaches the app internally. HTTP enables passwords, health paths and sticky sessions; TCP is a raw pass-through for non-HTTP services (Postgres, Redis, game servers)." /></span>}
        >
          <NeoSelect
            value={ingressForm.internal_protocol}
            onChange={(v) => {
              const internal_protocol = v as IngressForm["internal_protocol"];
              // Password, an active health-check path, cookie sticky sessions and
              // the post-deploy HTTP probe are L7-only; clear them when dropping to
              // raw TCP so we never save a combination the ingress endpoint rejects
              // (a raw-TCP app can't answer an HTTP probe). Restore the default
              // probe when returning to HTTP routing.
              setIngressForm(internal_protocol === "tcp"
                ? { ...ingressForm, internal_protocol, auth_enabled: false, auth_password: "", sticky: false, health_check_path: "", health_check: false }
                : { ...ingressForm, internal_protocol, health_check: true });
            }}
            options={[
              { value: "http", label: "HTTP (L7 routing)" },
              { value: "tcp", label: "TCP (raw pass-through)" },
            ]}
          />
        </Field>

        {/* HTTP/L7-only settings live directly under the protocol select; they
            disappear entirely on raw-TCP routing rather than sitting disabled. */}
        {httpRouted && (
          <>
            <Field
              label={<span className="flex items-center gap-2"><Lock size={14} className="text-fg" /> Password Protection <InfoTip text='HTTP basic auth at the ingress (username: admin). HTTP routing only.' /></span>}
              hint={ingressForm.auth_enabled
                ? 'HTTP basic auth. Visitors sign in with username "admin". Leave the field blank to keep the current password.'
                : "Gates the app behind HTTP basic auth."}
            >
              <div className="space-y-2">
                <div className="flex justify-start">
                  <Checkbox
                    checked={ingressForm.auth_enabled}
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

            <HealthCheckField
              enabled={ingressForm.health_check}
              path={ingressForm.health_check_path}
              onChange={(next) => setIngressForm({ ...ingressForm, ...next })}
            />

            <Field
              label={<span className="flex items-center gap-2">Sticky Sessions <InfoTip text="Keep each visitor on the same replica via a cookie. HTTP routing only." /></span>}
            >
              <div className="flex justify-start">
                <Checkbox
                  checked={ingressForm.sticky}
                  onChange={(v) => setIngressForm({ ...ingressForm, sticky: v })}
                  label="Pin visitors to one replica"
                />
              </div>
            </Field>
          </>
        )}

        {/* Public-domain-only middleware: the rate limiter, allowlist and gzip
            all run on the public L7 router, so they no-op until the app is
            exposed via a public domain. Hide them until then rather than
            showing controls that silently do nothing. */}
        {app.public && (
          <>
            <Field
              label={<span className="flex items-center gap-2">Rate Limit <InfoTip text="Max requests/sec per client IP on the public domain. 0 = unlimited." /></span>}
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
              label={<span className="flex items-center gap-2">IP Allowlist <InfoTip text="Only these IPs/CIDRs may reach the public domain. Blank = open to all." /></span>}
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
              label={<span className="flex items-center gap-2">Compression <InfoTip text="gzip responses on the public domain." /></span>}
            >
              <div className="flex justify-start">
                <Checkbox
                  checked={ingressForm.compress}
                  onChange={(v) => setIngressForm({ ...ingressForm, compress: v })}
                  label="Compress responses on the public domain"
                />
              </div>
            </Field>
          </>
        )}

        {/* Publishing a raw public port is strictly more dangerous than the rest
            of ingress, so it carries its own grant. */}
        <PermissionGate permission="apps.expose" appId={appId} environmentId={app.environment_id}>
        <Field
          label={<span className="flex items-center gap-2">Public TCP/UDP Port <InfoTip text="A raw public port straight to the app (game servers, databases, MQTT). Separate from the public domain. Blank = auto-assign." /></span>}
          hint={app.public_address
            ? `reachable at ${app.public_address} (${(app.public_protocol || "tcp").toUpperCase()})`
            : ingressForm.public_protocol !== "off"
              ? `pool ${PUBLIC_PORT_RANGES[ingressForm.public_protocol]}`
              : undefined}
        >
          <div className="flex gap-2">
            <div className={ingressForm.public_protocol !== "off" ? "w-24 flex-shrink-0" : "flex-1"}>
              <NeoSelect
                value={ingressForm.public_protocol}
                onChange={(v) => setIngressForm({ ...ingressForm, public_protocol: v as IngressForm["public_protocol"] })}
                options={[
                  { value: "off", label: "Off" },
                  { value: "tcp", label: "TCP" },
                  { value: "udp", label: "UDP" },
                ]}
              />
            </div>
            {ingressForm.public_protocol !== "off" && (
              <input
                type="number"
                className="flex-1"
                value={ingressForm.public_port}
                onChange={(e) => setIngressForm({ ...ingressForm, public_port: e.target.value })}
                placeholder="auto"
              />
            )}
          </div>
        </Field>
        </PermissionGate>

        <PermissionGate permission="apps.ingress" appId={appId} environmentId={app.environment_id}>
          <div className="flex justify-end mt-3">
            <Btn
              size="sm"
              variant="primary"
              loading={actionLoading === "save-ingress"}
              disabled={ops.isBusy}
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
                  health_check: ingressForm.health_check,
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
            <PermissionGate permission="volumes.detach">
              <div className="flex justify-end">
                <Btn
                  size="sm"
                  variant="danger"
                  loading={actionLoading === "detach-vol"}
                  onClick={async () => {
                    if (await confirm("Detach Volume", "Detach this volume? Data is preserved on the volume itself.", true)) {
                      await action("detach-vol", async () => {
                        const res = (await post(`/api/volumes/detach`, { app_id: appId })) as { op_id?: number };
                        if (res?.op_id) {
                          trackOperationInToast(res.op_id, "Detaching volume");
                          ops.track(res.op_id);
                        }
                      });
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
            <PermissionGate permission="volumes.attach">
              <div className="flex justify-end mt-3">
                <Btn
                  size="sm"
                  variant="primary"
                  loading={actionLoading === "attach-vol"}
                  onClick={() => action("attach-vol", async () => {
                    const res = (await post(`/api/volumes/attach`, {
                      app_id: appId,
                      size: volumeForm.size,
                      mount_path: volumeForm.mount_path || "/data",
                    })) as { op_id?: number };
                    if (res?.op_id) {
                      trackOperationInToast(res.op_id, "Attaching volume");
                      ops.track(res.op_id);
                    }
                  })}
                >Attach Volume</Btn>
              </div>
            </PermissionGate>
          </>
        )}
      </Card>
    </div>
  );
}
