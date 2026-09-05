# S3-compatible Object Storage

OCD can inventory, create, and delete buckets through a path-style,
S3-compatible HTTPS endpoint. Object storage uses its own access key and secret;
it is independent of the optional infrastructure provisioner.

## Connect

Generate an access key and secret key with your object-storage provider. In OCD,
open **Admin → Providers**, add an **S3-compatible object storage** provider
with both keys, the SigV4 signing region, and the provider's HTTPS origin (for
example `https://s3.example.com`), then select it under **Object storage**. OCD verifies
the credentials before saving them and stores both values in its encrypted
secret store.

Each configured connection covers one account/project and endpoint. Use the
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

Object-storage credentials are often account- or project-wide. Do not inject
OCD's administrative credential into applications. Create separate application
credentials and restrict them with bucket policies before storing them as
environment secrets.

## OCD-scoped application access

Apps can instead use OCD-issued tokens; the provider's credentials stay in the
panel. Each token is bound to a provider, bucket, prefix, and explicit methods.
The application requests short-lived object URLs from `/api/storage/authorize`
and transfers bytes directly to object storage. List requests are constrained
to the token's prefix. Provider assignment, endpoint, or region changes cause
existing grants to fail closed until rebound.

```text
ocd storage list
ocd storage grant my-app my-bucket --prefix=my-app/ --methods=GET,HEAD,PUT,DELETE,LIST --token-file=/private/path/storage-token
ocd storage revoke <grant-id>
```

These commands require an administrator. The token file is created with mode
0600 and is never overwritten. Store its value in an encrypted OCD environment
as OCD_STORAGE_TOKEN, with OCD_STORAGE_URL set to the panel's HTTPS
`/api/storage/authorize` URL, then remove the temporary file. Apps must opt into
the OCD storage driver. The TypeScript fetch client is in
`packages/storage-client/index.ts`.

Grants may be prepared before an app is created and require explicit revocation
when retired. Revocation blocks new authorizations immediately; previously
issued object URLs remain usable until they expire, at most one hour later.
Use GET/HEAD for readers and GET/PUT for the shared backup service. Grant DELETE
and LIST only where application deletion or retention needs them.

For Hetzner Object Storage, use the location as the signing region and
`https://<location>.your-objectstorage.com` as the endpoint. Other providers
must support path-style bucket requests and AWS SigV4 signing.

## Managed app bindings and multiple connections

Named S3 connections can be used simultaneously. The Object Storage page has a
connection selector; `ocd buckets list --storage=<id-or-name>` and bucket
create/delete accept the same selector. Omitting it uses the default. Confirmed
bucket operations are scoped to connection ID plus bucket name.

Declare app-owned access in the manifest:

```json
{
  "storage": {
    "primary": {
      "connection": "s3-compatible-3206399b",
      "bucket": "app-uploads",
      "prefix": "production/",
      "permissions": ["read", "write", "delete", "list"]
    }
  }
}
```

Bindings require an existing bucket and administrator authorization for deployment.
Each app and named binding receives a different encrypted grant, even when they
share a bucket or prefix. An omitted connection selects the default only for a
new binding; reconciliation retains an existing binding's connection ID. A changed
global default does not redirect app traffic.

The `primary` binding injects `OCD_STORAGE_TOKEN` and `OCD_STORAGE_URL` directly
into the container. Other names use `OCD_<NAME>_STORAGE_TOKEN` and
`OCD_<NAME>_STORAGE_URL`. These override environment values and bypass shared
variable projection. The panel displays masked, read-only binding details.
Keep application driver settings (such as `STORAGE_DRIVER=ocd`) in normal app
configuration and use the OCD client. No S3 provider credentials reach the app.

Permissions map to GET/HEAD (`read`), PUT (`write`), DELETE (`delete`), and LIST
(`list`). Increment a binding's `generation` to rotate its token. Preparation
keeps the previous grant valid; retirement happens only after all replicas attest
to the desired environment. Removing a binding follows the same retirement rule.
Deleting an app revokes its managed grants. Standalone manually issued grants
still require explicit revocation.

Connection deletion and endpoint/region changes are blocked while referenced by
app bindings, grants, or enabled panel backups. Rebind to another connection
explicitly; credential rotation can update the existing connection. Bindings do
not copy objects. Staging must select a separate explicit bucket/prefix scope.

Panel backup configuration pins a connection ID. Each backup records that ID,
endpoint and region; changing the global default does not affect it.
