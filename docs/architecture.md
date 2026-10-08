# Architecture

## Identity and tenancy model

This ZITADEL instance serves FreightClaims alone. The FreightClaims organization owns the
identities admitted to FreightClaims. Customer tenancy is application data and is not represented
by ZITADEL organizations.

| Ensombl concept | ZITADEL object |
| --- | --- |
| Global identity platform | Instance |
| Product identity owner and product branding | Product owner organization |
| FreightClaims | Project |
| Local, staging, or production BFF | OIDC application |
| Human admitted to a product | User in the product organization |
| Customer tenant, membership, and role | Product database |
| Tenant data isolation | Product database RLS |
| Admin UI | ZITADEL Console |

Product projects are owned by dedicated product organizations. Enforcing project-owner branding
therefore makes the login screen deterministic from the OIDC client before the user is known. The
OIDC request includes the product organization scope, so only identities owned by that product
organization can log in. Customer-tenant selection and branding belong to the product UI.

The instance has exactly one organization, FreightClaims. ZITADEL creates it as the first-instance
organization, holding the initial administrator and the bootstrap and Login V2 machine accounts, and
the catalog names it as both the instance organization and the FreightClaims owner organization, so
the first catalog bootstrap brands it. Login V2 shows the default organization's branding when a
request names no organization, so every login screen on the instance is FreightClaims-branded.

Organization domains are identity-discovery and username-suffix domains, not service hostnames.
The catalog makes `freightclaims.com` primary for the FreightClaims organization. Bootstrap removes
the automatic `<organization>.<issuer host>` domain generated from ZITADEL's external hostname.

ZITADEL refuses a username `name@domain` only when an organization other than the user's own has
verified `domain` (`COMMAND-SFd21`), and no other organization exists, so every FreightClaims
identity can take its email address as its username. The initial administrator's username is
`zitadel-admin`.

Products have no default ZITADEL project roles. Each product may independently declare roles in the
catalog. Bootstrap enables role claims when roles exist, does not require a role for login, and does
not assign roles implicitly.

## Authentication

Products use Authorization Code with PKCE through a confidential BFF client. The canonical issuer
is the catalog's `issuer`. The signed subject identifies the human. Each product resolves that
subject to its own memberships and establishes an RLS context; authentication alone never grants
tenant data access.

Machine clients use ZITADEL API applications and standard token introspection. Product management
uses the environment's declared ZITADEL service account and short-lived client-credentials access
tokens. The initial IAM-owner PAT exists only inside the auth stack to apply the declarative
catalog and is mounted from the private bootstrap volume. Product workloads never receive it.

ZITADEL Console access uses built-in administrator permissions, not product project roles. The
configured initial administrator owns instance bootstrap. Product management service accounts have
no instance administrator role. They receive `ORG_USER_MANAGER` on the product organization so they
can invite and manage product identities; a product that sets `instance_org_user_lookup` in the
catalog also gives its management accounts `ORG_OWNER_VIEWER` (read only) on the instance
organization, so the product can resolve — but never modify — identities owned by that
organization. FreightClaims owns the instance organization, so the flag has no effect here. This stays an organization role — the accounts still hold no
`IAM_*` instance role. Declaring global project roles never grants a runtime or migration account
project administration; role definitions and assignments remain explicit control-plane operations.

FreightClaims has one dedicated migration service account with `ORG_USER_MANAGER` on its own
organization. It receives neither `IAM_OWNER`, `IAM_ORG_MANAGER`, nor general user-management
permission across the instance. The hosted account additionally receives `IAM_LOGIN_CLIENT` solely
for the bounded imported-password verification test. Staging and production share this account.

## Legacy password migration

ZITADEL is configured with the `argon2` password verifier. The FreightClaims migrator sends the
Argon2id PHC string to `POST /v2/users/new` as `hashedPassword.hash` and sets
`changeRequired: true`. The bounded migrator decrypts the legacy credential only in a no-swap,
no-core-dump tmpfs process, immediately hashes it, and never logs or persists the plaintext. The
FreightClaims runtime never receives the legacy password.

An imported Argon2id PHC must authenticate with the legacy password, require an immediate password
change, and preserve the signed subject used by the product database. ZITADEL rehashes a verified
legacy password using its active password hasher.

## Branding and email

ZITADEL owns instance and product login branding. Each product project enforces its
owner organization's branding from the first login screen. Each application uses its product's
`auth_origin` as its Login V2 base URI while the catalog's `issuer` remains the only issuer. Product
Login V2 hosts are instance trusted domains; the stock Login V2 proxy sends the canonical instance
host separately from the browser-facing product host. The instance-wide Login V2 override stays
disabled so ZITADEL honors those per-application hosts; the Management Console is explicitly pinned
to the canonical host.

Each product declares its native hosted-login policy independently. FreightClaims keeps the
canonical application's username/password and password-recovery behavior, disables public
self-registration and external identity providers, and applies the canonical FreightClaims logo,
green palette, neutral background, and light theme through ZITADEL's organization branding and
asset APIs. Applications never render or collect credentials themselves.

ZITADEL system notifications use `FreightClaims <noreply@notifications.freightclaims.com>`, the
catalog's `email` block, through Resend SMTP
with authenticated STARTTLS on port 587. The one-shot catalog bootstrap applies the active provider
through ZITADEL's Admin API so an existing instance receives the same configuration as a fresh
instance. ZITADEL sends every message, invitations included, from that sender: `email_from_name`
in the catalog is not applied to ZITADEL mail, and the sender is an instance setting that no
organization can override. A product that invites a user controls the wording and the link, not the
sender: it passes `applicationName` and a `urlTemplate` with the `invite_code` request. Generic
account recovery uses the same FreightClaims sender.

A user who finishes a flow ZITADEL did not start from an OIDC request, such as activating an
invitation, is sent to the product organization's login-policy `defaultRedirectUri`; without one
ZITADEL leaves them on its Console. The catalog's `login_policy.default_redirect_uri` sets it and
must sit under one of the product's applications. An organization has one value, so a product with
a staging and a production application picks one.

## Runtime and secrets

The hosted stack contains ZITADEL, Login V2, a one-shot Bitwarden secret loader, and a one-shot
catalog bootstrap. PostgreSQL is a native Dokploy database service.

Dokploy receives only `BWS_ACCESS_TOKEN` and the non-secret `BWS_PROJECT_ID`. The loader writes the
ZITADEL master key and JSON runtime config to a private volume. ZITADEL itself has no Bitwarden
token or outbound secret-manager access.

No project container image is published. Dokploy builds the two small helper images from the
reviewed source and pulls the pinned upstream ZITADEL images.
