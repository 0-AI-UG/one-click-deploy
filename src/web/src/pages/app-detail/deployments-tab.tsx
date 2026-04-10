import { post } from "../../api/client.ts";
import { Card, Btn, StatusBadge, Table, confirm } from "../../components/ui.tsx";
import { PermissionGate } from "../../components/permission-gate.tsx";
import { Clock } from "lucide-react";
import type { DeploymentRecord } from "../../types.ts";

interface DeploymentsTabProps {
  appId: number;
  deployments: DeploymentRecord[];
  action: (name: string, fn: () => Promise<unknown>) => Promise<void>;
}

export function DeploymentsTab({ appId, deployments, action }: DeploymentsTabProps) {
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Clock size={14} className="text-fg" />
        <h3 className="font-mono text-[9px] text-fg font-bold uppercase tracking-wider">Deployment History</h3>
      </div>
      {deployments.length === 0 ? (
        <p className="text-[10px] text-muted font-mono py-4 text-center uppercase tracking-wider">No deployments yet</p>
      ) : (
        <Table headers={["ID", "Image", "Commit", "Source", "Status", "Date", ""]}>
          {deployments.map((d) => (
            <tr key={d.id} className="hover:bg-alt/50">
              <td className="py-2 px-3 text-fg font-bold">#{d.id}</td>
              <td className="py-2 px-3 text-fg-dim">{d.image_tag}</td>
              <td className="py-2 px-3 text-fg-dim">{d.git_commit?.slice(0, 7) || "—"}</td>
              <td className="py-2 px-3 text-fg-dim uppercase tracking-wider text-[9px]">{d.source || "manual"}</td>
              <td className="py-2 px-3"><StatusBadge status={d.status} /></td>
              <td className="py-2 px-3 text-muted">{new Date(d.created_at).toLocaleString()}</td>
              <td className="py-2 px-3">
                {d.status !== "failed" && (
                  <PermissionGate permission="apps.rollback">
                    <Btn
                      size="xs" variant="ghost"
                      onClick={async () => {
                        if (await confirm("Rollback", `Rollback to deployment #${d.id}?`)) {
                          action("rollback", () => post(`/api/apps/${appId}/rollback`, { deployment_id: d.id }));
                        }
                      }}
                    >Rollback</Btn>
                  </PermissionGate>
                )}
              </td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
