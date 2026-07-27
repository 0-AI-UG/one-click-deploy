# Recovering retained volumes

OCD does not immediately delete managed app or service volumes when their
owner is destroyed or a stateful-service deployment compensates. It detaches
the volume and records it as `retired` with a seven-day `purge_after` date.

Retained volumes remain visible under **Resources → Volumes**, including their
provider volume ID, former owner, and purge-after date. They continue to incur
Hetzner volume charges.

To recover an app volume during the grace period, use the existing
**attach-existing volume** action and select the recorded provider volume ID.
For a managed service, create or recover the service first, then attach and
mount the volume under operator supervision before starting the container.

The purge-after date is an operator review date, not an automatic deletion.
Delete the detached provider volume from Resources only after backups and
recovery are no longer needed.
