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
