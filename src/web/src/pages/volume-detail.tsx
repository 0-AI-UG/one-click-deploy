import { useState, useEffect, useCallback } from "react";
import { get } from "../api/client.ts";
import { Card, Btn, Spinner, EmptyState, showToast } from "../components/ui.tsx";
import { Database, Folder, FileText, ArrowLeft, ChevronRight, RefreshCw, FileWarning } from "lucide-react";

type VolumeDetail = {
  id: string;
  name: string;
  size: number;
  location: string;
  server_name: string | null;
  server_id: number | null;
  app_name: string | null;
  app_id: number | null;
  host_path: string | null;
  monthly_eur: number | null;
  attached: boolean;
};

type DirEntry = { name: string; type: "f" | "d" | "l" | "o"; size: number; mtime: number };

type FileView = {
  path: string;
  size: number;
  truncated: boolean;
  binary: boolean;
  content: string | null;
  max_bytes: number;
};

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function VolumeDetailPage({ volumeId }: { volumeId: string }) {
  const [detail, setDetail] = useState<VolumeDetail | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [listErr, setListErr] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [fileView, setFileView] = useState<FileView | null>(null);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    get(`/api/resources/volumes/${encodeURIComponent(volumeId)}`)
      .then(setDetail)
      .catch((err) => setDetailErr(err.message));
  }, [volumeId]);

  const loadDir = useCallback(async (p: string) => {
    setListLoading(true);
    setListErr(null);
    try {
      const res = await get(`/api/resources/volumes/${encodeURIComponent(volumeId)}/files?path=${encodeURIComponent(p)}`);
      setEntries(res.entries);
    } catch (err: any) {
      setListErr(err.message);
      setEntries(null);
    } finally {
      setListLoading(false);
    }
  }, [volumeId]);

  useEffect(() => {
    if (detail?.attached) loadDir(path);
  }, [detail?.attached, path, loadDir]);

  const openFile = async (name: string) => {
    const full = path ? `${path}/${name}` : name;
    setFilePath(full);
    setFileView(null);
    setFileLoading(true);
    try {
      const res = await get(`/api/resources/volumes/${encodeURIComponent(volumeId)}/file?path=${encodeURIComponent(full)}`);
      setFileView(res);
    } catch (err: any) {
      showToast(err.message, "error");
      setFilePath(null);
    } finally {
      setFileLoading(false);
    }
  };

  const goUp = () => {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    parts.pop();
    setPath(parts.join("/"));
    setFilePath(null);
    setFileView(null);
  };

  const goInto = (name: string) => {
    setPath(path ? `${path}/${name}` : name);
    setFilePath(null);
    setFileView(null);
  };

  const jumpTo = (idx: number) => {
    const parts = path.split("/").filter(Boolean);
    setPath(parts.slice(0, idx + 1).join("/"));
    setFilePath(null);
    setFileView(null);
  };

  if (detailErr) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-6">
        <Btn variant="ghost" onClick={() => { window.location.hash = "#/resources"; }}>
          <ArrowLeft size={11} /> Back to Resources
        </Btn>
        <Card className="p-6 mt-4">
          <EmptyState message={detailErr} icon={FileWarning} />
        </Card>
      </div>
    );
  }
  if (!detail) return <div className="flex justify-center py-20"><Spinner /></div>;

  const crumbs = path.split("/").filter(Boolean);

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-4 animate-fade-in">
      <div className="flex items-center gap-2">
        <Btn variant="ghost" size="xs" onClick={() => { window.location.hash = "#/resources"; }}>
          <ArrowLeft size={11} /> Resources
        </Btn>
        <Database size={16} className="text-fg" />
        <h1 className="font-mono font-bold text-sm text-fg uppercase">{detail.name}</h1>
      </div>

      <Card className="p-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Info label="Size" value={`${detail.size} GB`} />
          <Info label="Location" value={detail.location} />
          <Info label="Server" value={detail.server_name || "—"} />
          <Info label="App" value={detail.app_name || "—"} accent={!!detail.app_name} />
          <Info label="€/mo" value={detail.monthly_eur != null ? `€${detail.monthly_eur.toFixed(2)}` : "—"} />
        </div>
        {detail.host_path && (
          <div className="mt-3 pt-3 border-t border-fg/15 font-mono text-[10px] text-fg-dim">
            <span className="text-muted uppercase tracking-wider mr-2 text-[9px]">Host path</span>
            <span className="text-fg">{detail.host_path}</span>
          </div>
        )}
      </Card>

      {!detail.attached ? (
        <Card className="p-6">
          <EmptyState
            message="Volume is not attached to a server. Attach it to an app to inspect its contents."
            icon={FileWarning}
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          {/* File browser */}
          <Card className="p-3 md:col-span-2">
            <div className="flex items-center gap-2 mb-3">
              <Folder size={13} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Files</h3>
              <Btn variant="ghost" size="xs" onClick={() => loadDir(path)} className="ml-auto" title="Refresh">
                <RefreshCw size={11} />
              </Btn>
            </div>

            {/* Breadcrumbs */}
            <div className="flex items-center flex-wrap gap-1 font-mono text-[10px] mb-2 px-1">
              <button
                onClick={() => { setPath(""); setFilePath(null); setFileView(null); }}
                className="text-accent-blue hover:underline"
              >
                /
              </button>
              {crumbs.map((c, i) => (
                <span key={i} className="flex items-center gap-1">
                  <ChevronRight size={10} className="text-muted" />
                  <button onClick={() => jumpTo(i)} className="text-accent-blue hover:underline">{c}</button>
                </span>
              ))}
            </div>

            {listLoading ? (
              <div className="py-8 flex justify-center"><Spinner /></div>
            ) : listErr ? (
              <EmptyState message={listErr} icon={FileWarning} />
            ) : !entries?.length ? (
              <EmptyState message="Empty directory" />
            ) : (
              <div className="border-2 border-fg max-h-[60vh] overflow-y-auto">
                {path && (
                  <button
                    onClick={goUp}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 font-mono text-[10px] hover:bg-alt border-b border-fg/15 text-fg-dim"
                  >
                    <Folder size={11} /> ..
                  </button>
                )}
                {entries.map((e) => {
                  const isDir = e.type === "d";
                  const active = filePath === (path ? `${path}/${e.name}` : e.name);
                  return (
                    <button
                      key={e.name}
                      onClick={() => isDir ? goInto(e.name) : openFile(e.name)}
                      className={`w-full text-left flex items-center gap-2 px-2 py-1.5 font-mono text-[10px] border-b border-fg/10 last:border-b-0 ${active ? "bg-accent text-fg" : "hover:bg-alt"}`}
                    >
                      {isDir ? <Folder size={11} className="text-fg" /> : <FileText size={11} className="text-fg-dim" />}
                      <span className={`flex-1 truncate ${isDir ? "font-bold" : ""}`}>{e.name}{e.type === "l" ? " →" : ""}</span>
                      <span className="text-muted text-[9px]">{isDir ? "" : fmtSize(e.size)}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          {/* File viewer */}
          <Card className="p-3 md:col-span-3">
            <div className="flex items-center gap-2 mb-3">
              <FileText size={13} className="text-fg" />
              <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider truncate">
                {filePath || "Select a file"}
              </h3>
              {fileView && (
                <span className="ml-auto font-mono text-[9px] text-muted uppercase">
                  {fmtSize(fileView.size)}{fileView.truncated ? ` · truncated @ ${fmtSize(fileView.max_bytes)}` : ""}
                </span>
              )}
            </div>
            {fileLoading ? (
              <div className="py-8 flex justify-center"><Spinner /></div>
            ) : !filePath ? (
              <EmptyState message="Click a file on the left to view its contents" />
            ) : fileView?.binary ? (
              <EmptyState message="Binary file — preview not available" icon={FileWarning} />
            ) : (
              <pre className="border-2 border-fg bg-alt/40 p-3 font-mono text-[11px] leading-relaxed max-h-[60vh] overflow-auto whitespace-pre-wrap break-all">
                {fileView?.content || ""}
              </pre>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

function Info({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="border-2 border-fg p-2 bg-alt">
      <div className="font-mono text-[9px] text-muted uppercase tracking-wider mb-1">{label}</div>
      <div className={`font-mono text-xs font-bold ${accent ? "text-accent-blue" : "text-fg"} truncate`} title={value}>
        {value}
      </div>
    </div>
  );
}

