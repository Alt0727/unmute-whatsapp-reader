# Unmute: WhatsApp group reader

College announcements get lost in busy WhatsApp groups. Unmute turns them into a planner of deadlines, events and opportunities. This repo is the first piece: a bot that **joins WhatsApp groups from invite links and streams their text messages into Supabase**.

> **About this repo.** This is **not** the codebase we will use at the hackathon. It only shows the progress we made on the WhatsApp reader before the event, so you can see that the hardest integration already works. At the hackathon this code will be reused in a new repo, with the changes it needs to fit there. The AI that turns messages into planner cards and the app itself will be built during the event.

<!-- Demo: add docs/demo.gif or screenshots here (terminal: connected → joined → ingested, plus the Supabase rows) -->

## How it works

```
 invite link ──► group_invites (status: pending)
                      │  Supabase Realtime
                      ▼
 listener/index.js  (Baileys = a linked device on a WhatsApp account)
   • joins the group, marks the row joined
   • forwards every text message from joined groups
                      │  POST + x-ingest-secret header
                      ▼
 supabase/functions/ingest  (edge function = ingest endpoint)
   • rejects bad secret / bad body
   • upserts on WhatsApp message id → no duplicates
                      ▼
                 raw_messages
```

## What works today

- **Pairing that sticks:** scan a QR once, and the session survives restarts.
- **Self-healing connection:** it reconnects automatically after network drops. If the account is logged out, it wipes the dead session and shows a fresh QR.
- **Join by link:** inserting an invite link into `group_invites` makes the bot join within seconds. Links added while the bot was offline get joined on the next connect. Each row is claimed atomically, so it is never joined twice.
- **Only groups added by link:** it reads every text message in groups that were added through an invite link. The account's other chats and groups are ignored. Media without text is skipped.
- **No display names:** senders' WhatsApp display names are never stored.
- **Idempotent ingest:** each WhatsApp message id is stored at most once.
- **Fails soft:** a failed POST is logged and the listener keeps running.

## Run it

1. **Supabase:** in the SQL Editor, run [`supabase/schema.sql`](supabase/schema.sql).
2. **Secret:** generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Add it as `INGEST_SECRET` under Edge Functions → Secrets.
3. **Edge function:** deploy [`supabase/functions/ingest/index.ts`](supabase/functions/ingest/index.ts) as `ingest`, then turn **Enforce JWT verification** off. The secret header protects it instead.
4. **Listener:** `cd listener && npm install`, then copy `.env.example` to `.env` and fill it in. `SUPABASE_SERVICE_ROLE_KEY` is the secret key, not the publishable one.
5. **Start:** run `npm start` and scan the QR from WhatsApp → Linked devices. You should see `connected`.
6. **Add a group:** `insert into group_invites (invite_link) values ('https://chat.whatsapp.com/<code>');` The terminal prints `joined <group>`. Send a message in the group and you get `ingested <id>` plus a new row in `raw_messages`.

`listener/auth/` holds the WhatsApp session and `.env` holds the keys. Both are gitignored, so never commit them.

## Authorship

Written by the Unmute team before the event using [Baileys](https://baileys.wiki/). No other people contributed. Built with help from [Claude Code](https://claude.com/claude-code).

## Note

This uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web client, which is fine for a prototype. A production version would run on a dedicated number or move to the official WhatsApp Business API.
