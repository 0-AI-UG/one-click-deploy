# Hetzner Object Storage

OCD can inventory, create, and delete Hetzner S3 buckets. Object Storage uses
separate S3 credentials; the Hetzner Cloud API token used for servers and
volumes cannot authenticate S3 requests.

## Connect

Generate an access key and secret key in Hetzner Console under **Security → S3
Credentials**. In OCD, open **Admin → Infrastructure**, enter both keys, and
choose the location-bound endpoint (`fsn1`, `nbg1`, or `hel1`). OCD verifies the
credentials before saving them and stores both values in its encrypted secret
store. Hetzner does not expose S3 credential creation through its public API.

Each configured connection covers one Hetzner project and one location. Use the
Resources page or the CLI:

```text
ocd buckets list
ocd buckets create <globally-unique-name>
ocd buckets delete <name>
```

New buckets are private. Create and delete operations require browser approval.
OCD only deletes an empty bucket and never recursively deletes objects, object
versions, or incomplete multipart uploads. Remove that data with an S3 client
before deleting the bucket.

Hetzner S3 credentials normally have project-wide access. Do not inject OCD's
administrative credential into applications. Create separate application
credentials in Hetzner Console and restrict them with bucket policies before
storing them as environment secrets.
