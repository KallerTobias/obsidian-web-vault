# obsidian-web-vault

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/kallertobias)

> [!WARNING]
> **This is a vibe-coding project.** It was built almost entirely by an AI coding agent ([Claude Code](https://claude.com/claude-code)) driven by a single person's requirements. A human made the product and security decisions and tested it, but did **not** review every line by hand. It ships with an extensive test suite and an automated security audit (see [How this was built](#how-this-was-built)), but no independent human audit. **Use it at your own risk, keep backups of your vault, and read the [security model](#security-model) before exposing it to the internet.**

> [!NOTE]
> Not affiliated with or endorsed by Obsidian or its makers. "Obsidian" is used only to describe the file format this app works with.

A self-hosted web app that edits an [Obsidian](https://obsidian.md) vault in the browser. It works directly on your folder of Markdown files, looks and behaves like Obsidian, and is protected by **passkeys only** (no passwords). One instance = one person = one vault.

Typical use: your vault lives on a server (synced with Syncthing, Git, or touched by AI agents) and you want to read and edit it from a machine where you cannot install Obsidian, e.g. a work laptop.

<!-- Screenshots: add images here (editor, graph, mobile). -->

## Features

- Three-column layout like Obsidian: file tree, search and tags on the left; tabbed notes in the middle; properties, backlinks, local graph and outline on the right. Sidebars collapse on phones.
- Live-preview editor (CodeMirror 6) with reading and source modes, auto-save, light and dark theme.
- Obsidian syntax: wikilinks (`[[Note#Heading]]`, `[[Note#^block]]`, aliases), embeds (`![[...]]`, images, PDF, audio, video), callouts, highlights, comments, footnotes, math (KaTeX), Mermaid, code highlighting, nested tags, frontmatter as properties (unchanged parts stay byte-identical).
- Obsidian-style link resolution, backlinks (linked and unlinked), rename/move with link updates.
- Full-text search with `path:`, `tag:`, `file:`, phrases and `-` exclusion; quick switcher (Ctrl/Cmd+O) and command palette (Ctrl/Cmd+P).
- Global and local graph view, switchable between **2D and 3D**, with filters, color groups and force settings.
- Templates, daily notes, paste/drag images into notes.
- Safe next to other writers (Syncthing, Obsidian, AI agents, Git): file watcher with live updates, atomic writes, and **no silent overwrite** - a save based on an outdated version is rejected and you get a conflict dialog.
- Delete moves files to `.trash/` inside the vault; nothing is removed permanently.
- UI in English, German, Spanish, French and Italian, selectable per device (see [Languages](#languages)).
- Single small Docker image (~240 MB, Alpine, runs unprivileged), `linux/amd64` and `linux/arm64`.

### Languages

The UI is available in **English, German, Spanish, French and Italian**. The language is chosen per device (stored in the browser) under Settings (gear icon, top right) or on the login screen. The default, *Automatic*, follows the browser language and falls back to English. Switching saves pending changes and reloads the page.

The UI language also names what the app creates: a new note is called `Untitled.md` in English and `Unbenannt.md` in German (likewise `Untitled folder` for new folders), just like Obsidian does it. Existing files are never renamed.

Translations are welcome: add a new file next to the existing packs in [`web/src/lib/i18n/`](web/src/lib/i18n/) (German, [`de.ts`](web/src/lib/i18n/de.ts), is the source of all strings and defines their shape) and register it in [`index.ts`](web/src/lib/i18n/index.ts).

## Setup guide

### What you need

- A Linux host with **Docker** and Docker Compose (any machine that can see your vault folder: home server, NAS, VPS).
- Your vault as a **folder on that host** (e.g. synced there with Syncthing, Git or Obsidian Sync via a desktop client).
- A **domain or subdomain** and a way to serve it over **HTTPS**: a reverse proxy (Caddy, nginx, Traefik) or a tunnel (Cloudflare Tunnel). Passkeys do not work over plain HTTP, except on `localhost`.
- A device with **passkey** support: a password manager (Proton Pass, 1Password, Bitwarden, ...), iCloud Keychain, Google Password Manager, Windows Hello or a security key. The device must be able to verify you (PIN, fingerprint or face).

### 1. Find out who owns your vault

The app writes files as a fixed user and group. Use the same IDs as the files already in your vault, otherwise Syncthing, Obsidian or other tools may no longer be able to change them:

```sh
ls -ln /path/to/your/vault | head
# -rw-rw-r-- 1 1000 1000  1234 Oct 21 10:00 Note.md
#              ^^^^ ^^^^  -> PUID=1000, PGID=1000
```

### 2. Create the compose file

```sh
mkdir -p ~/obsidian-web-vault && cd ~/obsidian-web-vault
curl -fsSLo compose.yml https://raw.githubusercontent.com/KallerTobias/obsidian-web-vault/main/compose.example.yml
```

Edit `compose.yml`:

- `PUBLIC_URL`: the exact HTTPS address you will open in the browser, e.g. `https://notes.example.com` (no trailing slash, no path).
- The vault volume: replace `/path/to/your/vault` with your vault folder.
- `PUID` / `PGID`: the IDs from step 1. Keep `UMASK: "002"` if other programs share the group.
- `ports`: keep the port bound to `127.0.0.1` (proxy on the same host) or to a private interface address (proxy or tunnel on another host in your network). Do **not** publish it on all interfaces: Docker-published ports bypass host firewalls such as UFW.

### 3. Start it

```sh
docker compose up -d
docker compose logs obsidian-web-vault
```

The log shows `Vault indiziert` with the number of indexed files and the user/group in use, and a one-time **setup link** like `https://notes.example.com/setup#...`. If the container exits instead, the log tells you why (most often: vault not readable/writable for `PUID:PGID`).

Check it locally: `curl -s http://127.0.0.1:8080/api/health` should print `{"ok":true}`.

### 4. Put HTTPS in front

Pick one of the [reverse proxy and tunnel examples](#reverse-proxy-and-tunnel-examples) below and point your domain at the container. Then open `https://notes.example.com/api/health` in a browser; it must show `{"ok":true}`.

Do not put an additional login (Cloudflare Access, Authelia, basic auth) in front: the passkey login is the authentication, and an extra login page breaks the app's API calls and live updates.

### 5. Register your first passkey

Open the setup link from the log **in the browser, via your HTTPS address**. It is valid for 60 minutes and can be used once. Choose where to store the passkey (password manager, phone, security key) and confirm with PIN or biometrics. You are now signed in.

Link expired? Create a new one:

```sh
docker exec obsidian-web-vault obsidian-web-vault setup-link
```

To use the app on more devices, either store the passkey in a password manager that syncs (e.g. Proton Pass or 1Password on phone and laptop), or add more passkeys in **Settings** (needs a confirmation with an existing passkey first).

### 6. Tell your sync tools about the app

The app writes notes atomically via hidden temp files (`.<name>.<random>.vwtmp`) and moves deleted files to `.trash/`. Exclude both from sync and version control:

- Syncthing `.stignore`: `.*.vwtmp` and `.trash`
- `.gitignore` (if your vault is a Git repository): `.*.vwtmp` and `.trash/`

### 7. Optional: set `TRUST_PROXY`

Behind a proxy or tunnel, every request seems to come from the proxy, so all clients share one login rate limit. Set `TRUST_PROXY` (and `TRUST_CF_CONNECTING_IP` for Cloudflare) as described in the [proxy section](#reverse-proxy-and-tunnel-examples) so the real client IP is used. Restart with `docker compose up -d`.

## HTTPS is mandatory

WebAuthn passkeys only work in a secure context. Serve obsidian-web-vault over HTTPS through a reverse proxy or tunnel; the only exception is `http://localhost` (also `127.0.0.1`, `[::1]`), which is fine for trying it out. The app itself does not terminate TLS.

`PUBLIC_URL` must match the origin in the browser **exactly** (scheme, host, port). Passkeys are bound to its domain: if you later change the domain, existing passkeys stop working and you need a new setup link. The session cookie is `Secure`, and every state-changing request must carry an `Origin` equal to `PUBLIC_URL`. If you open the app under another address (e.g. `http://127.0.0.1:8080` while `PUBLIC_URL` is `http://localhost:8080`), the login and setup pages show a notice with a link to the configured address instead of the passkey button.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PUBLIC_URL` | - (required) | Public origin, e.g. `https://vault.example.com`. Must be `https://` (`http://` only for localhost). Its host is the passkey relying-party ID. |
| `PORT` | `8080` | Port the server listens on inside the container. |
| `HOST` | `0.0.0.0` | Address to bind to. |
| `VAULT_DIR` | `/vault` | Vault folder. Mount your vault here. |
| `DATA_DIR` | `/data` | App state (passkeys, sessions, settings). Keep it out of the vault. |
| `PUID` / `PGID` | `1000` / `1000` | User and group ID the app runs as (never root). |
| `UMASK` | `002` | Octal umask for created files. `002` gives `664`/`775`. |
| `SESSION_DAYS` | `14` | Sliding session lifetime in days. |
| `TRUST_PROXY` | `false` | `false`, `true`, a number of proxy hops, or a comma-separated list of proxy IPs/CIDRs. Controls whether `X-Forwarded-*` is trusted (used for the client IP in rate limiting). |
| `TRUST_CF_CONNECTING_IP` | `false` | `true` only behind Cloudflare (Tunnel or proxy): take the client IP from `CF-Connecting-IP`. Requires `TRUST_PROXY`. Leave it `false` behind any other proxy, otherwise clients can choose their own rate-limit key with that header. |
| `EXCLUDE_PATHS` | empty | Comma-separated globs of paths invisible to the app (index, search, graph, links). |
| `READONLY_PATHS` | empty | Comma-separated globs of paths that are visible but cannot be edited. |
| `TZ` | `UTC` | Time zone (standard container variable). Used for timestamps in names of pasted images (`Pasted image YYYYMMDDHHmmss.png`). |

Dotfiles and dot-folders (`.git`, `.obsidian`, `.stfolder`, `.trash`, ...) are never shown, indexed or written; the only exception is `.trash/` as the target when deleting. In-app settings (attachment folder, templates, daily notes, theme, graph) are stored in `/data`, not in the vault.

### File ownership

The container runs as `PUID:PGID` and applies `UMASK`, so new files belong to the same user as your other writers. **Set `PUID`/`PGID` to the owner of your vault files** (see `ls -ln`; the defaults `1000`/`1000` are only a guess) and keep `UMASK=002` when others share the group, e.g. Syncthing or agents. On start only `/data` is `chown`ed, **never** `/vault`. The server refuses to start (non-zero exit, clear message in the log) if `VAULT_DIR` is missing, not a folder, or not readable and writable for `PUID:PGID`; files it cannot read later are logged once each (`Datei nicht lesbar, nicht im Index`) instead of silently missing from search. The start log line `Vault indiziert` shows the number of indexed files and the uid/gid.

Writes are atomic: the new content goes to a hidden temp file `.<name>.<random>.vwtmp` in the same folder and is then renamed over the note. Temp files left behind by a crash are removed on the next start (only this pattern, only when older than one hour). Syncthing does sync dotfiles, so add the temp files and the trash to your ignore rules, e.g. in `.stignore`:

```
.*.vwtmp
.trash
```

(and `.trash/` in `.gitignore` if the vault is a Git repository).

Notes that are not valid UTF-8 (e.g. Latin-1 files written by a script) are indexed for search, but the editor refuses to open them (HTTP 415) so saving can never re-encode them; they can still be downloaded as files. Convert them to UTF-8 to edit them in the app.

## Recovery and CLI

If you lose all passkeys, create a new one-time setup link (valid 60 minutes) on the host:

```sh
docker exec obsidian-web-vault obsidian-web-vault setup-link
docker exec -it obsidian-web-vault obsidian-web-vault reset-passkeys   # needs -it: asks "Alle Passkeys löschen? (ja/nein)", answer exactly `ja`
```

`reset-passkeys` removes all passkeys and sessions, then prints a setup link. The setup link is also printed in the container log on start, but only while no passkey exists.

Anyone with access to the Docker host has access to the vault anyway. Additional passkeys can be added from Settings once signed in (after confirming with an existing passkey); sessions can be listed and revoked there.

## Reverse proxy and tunnel examples

All examples assume obsidian-web-vault listens on `127.0.0.1:8080` and `PUBLIC_URL=https://vault.example.com`.

When you set `TRUST_PROXY`, the proxy **must overwrite** `X-Forwarded-For` and **strip** `CF-Connecting-IP` coming from clients; otherwise anyone can fake their IP and dodge the login rate limit. Only trust proxies you control (use the hop count or CIDR form to be exact). `CF-Connecting-IP` is only read with `TRUST_CF_CONNECTING_IP=true` (Cloudflare only); stripping it at your proxy is a second line of defence.

**Caddy**

```caddyfile
vault.example.com {
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-For {remote_host}   # overwrite, never pass client values on
        header_up -CF-Connecting-IP
    }
}
```

(Use `TRUST_PROXY=1` or Caddy's address.)

**nginx**

```nginx
server {
    listen 443 ssl;
    server_name vault.example.com;
    # ssl_certificate ... ssl_certificate_key ...
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, never append client values
        proxy_set_header CF-Connecting-IP "";            # strip a client-supplied header
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;                             # live updates (SSE)
        proxy_read_timeout 1h;
    }
}
```

**Traefik** (labels, Docker provider)

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.vault.rule=Host(`vault.example.com`)
  - traefik.http.routers.vault.entrypoints=websecure
  - traefik.http.routers.vault.tls.certresolver=letsencrypt
  - traefik.http.services.vault.loadbalancer.server.port=8080
  - traefik.http.routers.vault.middlewares=vault-strip
  - traefik.http.middlewares.vault-strip.headers.customrequestheaders.CF-Connecting-IP=
```

(An empty value removes the header. Traefik replaces a client's `X-Forwarded-For` unless its entry point trusts forwarded headers, so do not enable `forwardedHeaders.insecure`.)

**Cloudflare Tunnel**

`cloudflared` can run on any host that can reach the container, for example on another machine in your network. Create a public hostname in the tunnel configuration and point it at `http://<host>:<port>` (the address where obsidian-web-vault is reachable from the `cloudflared` host). Do not put Cloudflare Access in front: passkey login is the authentication, and an extra login page breaks the app's API calls. Cloudflare passes the real client IP in `CF-Connecting-IP`; obsidian-web-vault reads that header **only with `TRUST_CF_CONNECTING_IP=true` and `TRUST_PROXY` set**. Without them every client looks like the tunnel and the rate limit is shared. Set `TRUST_CF_CONNECTING_IP=true` and `TRUST_PROXY` to match your path: if `cloudflared` runs on the same host or Docker network, use that network's CIDR (e.g. `TRUST_PROXY=172.18.0.0/16`) or one hop (`TRUST_PROXY=1`); if it runs on another host, use that host's IP (e.g. `TRUST_PROXY=10.0.0.5`). Never use `true` when the app port is reachable by anyone other than the tunnel.

## Security model

- **Single user, single vault.** There are no roles inside the vault.
- **Passkeys only** (WebAuthn, discoverable credentials); no passwords. **User verification is required** for every ceremony (the device's PIN, fingerprint or face, not just a tap). The first passkey can only be registered with the one-time setup link from the container log (60 minutes, single use).
- **Adding another passkey** in Settings needs a fresh confirmation with an existing passkey first (step-up within the same session, valid 5 minutes, one new passkey per confirmation). A stolen session cookie alone cannot add an attacker's passkey. If all passkeys are lost, the CLI setup link remains the recovery path.
- **Sessions:** cookie `__Host-vw_session` over https (`vw_session` on `http://localhost`, where browsers do not keep `__Host-` cookies reliably), `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`; sliding expiry (`SESSION_DAYS`); list and revoke sessions in the app. A cookie of the old name `vw_session` from before the switch is accepted once and replaced.
- Login, setup and the step-up are rate limited per client IP (10 per minute); at most 20 open WebAuthn challenges per client, so one client cannot push out another's login. At most 10 open live-update streams per session. Uploads (max. 50 MB) are streamed to disk, not held in memory.
- Every route except `/api/auth/*`, `/api/health` and the app's static assets requires a valid session - including images and attachments.
- State-changing requests require a matching `Origin` (CSRF); login endpoints are rate limited.
- Strict Content-Security-Policy without `unsafe-eval` and without inline scripts; `X-Content-Type-Options: nosniff`, frame denial.
- **Note content is untrusted** (it is synced from other devices and agents): rendered Markdown is always sanitised, raw HTML is limited to a small attribute-free subset, external links allow only `http`, `https` and `mailto`, and Mermaid runs in strict mode.
- Paths are normalised and confined to the vault; symlinks pointing outside it are not followed.
- Deliberate exceptions to common hardening advice:
  - Attachments live inside the vault on the app origin and keep their names, so Obsidian, Syncthing and links keep working. Mitigation: session required, `nosniff`, `Content-Disposition: attachment` for everything except images/PDF/audio/video, SVG served with `Content-Security-Policy: sandbox`, name validation.
  - PDF responses may be framed by the app itself (`frame-ancestors 'self'`); everything else uses `'none'`.
  - The session cookie is `SameSite=Strict` (stricter than Lax) plus the Origin check.

## Non-goals

- Obsidian community plugins, Dataview, Canvas, Obsidian Sync/Publish.
- Multiple users or per-folder permissions; multiple vaults per instance.
- TLS or port management (use a proxy or tunnel).
- Built-in Git commits; offline mode / PWA sync.

## Updating

```sh
docker compose pull
docker compose up -d
```

Passkeys, sessions and settings live in the `/data` volume and survive updates. Pin a version tag (e.g. `ghcr.io/kallertobias/obsidian-web-vault:1.0.1-beta`) instead of `latest` if you want to update deliberately.

## Backups

- **Your vault** is ordinary files; back it up as you already do (the app never deletes permanently; deleted notes go to `.trash/`). Versioning the vault with Git is a good safety net when several tools write to it.
- **The `/data` volume** holds passkeys, sessions and app settings. Losing it is not a disaster: create a new setup link and register a new passkey.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Container exits right after start | Read `docker compose logs`. Usually the vault path is wrong or not readable/writable for `PUID:PGID` (step 1). |
| No passkey offered, or "Request from a foreign origin rejected" (German UI: "Anfrage von fremder Herkunft abgelehnt") | You opened the app under a different address than `PUBLIC_URL` (e.g. an IP address instead of the domain, or `127.0.0.1` instead of `localhost`). The app shows a notice with a link to the right address. |
| Passkey dialog fails on plain `http://` | Passkeys need HTTPS (except `localhost`). Use the HTTPS address. |
| "Too many attempts" (HTTP 429; German UI: "Zu viele Versuche") on login | Rate limit (10 per minute per client IP). Behind a proxy without `TRUST_PROXY`, all users share one IP; see step 7. |
| Changed the domain, passkeys stopped working | Passkeys are bound to the domain. Run `docker exec -it obsidian-web-vault obsidian-web-vault reset-passkeys` and register again. |
| Notes missing in search, log shows `Datei nicht lesbar` ("file not readable"; server logs are in German) | File permissions: those files are not readable for `PUID:PGID`. |
| A note shows "This file is not UTF-8 encoded" (German UI: "Diese Datei ist nicht UTF-8-kodiert") | The file is not valid UTF-8; the app refuses to edit it so it can never be re-encoded. Convert it to UTF-8. |
| Live updates do not arrive | Your proxy buffers responses. Disable buffering for the app (see the nginx example). |
| Lost all passkeys | `docker exec obsidian-web-vault obsidian-web-vault setup-link` on the host. |


## Development

```sh
npm ci
npm run dev          # server + Vite dev server
npm test             # unit tests
npm run typecheck && npm run check:svelte
npm run build        # dist/web + dist/server.js
npm run e2e:local    # Playwright end-to-end tests
```

## How this was built

This project is an experiment in "vibe coding": building a complete, security-sensitive app with an AI agent doing the implementation.

- **Agent:** [Claude Code](https://claude.com/claude-code) (Claude Opus), using the [superpowers](https://github.com/obra/superpowers) workflow: brainstorming → written design spec → 28-task implementation plan → *subagent-driven development*, where for every task one agent implements (test-first) and separate agents review spec compliance and code quality, with fix rounds until the review is clean.
- **Human role:** requirements, product and security decisions (e.g. require user verification, require a fresh passkey confirmation before adding another passkey), manual testing in the browser, deployment.
- **Verification:** ~900 unit and integration tests (Vitest), 30 end-to-end browser tests (Playwright), a final whole-branch review, and a security audit with [vibe-check](https://github.com/benavlabs/vibe-check) (17 categories plus a live scan). All findings of that audit were fixed; the reports are in [`security/`](security/AUDIT_SUMMARY.md) and reflect the state *before* the fixes.
- **Rules for agents:** [`AGENTS.md`](AGENTS.md) holds the security rules every coding agent must follow in this repository (based on vibe-check's rule set, MIT) plus the project-specific exceptions and their mitigations.

If you find a bug or a security issue, please open an issue (for security issues, see [SECURITY.md](SECURITY.md)).

## Support

If this project is useful to you, you can support it:

[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20me%20a%20coffee-FFDD00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/kallertobias)

- give it a star on GitHub,
- report bugs and send pull requests (an English UI translation would be great).

## License

[MIT](LICENSE) © 2026 Tobias Kaller
