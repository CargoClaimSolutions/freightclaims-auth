# Invitation account setup

FreightClaims keeps ZITADEL self-registration disabled. Sending or resending an application
invitation stores an email invitation and sends the application link; it must not create a
provider user, issue a provider initialization code or reset credentials. Opening that link,
including a GET or prefetch, must not create an identity or accept membership.

## Platform setup contract

1. Require a deliberate same-origin setup POST holding a valid, pending, unexpired and unrevoked
   application invitation. Read the email from the stored invitation. Reject a mismatched signed-in
   account, and never use a browser-selected email to create or select the provider user.
2. Resolve the actual identity in the configured provider organization. An existing account with
   password, passkey or external identity-provider credentials uses ordinary sign-in; never reset,
   recreate or issue an initialization code for that account. An unresolved or ambiguous identity
   fails closed. Include unverified accounts in collision resolution rather than creating a duplicate.
3. Only for a genuinely new invitee, use the server's `user.write` authority to call
   `POST /v2/users/new` with the exact invitation email, no password and
   `human.email.returnCode: {}`. This suppresses a separate verification email and leaves the email
   unverified. Never mark the email verified from an editable form field.
4. Start the existing OIDC flow with the validated relative invitation path in sealed, short-lived
   state. Preserve state, nonce, PKCE, CSRF and session checks. Get the native authorization request
   ID by following LoginV2's redirect: `authRequest=V2_...` becomes
   `requestId=oidc_V2_...`. Passing the raw `authRequest` as `requestId` completes credential
   setup but falls back to the default URL instead of the OIDC callback. Read the actual native
   `requestId`; do not invent it or replace the registered callback.
5. For the new account without a primary authentication method, call
   `POST /v2/users/{userId}/invite_code` with `returnCode: {}`, or use `sendCode.urlTemplate` to
   send the code through the provider. The pinned stock LoginV2 route is
   `/ui/v2/login/verify?userId=...&code=...&organization=...&invite=true&requestId=...`.
   Supported template placeholders are `{{.UserID}}`, `{{.OrgID}}` and `{{.Code}}`; add the
   current `requestId` to that template. Never log codes, bearer links or credentials.
6. Let native LoginV2 verify the invite code, verify email and collect the first password or passkey.
   Platform never collects the password. Native verification creates its fingerprint-bound setup
   cookie and session, then carries `requestId` through `/authenticator/set`, credential setup and
   the normal OIDC completion. Retain provider MFA, authentication and session requirements.
7. Return through the normal verified callback to the same application invitation. Provider
   initialization grants no application membership. Require a separate explicit acceptance POST,
   rechecking invitation state and the current subject and verified email.
8. For a wrong account, use existing provider logout and the registered signed-out callback with
   sealed invitation continuation, then ordinary sign-in. Never reset credentials to switch accounts.

Coordinate setup by actual identity across invitations for organizations A and B. Resolve create
conflicts to the same actual user and preserve each pending acceptance. A new provider invite code
invalidates the previous one, so concurrent setup must coalesce or recover deliberately; identity
reuse alone does not preserve both code links. Before issuing any initialization code, recheck primary
methods. Never turn an existing credentialed account into a setup flow.

## Provider boundary

This contract is verified against ZITADEL and stock LoginV2 `v4.16.2`. The native invitation
verification action calls `VerifyInviteCode` independently of the separate `EMAIL_VERIFICATION`
flag used for ordinary login email checks. Registration remains disabled in both FreightClaims
catalogs. This repository does not implement the platform's invitation authorization boundary.
Source publication does not apply shared provider settings; runtime activation requires its own
operator decision.

References: [CreateUser](https://zitadel.com/docs/reference/api/user/zitadel.user.v2.UserService.CreateUser),
[CreateInviteCode](https://zitadel.com/docs/reference/api/user/zitadel.user.v2.UserService.CreateInviteCode),
[VerifyInviteCode](https://zitadel.com/docs/reference/api/user/zitadel.user.v2.UserService.VerifyInviteCode),
[pinned native verification](https://github.com/zitadel/zitadel/blob/v4.16.2/apps/login/src/lib/server/verify.ts),
[pinned authenticator setup](https://github.com/zitadel/zitadel/blob/v4.16.2/apps/login/src/app/(login)/authenticator/set/page.tsx).
