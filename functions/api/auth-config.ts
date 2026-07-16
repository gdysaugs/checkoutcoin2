type Env = {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

export const onRequestOptions: PagesFunction<Env> = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  })

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  const url = String(env.SUPABASE_URL ?? '').trim()
  const anonKey = String(env.SUPABASE_ANON_KEY ?? '').trim()
  if (!url || !anonKey) {
    return jsonResponse({ error: 'Authentication is not configured.' }, 503)
  }
  return jsonResponse({ url, anonKey })
}
