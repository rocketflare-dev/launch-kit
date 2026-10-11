/**
 * The app's relying-party paths: where an OIDC sign-in returns to and where a sign-out lands.
 * `launch.kit.json` → `launchProvides.oidc.callbackPath` / `signedOutPath` declare the same two
 * values, and Launch registers `{environment url}{path}` as the OIDC client's redirect URI and
 * post-logout redirect URI. Change a path here and in the manifest in the same commit, or sign-in
 * fails with "The address this app asked Launch to return to is not one it registered".
 *
 * Both are paths on the app's own origin: one leading `/`, no scheme, host, whitespace or `#`.
 * No imports: the UI bundle reads this file too.
 */

/** The route that completes sign-in; also the `redirect_uri` the app sends the issuer. */
export const OIDC_CALLBACK_PATH = '/auth/callback'

/**
 * Where a sign-out lands. The app does no RP-initiated logout (it never calls the issuer's
 * `end_session_endpoint`): `POST /auth/logout` ends the app's own session and the UI goes here.
 */
export const OIDC_SIGNED_OUT_PATH = '/'
