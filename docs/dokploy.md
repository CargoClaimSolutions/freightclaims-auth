# Dokploy deployment

The auth stack is a Dokploy Compose application. PostgreSQL is a separate native Dokploy database,
not a Compose service.

## Required Dokploy environment

- `BWS_ACCESS_TOKEN`: token for the `freightclaims-auth` Bitwarden machine account.
- `BWS_PROJECT_ID`: UUID of the `freightclaims-auth` Bitwarden project.

The machine account needs write access only for the first successful catalog bootstrap, which
creates OIDC clients and persists their one-time client secrets. Change it to read-only after the
first deployment.

## Required Bitwarden secrets

- `ZITADEL_DATABASE_URL`: internal native-PostgreSQL DSN with TLS settings appropriate to Dokploy.
- `ZITADEL_MASTERKEY`: exactly 32 random bytes; immutable for the lifetime of the instance.
- `ZITADEL_INITIAL_ADMIN_PASSWORD`: initial password for the `zitadel-admin` user (email
  `patrick@ensombl.io`).
- `RESEND_API_KEY`: sending-only Resend key restricted to `notifications.freightclaims.com`, the
  domain of `noreply@notifications.freightclaims.com`.

The bootstrap creates the product runtime entries documented in
[`deploy/secrets/manifest.json`](../deploy/secrets/manifest.json). These are consumed by product
deployments; they are not injected into the ZITADEL runtime.

## Routing

Dokploy Traefik terminates TLS. Public routing is owned by the Compose application's **Domains**
tab; `deploy/dokploy/compose.yml` intentionally contains no Traefik labels or manually declared
`dokploy-network`. Dokploy injects both when it deploys the registered domains.

Configure these HTTPS domains with a Let's Encrypt certificate:

| Host | Public path | Service | Port | Internal path | Strip path |
| --- | --- | --- | ---: | --- | --- |
| `auth.freightclaims.com` | `/` | `zitadel-api` | 8080 | `/` | No |
| `auth.freightclaims.com` | `/ui/v2/login` | `product-login-root` | 8080 | `/` | No |
| `auth.freightclaims.com` | `/admin/v1` | `zitadel-api` | 8080 | `/` | No |
| `auth.freightclaims.com` | `/admin` | `zitadel-api` | 8080 | `/ui/console` | Yes |

The more-specific Login V2 and `/admin` paths take precedence over the `/` route.
`product-login-root` proxies Login V2 and `/assets` while preserving the public hostname, limits
repeated username submissions at the public ingress (this bounds native setup-email triggers for
identities that do not have an authentication method), redirects the exact `/` path to Login V2,
and returns 404 for every other path it receives. The native `/admin/v1` passthrough must remain
more specific than the `/admin` Console shortcut; otherwise the shortcut's path rewrite breaks
ZITADEL's Admin API. A Compose redeploy is required after changing any of these domain records.

- `https://auth.freightclaims.com/ui/console` is the ZITADEL Console.
- `https://auth.freightclaims.com/admin` is rewritten internally to the Console.
- The issuer and Login V2 share one origin. Each OIDC application receives its Login V2 base URI
  from the product's `auth_origin`, which equals the issuer.
- Login V2 is enabled per application, not forced instance-wide.

`product-login-root` also buffers each Login V2 response so the browser receives it in one piece.
A password or login-name server action streams an external redirect before the re-rendered page.
Firefox and Safari cancel that stream when the redirect starts, so with nginx's default 4k buffers
they briefly show "This page couldn't load" after a successful sign-in. The configuration comment links the
upstream issues. The buffering relies on nginx's default HTTP/1.0 connection to Login V2, which the
configuration pins: over HTTP/1.1 Login V2 answers chunked and nginx releases the redirect early.
`pnpm check:login-buffering` runs the configuration in the hosted nginx image against a fake
streaming Login V2 and fails if the redirect row reaches the client before the response ends. As a
control, it also runs the configuration with nginx's default 4k buffers and fails if that baseline
does not release the row early. It needs Docker and the `nginx` and `node:24-alpine` images.

## Recovery

Recovery uses a native PostgreSQL backup together with the matching reviewed Git revision. Configure
a documented retention policy, monitor backup completion, and perform periodic restore tests into
an isolated database before relying on the backup for disaster recovery.
