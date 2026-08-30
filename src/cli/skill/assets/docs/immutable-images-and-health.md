# Immutable Images and Health

OCD builds from exact commits but deploys only registry-produced immutable
references such as `registry.example.com/team/api@sha256:<64-hex-digest>`. The worker may
push a temporary commit tag; OCD immediately resolves it to a digest before a
runtime operation. Rollback, promotion, history, and attestation use the digest.

For private source and images, use `ocd source login` and `ocd registry login`
(or the Admin Settings connection cards). These connections accept compatible
Git and OCI providers; GHCR and GitHub are options, not requirements. The Git token is used only for checkout. The
OCI credential is scoped to its configured repository namespace
and is used for worker pushes and runtime pulls. Never put credentials in a
manifest, image reference, or logs.

OCD starts a candidate, evaluates its declared readiness contract, and makes it
current only after success. A failed build or candidate does not change the
app's desired image.

Readiness modes:

- `http`: path plus accepted statuses (default `[200]`);
- `container`: container remains running;
- `exec`: command exits zero;
- `heartbeat` / `periodic_job`: marker file remains within max age.

Inspect failures with:

```bash
ocd app deployments my-app
ocd logs my-app --tail=200
ocd ops --app=my-app
ocd ops logs <id> --follow
```
