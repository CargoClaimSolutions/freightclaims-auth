# User-initiated invitation signup

The FreightClaims catalogs enable ZITADEL's native registration on the FreightClaims owner
organization. This is an organization-wide identity policy: anyone reaching that organization's
login can deliberately create an account. It is neither an invitation-token check nor a
per-client registration rule. Both hosted application environments share this identity policy.
The dedicated instance serves FreightClaims only; other product policies and the catalog schema's
disabled registration default are unchanged. Bootstrap uses the organization management endpoint
with `x-zitadel-orgid`, not the instance default policy endpoint.

An identity has no application tenant membership merely because it registered. The platform owns
pending email invitations, expiry, resend, status and explicit membership acceptance. Sending or
resending an invitation must not call ZITADEL human creation, credential reset or provider invitation
APIs. Existing users use their current account and credentials. Two invitations for different tenants
resolve independently against the current verified identity when accepted.

## Platform continuation contract

1. Open the platform invitation URL and display the invitation status without accepting it.
2. At deliberate sign-in or create-account action, use the existing OIDC authorization-code flow
   and configured callback, with the FreightClaims owner organization scope
   `urn:zitadel:iam:org:id:{ownerOrganizationId}`. `login_hint` may suggest the invited email;
   it is not proof of the authenticated account. Native `prompt=create` requests the registration
   screen; ordinary login also offers registration when allowed by the organization policy.
3. Keep the validated relative invitation path in the existing sealed, short-lived OIDC transient
   state. Reject external URLs, network-path references, backslashes and control characters.
   Preserve existing state, nonce, PKCE, CSRF and session validation. Never log invitation bearers.
   The organization `defaultRedirectUri` is for standalone provider flows and cannot preserve an
   individual invitation; do not substitute it for OIDC continuation.
4. After the normal callback, return to the invitation page. Require an explicit same-origin
   acceptance POST and verify the current account's subject and verified email against the
   invitation at that time. Registration and login must never accept automatically.
5. For a wrong account, use the existing provider logout and registered signed-out callback,
   retaining the same validated invitation path in sealed short-lived continuation state, then
   begin normal login again. Never reset credentials or recreate the account to switch users.

Native provider registration alone does not enforce invitation expiry, email matching or membership
rules. Deploying the hosted catalog applies a live identity policy and remains an operator approval
boundary; source publication and isolated local validation do not activate that policy.

References: [ZITADEL onboarding](https://zitadel.com/docs/guides/integrate/onboarding/end-users),
[organization scopes](https://zitadel.com/docs/apis/openidoauth/scopes).
