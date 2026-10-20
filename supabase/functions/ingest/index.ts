import { createClient } from 'npm:@supabase/supabase-js@2'

// Service role key is injected automatically into edge functions; it bypasses RLS
const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
)

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 })

  if (req.headers.get('x-ingest-secret') !== Deno.env.get('INGEST_SECRET')) {
    return new Response('unauthorized', { status: 401 })
  }

  let body
  try {
    body = await req.json()
  } catch {
    return new Response('bad json', { status: 400 })
  }

  const { id, group_id, sender, text, sent_at } = body
  if (!id || !group_id || !text || !sent_at) {
    return new Response('missing fields', { status: 400 })
  }

  const { error } = await supabase
    .from('raw_messages')
    .upsert({ id, group_id, sender, text, sent_at }, { onConflict: 'id', ignoreDuplicates: true })

  if (error) {
    console.error(error)
    return new Response(error.message, { status: 500 })
  }
  return new Response('ok', { status: 200 })
})
