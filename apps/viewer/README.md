# Wardby viewer (desktop)

A desktop app that shows what is running in a Wardby deployment as a live
graph: triggers, runs and sub-agent trees, turns and cost as they accrue,
outcomes (pull requests, comments, checks) and coding-run services. It is a
client of the read-only [admin viewer API](../../docs/viewer-api.md) and runs
no agents itself.

It is built with Tauri (a Rust core and a React UI). macOS is supported first.

## Prerequisites

- Node 24 (see `.nvmrc` at the repository root).
- Rust, installed with [rustup](https://rustup.rs). In a non-interactive shell,
  run `source ~/.cargo/env` first.
- Xcode Command Line Tools (`xcode-select --install`).

## Run it

Everything below runs in `apps/viewer`. The app has its own `package.json` and
lockfile and is not part of the server's build.

```sh
npm ci
npm run tauri dev
```

To build an application bundle:

```sh
npm run tauri build
```

Builds are not code signed or notarized. The first time you open one, use
right-click, then Open.

## Add a server and sign in

1. Choose to add a server and enter the server's canonical URI, for example
   `https://wardby.example.com`. That is the value of `MCP_CANONICAL_URI`, not
   a path such as `/mcp`. Plain `http` is accepted only for a loopback address
   such as `http://127.0.0.1:8080`.
2. Sign in. The app opens your system browser at the server's login page; the
   browser returns to a short-lived listener on `127.0.0.1` that the app opens
   for the duration of the sign-in.
3. The graph loads and then updates live.

The signed-in user needs the Wardby `admin` role, because the viewer API
requires the `admin:view` scope and only that role grants it. See
[Configure identity and privileged access](../../help/identity-and-access.md).

### Self-hosted sign-in

With `AUTH_PROVIDER=self-hosted` the app registers itself as a public client
automatically; no client id is needed. Create a user with the `admin` role and
a login key with `wardby auth` (see `wardby help auth`).

### External identity provider

With `AUTH_PROVIDER=delegating` the server does not offer client registration,
so register a public client with your identity provider and enter its client id
when adding the server. The client must:

- be a public client using the authorization code flow with PKCE (S256);
- have the loopback redirect URI `http://127.0.0.1/callback` (the app uses an
  available local port at sign-in time, and per RFC 8252 identity providers
  match everything except the port);
- be allowed to request the `admin:view` scope for the Wardby resource.

## Where tokens live

Tokens never reach the UI. The refresh token is stored in the macOS Keychain
(service `wardby-viewer`), one entry per server; the access token is held in
memory by the app's Rust core only. Signing out revokes the token at the server
where the server supports it and deletes the Keychain entry. The UI runs under
a strict content security policy with no network access of its own: all
requests go through the Rust core.

## Development

```sh
npm test               # UI tests
npm run lint
npm run format:check
npm run gen:types      # regenerate src/api/generated.ts
```

Run `npm run gen:types` when the server's viewer schemas change. It reads the
JSON Schemas in `src/viewer/schemas/` at the repository root (regenerated with
`npm run build:viewer-schemas` there); the app never imports server source.

Rust checks, in `apps/viewer/src-tauri`:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

### End-to-end check against a local server

`src-tauri/tests/e2e_local.rs` runs the app's real sign-in and streaming code
against a running server in self-hosted mode, scripting the browser's login and
consent steps over HTTP. It is ignored by default:

```sh
WARDBY_E2E_URL=http://127.0.0.1:8080 \
WARDBY_E2E_LOGIN_KEY=<login key of an admin user> \
  cargo test --test e2e_local -- --ignored
```

`WARDBY_E2E_URL` is the server's canonical URI. The test does not print tokens
or the login key.
