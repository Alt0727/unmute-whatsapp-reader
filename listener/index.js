import makeWASocket, { useMultiFileAuthState, DisconnectReason, normalizeMessageContent } from 'baileys'
import qrcode from 'qrcode-terminal'
import pino from 'pino'
import { rmSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Service key (not anon): the bot must update invite rows, which anon policies don't allow
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

let sock              // always points at the current socket, even after reconnects
let connected = false // only try joining while WhatsApp is actually connected

// Only groups added via the invite flow get ingested; the account's other (personal) groups are ignored
const watchedGroups = new Set()

async function loadWatchedGroups() {
  const { data, error } = await supabase.from('group_invites').select('group_id').eq('status', 'joined')
  if (error) return console.error('watched groups fetch failed:', error.message)
  watchedGroups.clear()
  for (const row of data) watchedGroups.add(row.group_id)
  console.log('watching', watchedGroups.size, 'group(s):', [...watchedGroups].join(', ') || '(none)')
}

const INVITE_RE = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]+)/

// Text lives in different fields depending on message type; unwrap ephemeral/view-once first
function getText(m) {
  const msg = normalizeMessageContent(m.message)
  return msg?.conversation ?? msg?.extendedTextMessage?.text ?? null
}

// A failed POST is logged, never thrown, so the listener keeps running
async function sendToSupabase(payload) {
  try {
    const res = await fetch(process.env.INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ingest-secret': process.env.INGEST_SECRET,
      },
      body: JSON.stringify(payload),
    })
    if (!res.ok) console.error('ingest failed', res.status, await res.text())
    else console.log('ingested', payload.id)
  } catch (err) {
    console.error('ingest error', err.message)
  }
}

async function start() {
  // Loads saved creds from ./auth (or creates them on the first run)
  const { state, saveCreds } = await useMultiFileAuthState('auth')

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  })

  // Whenever WhatsApp rotates keys, write them to disk
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'close') {
      connected = false
      const statusCode = lastDisconnect?.error?.output?.statusCode
      const loggedOut = statusCode === DisconnectReason.loggedOut
      console.log('connection closed, status:', statusCode, loggedOut ? '(logged out, clearing session)' : '(reconnecting)')
      // A logged-out session can never work again: wipe it so the next start() shows a fresh QR
      if (loggedOut) rmSync('auth', { recursive: true, force: true })
      start()
    }

    if (connection === 'open') {
      connected = true
      console.log('connected')
      sock.groupFetchAllParticipating().then((groups) => {
        for (const g of Object.values(groups)) console.log('in group:', g.id, '→', g.subject)
      })
      loadWatchedGroups().then(processPending)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return // skip history sync

    for (const m of messages) {
      // fromMe is NOT skipped: the linked account is a real member, so its own messages count too
      if (!watchedGroups.has(m.key.remoteJid)) continue

      const text = getText(m)
      if (!text) continue

      await sendToSupabase({
        id: m.key.id,
        group_id: m.key.remoteJid,
        // v7: participant is often an @lid privacy id; participantAlt has the phone JID when known
        sender: m.key.participantAlt ?? m.key.participant,
        text,
        sent_at: new Date(Number(m.messageTimestamp) * 1000).toISOString(),
      })
    }
  })
}

async function markFailed(id, error) {
  await supabase.from('group_invites').update({ status: 'failed', error }).eq('id', id)
  console.log('invite failed:', error)
}

async function joinInvite(row) {
  // Claim the row: only succeeds if it's still pending, so it never gets joined twice
  const { data: claimed, error } = await supabase
    .from('group_invites')
    .update({ status: 'joining' })
    .eq('id', row.id)
    .eq('status', 'pending')
    .select()
  if (error) return console.error('claim failed:', error.message)
  if (!claimed?.length) return

  const code = row.invite_link.match(INVITE_RE)?.[1]
  if (!code) return markFailed(row.id, 'invalid link')

  try {
    const jid = await sock.groupAcceptInvite(code)
    if (!jid) return markFailed(row.id, 'join request sent, needs admin approval')

    const meta = await sock.groupMetadata(jid)
    await supabase
      .from('group_invites')
      .update({ status: 'joined', group_id: jid, group_name: meta.subject })
      .eq('id', row.id)
    watchedGroups.add(jid)
    console.log('joined', meta.subject, jid)
  } catch (err) {
    await markFailed(row.id, err.message)
  }
}

// Links submitted while the bot was offline are still pending, so catch up on connect
async function processPending() {
  const { data, error } = await supabase
    .from('group_invites')
    .select('*')
    .eq('status', 'pending')
    .order('created_at')
  if (error) return console.error('pending fetch failed:', error.message)
  for (const row of data) await joinInvite(row)
}

supabase
  .channel('invites')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'group_invites' }, (payload) => {
    if (connected) joinInvite(payload.new)
  })
  .subscribe((status) => console.log('realtime:', status))

start()
