import { useState, useEffect } from "react";
import { request } from "../rpc.ts";
import type { App, ServerWithApps } from "../../shared/rpc.ts";
import { useConfirmAction } from "../hooks.ts";
import { NeoSelect } from "./neo-select.tsx";

type ResourceData = {
  servers: Array<{
    id: number;
    name: string;
    hetzner_id: string;
    ipv4: string;
    type: string;
    location: string;
    status: string;
    app_count: number;
    replica_count: number;
  }>;
  load_balancers: Array<{
    id: string;
    name: string;
    ipv4: string;
    type: string;
    location: string;
    app_name: string;
    targets: number;
  }>;
  volumes: Array<{
    id: string;
    name: string;
    size: number;
    server_name: string;
    app_name: string;
    location: string;
    app_id: number;
  }>;
};


export function ResourcesView({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<ResourceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [allApps, setAllApps] = useState<Array<App & { server_location: string }>>([]);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [result, serversWithApps] = await Promise.all([
        request.getResources({}),
        request.getServers({}),
      ]);
      setData(result as ResourceData);
      // Flatten apps with their server location for volume attach/reattach
      const apps: Array<App & { server_location: string }> = [];
      for (const s of serversWithApps as ServerWithApps[]) {
        for (const a of s.apps) {
          apps.push({ ...a, server_location: s.location });
        }
      }
      setAllApps(apps);
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) {
    return (
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div className="stamp" style={{ marginBottom: 8 }}>Resources</div>
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div className="spin" style={{ width: 14, height: 14, border: '2px solid var(--fg)', borderTopColor: 'var(--accent)', display: 'inline-block' }} />
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ width: '100%', maxWidth: 400 }}>
        <div className="stamp" style={{ marginBottom: 8 }}>Resources</div>
        <div className="mono" style={{ fontSize: 9, color: 'var(--red)', padding: 12 }}>{error}</div>
      </div>
    );
  }

  const totalCost = (data?.servers.length || 0) * 4 + (data?.load_balancers.length || 0) * 6;
  const appsWithoutVolume = allApps.filter(a => !a.volume_id);

  return (
    <div style={{ width: '100%', maxWidth: 400 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div className="stamp" style={{ marginBottom: 0 }}>Resources</div>
        <div style={{ flex: 1 }} />
        {totalCost > 0 && (
          <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', fontWeight: 600 }}>
            ~€{totalCost}/mo
          </span>
        )}
        <button
          onClick={load}
          disabled={loading}
          className="act"
          style={{ fontSize: 8 }}
        >
          {loading ? '...' : 'Refresh'}
        </button>
      </div>

      {/* Servers */}
      <Section
        label="SERVERS"
        count={data?.servers.length || 0}
        icon={<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /><line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" /></svg>}
      >
        {data?.servers.length === 0 && <EmptyRow label="No servers" />}
        {data?.servers.map(s => (
          <ServerRow key={s.id} server={s} onDeleted={() => { load(); onChanged(); }} />
        ))}
      </Section>

      {/* Load Balancers */}
      <Section
        label="LOAD BALANCERS"
        count={data?.load_balancers.length || 0}
        icon={<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>}
      >
        {data?.load_balancers.length === 0 && <EmptyRow label="No load balancers" />}
        {data?.load_balancers.map(lb => (
          <LBRow key={lb.id} lb={lb} onDeleted={() => { load(); onChanged(); }} />
        ))}
      </Section>

      {/* Volumes */}
      <Section
        label="VOLUMES"
        count={data?.volumes.length || 0}
        icon={<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg>}
      >
        {data?.volumes.length === 0 && <EmptyRow label="No volumes" />}
        {data?.volumes.map(v => (
          <VolumeRow
            key={v.id}
            volume={v}
            allApps={allApps}
            onChanged={() => { load(); onChanged(); }}
          />
        ))}
        {appsWithoutVolume.length > 0 && (
          <AttachVolumeForm
            apps={appsWithoutVolume}
            detachedVolumes={(data?.volumes || []).filter(v => !v.app_name)}
            onAttached={() => { load(); onChanged(); }}
          />
        )}
      </Section>
    </div>
  );
}

function Section({ label, count, icon, children }: {
  label: string;
  count: number;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <span style={{ color: 'var(--fg-dim)' }}>{icon}</span>
        <span className="mono" style={{
          fontSize: 8, fontWeight: 700, letterSpacing: '.1em',
          color: 'var(--fg-faint)', textTransform: 'uppercase',
        }}>
          {label}
        </span>
        <span className="mono" style={{
          fontSize: 8, fontWeight: 700, color: 'var(--fg-faint)',
          background: 'var(--bg-alt)', padding: '0 4px',
          border: '1px solid var(--fg)', lineHeight: '14px',
        }}>
          {count}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {children}
      </div>
    </div>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <div style={{
      padding: '8px 10px', border: '1.5px dashed var(--fg)',
      background: 'var(--bg-alt)', textAlign: 'center',
    }}>
      <span className="mono" style={{ fontSize: 9, color: 'var(--fg-faint)' }}>{label}</span>
    </div>
  );
}

function ServerRow({ server, onDeleted }: {
  server: ResourceData["servers"][0];
  onDeleted: () => void;
}) {
  const [hint, setHint] = useState(false);
  const del = useConfirmAction(async () => {
    const res = await request.deleteResource({ type: "server", id: String(server.id) }) as any;
    if (res && !res.ok && res.error) throw new Error(res.error);
    onDeleted();
  });

  const inUse = server.app_count > 0;

  const handleClick = () => {
    if (inUse) {
      setHint(!hint);
      return;
    }
    del.click();
  };

  const statusDot =
    server.status === "ready" ? "dot-ok" :
    server.status === "provisioning" ? "dot-warn" : "dot-err";

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0,
      border: '1.5px solid var(--fg)', background: 'var(--bg-raised)',
      opacity: del.busy ? 0.4 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px' }}>
        <div className={`dot ${statusDot}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {server.name}
          </div>
          <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', display: 'flex', gap: 8, marginTop: 1 }}>
            <span>{server.ipv4}</span>
            <span>{server.type}</span>
            <span>{server.location}</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
          <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)' }}>
            {server.app_count} app{server.app_count !== 1 ? 's' : ''}
            {server.replica_count > server.app_count && ` / ${server.replica_count} repl`}
          </div>
        </div>
        <button
          onClick={handleClick}
          disabled={del.busy}
          className="act"
          style={{ color: (del.armed || hint) ? 'var(--red)' : undefined, flexShrink: 0 }}
        >
          {hint ? 'Not empty :(' : del.armed ? 'Confirm?' : 'Delete'}
        </button>
      </div>
      {del.error && (
        <div className="mono" style={{ fontSize: 8, color: 'var(--red)', padding: '0 8px 5px', borderTop: '1px solid var(--fg)' }}>
          {del.error}
        </div>
      )}
    </div>
  );
}

function LBRow({ lb, onDeleted }: {
  lb: ResourceData["load_balancers"][0];
  onDeleted: () => void;
}) {
  const [hint, setHint] = useState(false);
  const del = useConfirmAction(async () => {
    const res = await request.deleteResource({ type: "load_balancer", id: lb.id }) as any;
    if (res && !res.ok && res.error) throw new Error(res.error);
    onDeleted();
  });

  const inUse = !!lb.app_name;

  const handleClick = () => {
    if (inUse) {
      setHint(!hint);
      return;
    }
    del.click();
  };

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 0,
      border: '1.5px solid var(--fg)', background: 'var(--bg-raised)',
      opacity: del.busy ? 0.4 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px' }}>
        <div className="dot dot-ok" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {lb.name}
          </div>
          <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', display: 'flex', gap: 8, marginTop: 1 }}>
            <span>{lb.ipv4}</span>
            <span>{lb.type}</span>
            <span>{lb.location}</span>
            {lb.app_name && <span style={{ color: 'var(--accent)' }}>{lb.app_name}</span>}
          </div>
        </div>
        <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', flexShrink: 0 }}>
          {lb.targets} target{lb.targets !== 1 ? 's' : ''}
        </div>
        <button
          onClick={handleClick}
          disabled={del.busy}
          className="act"
          style={{ color: (del.armed || hint) ? 'var(--red)' : undefined, flexShrink: 0 }}
        >
          {hint ? 'Still busy :(' : del.armed ? 'Confirm?' : 'Delete'}
        </button>
      </div>
      {del.error && (
        <div className="mono" style={{ fontSize: 8, color: 'var(--red)', padding: '0 8px 5px', borderTop: '1px solid var(--fg)' }}>
          {del.error}
        </div>
      )}
    </div>
  );
}

function VolumeRow({ volume, allApps, onChanged }: {
  volume: ResourceData["volumes"][0];
  allApps: Array<App & { server_location: string }>;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [newSize, setNewSize] = useState("");
  const [reattachAppId, setReattachAppId] = useState("");
  const [delHint, setDelHint] = useState(false);

  const del = useConfirmAction(async () => {
    const res = await request.deleteResource({ type: "volume", id: volume.id }) as any;
    if (res && !res.ok && res.error) throw new Error(res.error);
    onChanged();
  });

  const detach = useConfirmAction(async () => {
    setBusy(true);
    setError("");
    try {
      const res = await request.detachVolume({ app_id: volume.app_id }) as any;
      if (!res.ok) throw new Error(res.error || "Detach failed");
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setBusy(false);
  });

  const handleResize = async () => {
    const size = parseInt(newSize, 10);
    if (!size || size <= volume.size) return;
    setBusy(true);
    setError("");
    try {
      const res = await request.resizeVolume({ volume_id: volume.id, size }) as any;
      if (!res.ok) throw new Error(res.error || "Resize failed");
      setNewSize("");
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setBusy(false);
  };

  const handleReattach = async () => {
    const toAppId = parseInt(reattachAppId, 10);
    if (!toAppId || !volume.app_id) return;
    setBusy(true);
    setError("");
    try {
      const res = await request.reattachVolume({
        volume_id: volume.id,
        from_app_id: volume.app_id,
        to_app_id: toAppId,
      }) as any;
      if (!res.ok) throw new Error(res.error || "Reattach failed");
      setReattachAppId("");
      onChanged();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setBusy(false);
  };

  // Apps eligible for reattach: no volume, same location
  const eligibleApps = allApps.filter(a =>
    !a.volume_id && a.server_location === volume.location && a.id !== volume.app_id
  );

  return (
    <div style={{
      border: '1.5px solid var(--fg)',
      background: 'var(--bg-raised)',
      opacity: (del.busy || busy) ? 0.4 : 1,
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 8px', cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <div className={`dot ${volume.app_name ? 'dot-ok' : 'dot-off'}`} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {volume.name}
          </div>
          <div className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', display: 'flex', gap: 8, marginTop: 1 }}>
            <span>{volume.size} GB</span>
            <span>{volume.location}</span>
            {volume.server_name && <span>{volume.server_name}</span>}
            {volume.app_name ? (
              <span style={{ color: 'var(--accent)' }}>{volume.app_name}</span>
            ) : (
              <span style={{ color: 'var(--amber)' }}>detached</span>
            )}
          </div>
        </div>
        <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', flexShrink: 0 }}>
          {expanded ? '−' : '+'}
        </span>
      </div>

      {/* Expanded actions */}
      {expanded && (
        <div style={{
          padding: '6px 8px', borderTop: '1px solid var(--bg-alt)',
          display: 'flex', flexDirection: 'column', gap: 6,
        }}>
          {(error || del.error) && (
            <div className="mono" style={{ fontSize: 8, color: 'var(--red)' }}>{error || del.error}</div>
          )}

          {/* Resize */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', width: 42 }}>Resize</span>
            <input
              className="inp mono"
              type="number"
              value={newSize}
              onChange={e => setNewSize(e.target.value)}
              placeholder={`>${volume.size}`}
              min={volume.size + 1}
              style={{ width: 60, fontSize: 9, padding: '2px 4px' }}
            />
            <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)' }}>GB</span>
            <button
              className="act"
              disabled={busy || !newSize || parseInt(newSize, 10) <= volume.size}
              onClick={handleResize}
              style={{ fontSize: 8 }}
            >
              Resize
            </button>
          </div>

          {/* Detach (only if attached) */}
          {volume.app_id > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', width: 42 }}>Detach</span>
              <span className="mono" style={{ fontSize: 8, color: 'var(--fg-dim)', flex: 1 }}>
                from {volume.app_name}
              </span>
              <button
                className="act"
                disabled={busy}
                onClick={detach.click}
                style={{ color: detach.armed ? 'var(--red)' : undefined, fontSize: 8 }}
              >
                {detach.armed ? 'Confirm?' : 'Detach'}
              </button>
            </div>
          )}

          {/* Reattach (only if attached and eligible targets exist) */}
          {volume.app_id > 0 && eligibleApps.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', width: 42 }}>Move</span>
              <div style={{ flex: 1 }}>
                <NeoSelect
                  compact
                  value={reattachAppId}
                  onChange={setReattachAppId}
                  placeholder="select app..."
                  options={eligibleApps.map(a => ({ value: String(a.id), label: a.name }))}
                />
              </div>
              <button
                className="act"
                disabled={busy || !reattachAppId}
                onClick={handleReattach}
                style={{ fontSize: 8 }}
              >
                Move
              </button>
            </div>
          )}

          {/* Delete */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', width: 42 }}>Delete</span>
            <span className="mono" style={{ fontSize: 8, color: 'var(--fg-dim)', flex: 1 }}>
              permanently destroy volume
            </span>
            <button
              className="act"
              disabled={del.busy}
              onClick={() => {
                if (volume.app_id > 0) {
                  setDelHint(!delHint);
                  return;
                }
                del.click();
              }}
              style={{ color: (del.armed || delHint) ? 'var(--red)' : undefined, fontSize: 8 }}
            >
              {delHint ? 'Not free :(' : del.armed ? 'Confirm?' : 'Delete'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AttachVolumeForm({ apps, detachedVolumes, onAttached }: {
  apps: Array<App & { server_location: string }>;
  detachedVolumes: ResourceData["volumes"];
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"new" | "existing">(detachedVolumes.length > 0 ? "existing" : "new");
  const [appId, setAppId] = useState("");
  const [volumeId, setVolumeId] = useState("");
  const [size, setSize] = useState("10");
  const [mountPath, setMountPath] = useState("/data");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleAttach = async () => {
    const id = parseInt(appId, 10);
    if (!id) return;
    setBusy(true);
    setError("");
    try {
      let res: any;
      if (mode === "existing") {
        if (!volumeId) return;
        res = await request.attachExistingVolume({ app_id: id, volume_id: volumeId, mount_path: mountPath || "/data" });
      } else {
        const gb = parseInt(size, 10);
        if (!gb || gb < 10) return;
        res = await request.attachVolume({ app_id: id, size: gb, mount_path: mountPath || "/data" });
      }
      if (!res.ok) throw new Error(res.error || "Attach failed");
      setAppId("");
      setVolumeId("");
      setSize("10");
      setMountPath("/data");
      setOpen(false);
      onAttached();
    } catch (err: any) {
      setError(err.message || String(err));
    }
    setBusy(false);
  };

  if (!open) {
    return (
      <div
        onClick={() => setOpen(true)}
        style={{
          padding: '6px 10px', border: '1.5px dashed var(--fg)',
          background: 'var(--bg-alt)', textAlign: 'center', cursor: 'pointer',
        }}
      >
        <span className="mono" style={{ fontSize: 9, color: 'var(--fg-dim)' }}>+ Attach volume to app</span>
      </div>
    );
  }

  const canSubmit = mode === "existing"
    ? !busy && !!appId && !!volumeId
    : !busy && !!appId && !!size && parseInt(size, 10) >= 10;

  return (
    <div style={{
      padding: '8px', border: '1.5px solid var(--fg)',
      background: 'var(--bg-raised)',
      display: 'flex', flexDirection: 'column', gap: 5,
      opacity: busy ? 0.4 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="mono" style={{ fontSize: 8, fontWeight: 700, color: 'var(--fg-dim)' }}>ATTACH VOLUME</span>
        <button className="act" onClick={() => setOpen(false)} style={{ fontSize: 8 }}>Cancel</button>
      </div>

      {error && (
        <div className="mono" style={{ fontSize: 8, color: 'var(--red)' }}>{error}</div>
      )}

      {/* Mode toggle */}
      <div style={{ display: 'flex', gap: 0 }}>
        <button
          className="mono"
          onClick={() => setMode("existing")}
          style={{
            flex: 1, fontSize: 8, padding: '3px 6px', cursor: 'pointer',
            background: mode === "existing" ? 'var(--fg)' : 'var(--bg-alt)',
            color: mode === "existing" ? 'var(--bg)' : 'var(--fg-dim)',
            border: '1.5px solid var(--fg)', borderRight: 'none',
            fontWeight: mode === "existing" ? 700 : 400,
          }}
        >
          Existing volume
        </button>
        <button
          className="mono"
          onClick={() => setMode("new")}
          style={{
            flex: 1, fontSize: 8, padding: '3px 6px', cursor: 'pointer',
            background: mode === "new" ? 'var(--fg)' : 'var(--bg-alt)',
            color: mode === "new" ? 'var(--bg)' : 'var(--fg-dim)',
            border: '1.5px solid var(--fg)',
            fontWeight: mode === "new" ? 700 : 400,
          }}
        >
          New volume
        </button>
      </div>

      <NeoSelect
        compact
        value={appId}
        onChange={setAppId}
        placeholder="select app..."
        options={apps.map(a => ({ value: String(a.id), label: a.name }))}
      />

      {mode === "existing" ? (
        <NeoSelect
          compact
          value={volumeId}
          onChange={setVolumeId}
          placeholder="select volume..."
          options={detachedVolumes.map(v => ({ value: v.id, label: `${v.name} (${v.size}GB, ${v.location})` }))}
        />
      ) : (
        <div style={{ display: 'flex', gap: 4 }}>
          <input
            className="inp mono"
            type="number"
            value={size}
            onChange={e => setSize(e.target.value)}
            placeholder="GB"
            min={10}
            max={10240}
            style={{ width: 60, fontSize: 9, padding: '3px 4px' }}
          />
          <span className="mono" style={{ fontSize: 8, color: 'var(--fg-faint)', alignSelf: 'center' }}>GB</span>
        </div>
      )}

      <input
        className="inp mono"
        value={mountPath}
        onChange={e => setMountPath(e.target.value)}
        placeholder="/data"
        style={{ fontSize: 9, padding: '3px 4px' }}
      />

      <div className="mono" style={{ fontSize: 8, color: 'var(--fg-dim)', lineHeight: 1.4 }}>
        Mount path must match where your app stores data inside the container (e.g. /app/data). Attaching a volume will recreate the container.
      </div>

      <button
        className="btn"
        disabled={!canSubmit}
        onClick={handleAttach}
        style={{ fontSize: 9, padding: '4px 8px' }}
      >
        {busy ? 'Attaching...' : 'Attach Volume'}
      </button>
    </div>
  );
}
