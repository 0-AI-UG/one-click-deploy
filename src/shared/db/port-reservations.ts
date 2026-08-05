import db from "./connection.ts";

export type PortReservation = {
  id: number;
  server_id: number;
  bind_address: string;
  host_port: number;
  protocol: string;
  owner_type: string;
  owner_id: string;
  created_at: string;
};

/**
 * Atomically claim a complete host bind tuple before any expensive or
 * destructive deployment work. Existing workload rows and in-flight claims
 * share the same transaction, closing the check-then-transfer race.
 */
export function reserveHostPort(args: {
  serverId: number;
  bindAddress: string;
  hostPort: number;
  protocol?: "tcp" | "udp";
  ownerType: string;
  ownerId: string;
}): PortReservation {
  const protocol = args.protocol ?? "tcp";
  return db.transaction(() => {
    const replica = db.query(
      "SELECT id, container_name FROM replicas WHERE server_id = ? AND host_port = ? LIMIT 1",
    ).get(args.serverId, args.hostPort) as { id: number; container_name: string } | null;
    if (replica) {
      throw new Error(
        `Port preflight failed: ${args.bindAddress}:${args.hostPort}/${protocol} is reserved by replica ${replica.container_name} (#${replica.id})`,
      );
    }
    const service = db.query(
      "SELECT id, container_name FROM service_instances WHERE server_id = ? AND host_port = ? LIMIT 1",
    ).get(args.serverId, args.hostPort) as { id: number; container_name: string } | null;
    if (service) {
      throw new Error(
        `Port preflight failed: ${args.bindAddress}:${args.hostPort}/${protocol} is reserved by service ${service.container_name} (#${service.id})`,
      );
    }
    const panel = db.query(
      "SELECT id, name FROM panel WHERE server_id = ? AND host_port = ? LIMIT 1",
    ).get(args.serverId, args.hostPort) as { id: number; name: string } | null;
    if (panel) {
      throw new Error(
        `Port preflight failed: ${args.bindAddress}:${args.hostPort}/${protocol} is reserved by panel ${panel.name}`,
      );
    }
    try {
      return db.query(
        `INSERT INTO port_reservations
          (server_id, bind_address, host_port, protocol, owner_type, owner_id)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
      ).get(
        args.serverId,
        args.bindAddress,
        args.hostPort,
        protocol,
        args.ownerType,
        args.ownerId,
      ) as PortReservation;
    } catch {
      const held = db.query(
        `SELECT * FROM port_reservations
         WHERE server_id = ? AND bind_address = ? AND host_port = ? AND protocol = ?`,
      ).get(args.serverId, args.bindAddress, args.hostPort, protocol) as PortReservation | null;
      throw new Error(
        `Port preflight failed: ${args.bindAddress}:${args.hostPort}/${protocol} is already reserved` +
          (held ? ` by ${held.owner_type}:${held.owner_id}` : ""),
      );
    }
  })();
}

export function releaseHostPortReservation(id: number): void {
  db.query("DELETE FROM port_reservations WHERE id = ?").run(id);
}

export function releaseHostPortReservations(ownerType: string, ownerId: string): void {
  db.query("DELETE FROM port_reservations WHERE owner_type = ? AND owner_id = ?")
    .run(ownerType, ownerId);
}
