# ZTO (Zero to One)

> From zero — to the one where your app meets its first fan.
> 아무것도 없는 0에서, 앱이 세상에 나가 첫 팬을 만나는 1까지.

**The solo founder's management desk.** Every new app you ship piles on more to
manage — accounts, both app stores, promo posts. ZTO is a desktop app (macOS)
that keeps all of it in one place, with an AI that knows your history.

![ZTO — pull live store status, stage listing edits, apply them behind a two-step confirm](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/hero.gif)

- **App Store Manager** — live status of Google Play and App Store Connect on
  one screen. Stage listing/asset/IAP edits, confirm once, apply in one batch.
  What has no API opens in a guided in-app console with an AI copilot beside it.
- **Account Inventory** — every account, its purpose, and the services it's
  connected to, at a glance. Passwords live **only in the OS keychain** —
  viewing one passes Touch ID, nothing ever leaves this computer.
- **Social Media Manager** — an embedded browser you log into directly, with an
  AI panel that reads the page only when you flip the switch.

🌐 **Website**: <https://zto-umber.vercel.app>

---

## A look inside

| | |
|---|---|
| **Both stores, one screen**<br>What's already done lights up; you jump to the console only where hands are needed.<br>![App Store Manager](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/screenshot-app-store-manager.png) | **Nothing goes out unconfirmed**<br>Edits are staged against live store values and applied in one confirmed batch.<br>![Two-step confirm](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/screenshot-two-step-confirm.png) |
| **Every account, and what it's for**<br>Accounts aren't a burden when each one's reason to exist is written down.<br>![Account Inventory](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/screenshot-account-inventory.png) | **Passwords stay on your machine**<br>Stored in the OS keychain; every reveal passes Touch ID.<br>![Touch ID](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/screenshot-touch-id.png) |

**Social Media** — an embedded browser you log into yourself, with an AI panel that reads the page only when you flip the switch.

![Social Media](https://github.com/DanialDaeHyunNam/zto/releases/download/v0.1.5/screenshot-social-media.png)

---

## Get ZTO

Two ways — both run the same code:

| | |
|---|---|
| **Buy the official build — $5, one-time** | Signed & notarized by Apple, automatic updates, runs with a double-click. [zto-umber.vercel.app](https://zto-umber.vercel.app) |
| **Build it yourself — free** | Clone this repo and follow [Development](#development). No license key needed for your own builds. |

The source is open (Apache-2.0) so you can verify what ZTO does with your accounts and
passwords. The $5 is for the signature, the updates, and the convenience — see
[LICENSE.md](LICENSE.md).

---

## Where your data lives

All of it on this computer. ZTO has no server.

| What | Where |
|---|---|
| Account notes · app sheets · store snapshots | `~/Library/Application Support/ZTO/` — official builds<br>`~/Library/Application Support/ZTO-dev/` — builds you made yourself, so the two never share a folder |
| Password **encryption key** | OS keychain (macOS Keychain) |
| Password ciphertext | `zto-secrets.json` in the same folder — unreadable without the key |
| AI conversations | Sent directly to the provider you configured. CLI-subscription mode never leaves this computer |

Every password reveal passes Touch ID; copied values are wiped from the
clipboard after 30 seconds. The full policy — including its limits — is shown
inside the app under **Account Inventory → Security**.

Because it's all local, **deleting the app does not delete your data.** To erase
it, use **Settings → Your data → Delete all local data** (the app also shows the
one command that removes the keychain entry).

For screenshots or experiments, run against a throwaway data folder instead of
your real one:

```bash
npm run demo:profile            # launches the installed app on a sandbox profile
npm run demo:profile -- --dev   # seed the profile `npm run dev` uses
```

---

## Development

**Node 22.12** required (pinned via `.tool-versions`, asdf).

```bash
npm install
npm run dev          # run in development
npm run typecheck
npm run build
```

⚠️ Changes under `src/main/` and `src/preload/` do **not** hot-reload —
restart the dev server, or you get a new renderer talking to a stale main
(blank-screen class of bugs).

### Packaging your own build

```bash
npm run dist:mac     # dmg + zip (arm64 · x64) — unsigned is fine for personal use
```

Signing/notarization (only needed if you want Gatekeeper-clean builds of your
own) uses a Developer ID certificate in your keychain plus an App Store
Connect API key:

```bash
export APPLE_API_KEY="/path/to/AuthKey_XXXXXXXXXX.p8"
export APPLE_API_KEY_ID="XXXXXXXXXX"
export APPLE_API_ISSUER="<issuer-uuid>"
npm run dist:mac
```

---

## License

Open source under [Apache 2.0](LICENSE.md). Build it yourself and it's free —
no license key, ever. The signed official builds sold on the
[website](https://zto-umber.vercel.app) are licensed separately (that's what
the $5 pays for: the Apple signature, notarization, and auto-updates).

Technical design lives in [`SPEC.md`](SPEC.md), the build order in
[`ROADMAP.md`](ROADMAP.md).
