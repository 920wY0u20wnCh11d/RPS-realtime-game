# 8-Bit RPS Realtime Crypto-Wager (Vercel + Pusher)

Vanilla ES6 single-page app with Vercel serverless APIs and Pusher presence channels.

## Features

- 2-32 players in one room (`presence-rps-ROOMCODE`)
- Host-driven synchronized 10s countdown (`client-timer`)
- Early round close when all active players submit
- Multiplayer outcome rules:
  - 1 unique move OR all 3 unique moves => tie (re-roll)
  - 2 unique moves => dominant move wins
- Wager debt lifecycle with 50% dismissal threshold (`ceil(N/2)`)
- Net-score leaderboard: `wins - losses`
- Append-only local crypto hash chain (`SHA-256`) with ECDSA move signatures
- Peer head-hash exchange and mismatch warning
- Automatic checkpoint pruning of settled debt blocks
- Retro pixel-art mobile-first UI (`max-width: 520px`)

## Project Layout

- `index.html` - SPA shell
- `styles.css` - pixel-art responsive UI
- `app.js` - game logic, pusher client, crypto ledger
- `api/create-room.js` - host room creation
- `api/join-room.js` - guest join token issue
- `api/pusher-auth.js` - presence auth
- `api/public-config.js` - exposes public pusher values
- `api/_shared.js` - shared helpers and room token signing

## Environment

Copy `.env.example` to `.env.local` and set:

- `PUSHER_APP_ID`
- `PUSHER_KEY`
- `PUSHER_SECRET`
- `PUSHER_CLUSTER`
- `ROOM_SIGNING_SECRET`

## Local Run

```bash
npm install
npm run dev
```

Then open the URL shown by `vercel dev`.

## Deploy

1. Push repo to Git provider.
2. Import project in Vercel.
3. Add env vars from `.env.example` in Vercel Project Settings.
4. Deploy.

### Deploy Troubleshooting

- If deploy fails with `Function Runtimes must have a valid version`, remove custom `runtime` entries from `vercel.json` unless you are intentionally pinning a versioned runtime package (for example, `@vercel/node@x.y.z`).
- For this project, let Vercel auto-detect Node serverless runtime and only keep safe function options such as `maxDuration`.
- GitHub Actions guard: `.github/workflows/vercel-config-guard.yml` runs `npm run check:vercel-config` on every push/PR to catch invalid runtime declarations before deploy.

## Event Contracts

- `client-round-start`: `{ roundId, deadline, active }`
- `client-timer`: `{ roundId, remain }`
- `client-move`: `{ roundId, pid, m, a, s, pk }`
- `client-round-end`: `{ roundId, tie, u, w, l, submissions, debts, scores }`
- `client-debt-confirm`: `{ id, by, ts }`
- `client-ledger-head`: `{ pid, head, len }`

## Notes

- Room existence is ephemeral and enforced through Pusher subscription/auth plus 4-digit format, which fits serverless constraints without durable DB.
- Ledger is client-local (`localStorage`), compact, and pruned through cryptographic checkpointing to avoid growth toward browser limits.
# RPS-realtime-game
