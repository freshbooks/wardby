---
id: errors/mobile-disabled
title: Mobile sign-in is not enabled
summary: The server refused the mobile app's sign-in or registration because WARDBY_MOBILE_ENABLED is not true.
audience: operator
tags: [error, mobile, sign-in, oauth, mobile_disabled, WARDBY_MOBILE_ENABLED]
appliesTo: ">=0.6.0"
---

# Mobile sign-in is not enabled

Mobile sign-in is switched off. An operator turns it on with
`WARDBY_MOBILE_ENABLED`.

Only client registration returns the reason: `400 invalid_redirect_uri` with the
description `mobile_disabled: mobile sign-in is not enabled on this server
(WARDBY_MOBILE_ENABLED)`. Sign-in (authorize) and token refresh return the
generic `invalid_request` or `invalid_grant` with an `id`. The `mobile_disabled`
reason appears only in the control-plane log line "self-hosted OAuth request
rejected" for that `id`, so look the `id` up in the control-plane logs.

1. Set `WARDBY_MOBILE_ENABLED=true` on the control plane and restart it. On GKE,
   redeploy with `WARDBY_MOBILE_ENABLED=true` passed to `deploy/gke/up.sh`; a
   run without it turns mobile sign-in off again.
2. If you use a white-label build, check that `WARDBY_MOBILE_REDIRECT_URI`
   matches the redirect URI the app uses.
3. Sign in again from the app.

With an external identity provider this error does not come from Wardby; check
that the IdP client lists the mobile redirect URI. See
[Use the wardby mobile app](../mobile-app.md).
