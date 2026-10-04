# FreightClaims Auth

This repository is FreightClaims' own self-hosted ZITADEL identity instance. It owns
authentication, credentials, account recovery, login branding, OIDC applications, and service
accounts for FreightClaims, and serves no other product. Its history is imported from
`ensombl/ensombl-auth` `main` at `dac4888`. The hosted Compose project, Dokploy compose and Bitwarden
project are named `freightclaims-auth`; the service names are unchanged.

Customer tenants, memberships, application roles, permissions, and row-level security remain in
each product database. ZITADEL organizations represent product identity ownership; they do not
represent application tenants.

## Requirements

- Node.js 24
- pnpm 11
- Docker with Compose

## Local development

Install dependencies and start the disposable local stack:

```bash
pnpm install
pnpm dev
```

The command reserves a local profile in the shared per-user runtime registry. Product repositories
pass the same reservation into auth instead of allocating another block. The profile scopes the
Compose project, network, volumes, proxy and Mailpit ports, Traefik labels, issuer, and FreightClaims
application URL.

On Linux, allocation excludes the live TCP/UDP range from
[`ip_local_port_range`](https://docs.kernel.org/networking/ip-sysctl.html#ip-variables). On other
hosts, set `LOCAL_RUNTIME_EPHEMERAL_PORT_RANGE=<first>-<last>` from the reviewed host TCP dynamic-port
policy. Allocation fails if the range is unavailable or invalid.

Run the repository checks with:

```bash
pnpm check
```

Product repositories consume this repository as a pinned submodule so local development uses the
same ZITADEL and catalog bootstrap implementation as hosted environments.

## Repository layout

```text
deploy/
  bootstrap/   ZITADEL catalog bootstrap
  dokploy/     Hosted Compose definition
  products/    Non-secret product catalog and branding
  secrets/     Bitwarden secret manifest and loader
  zitadel/     ZITADEL and Login V2 configuration
docs/          Architecture, authorization, and deployment reference
tests/         Catalog, Compose, bootstrap, and policy tests
```

## Hosted service

`https://auth.freightclaims.com` is the issuer and also serves Login V2 and the ZITADEL Console.
Dokploy builds the repository sources directly; this project does not publish container images.

See:

- [Architecture](docs/architecture.md)
- [Roles and permissions](docs/roles-and-permissions.md)
- [Dokploy deployment](docs/dokploy.md)
- [Product catalog](deploy/products/README.md)
