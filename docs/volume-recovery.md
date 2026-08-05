# Recovering retained volumes

OCD does not immediately delete managed app or service volumes. It detaches
the volume and records it as `retired` with a seven-day `purge_after` date.
Retention depends on why the volume was detached:

- volumes retained after an explicit app, service, or stack deletion remain
  user-owned and are never deleted automatically;
- volumes created only by a failed deployment are provisional. The reconciler
  deletes them after `purge_after`, but only if OCD has no live owner reference
  and the provider still reports the volume as detached.

Retained volumes remain visible under **Resources → Volumes**, including their
provider volume ID, former owner, and purge-after date. They continue to incur
Hetzner volume charges.

To recover an app volume during the grace period, use the existing
**attach-existing volume** action and select the recorded provider volume ID.
For a managed service, create or recover the service first, then attach and
mount the volume under operator supervision before starting the container.

For user-owned retention, the purge-after date is an operator review date, not
an automatic deletion. Delete the detached provider volume from Resources only
after backups and recovery are no longer needed. For failed-deploy provisional
volumes, recover or adopt the volume before the purge-after date; automated
deletion is recorded in the permanent volume-deletion audit.
