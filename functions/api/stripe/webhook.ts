type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

const PRICE_MAP = new Map([
  ['price_1TtiRhPTbJYcrwd4gUPksklj', { label: '50枚パック', tickets: 50 }],
  ['price_1TtiRwPTbJYcrwd4tWdMtjMJ', { label: '110枚パック', tickets: 110 }],
  ['price_1TtiS9PTbJYcrwd4iwcNfZNI', { label: '230枚パック', tickets: 230 }],
])

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })

const textEncoder = new TextEncoder()
const SIGNATURE_TOLERANCE_SECONDS = 300

const toHex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')

const timingSafeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}

const verifyStripeSignature = async (payload: string, signature: string, secret: string) => {
  const parts = signature.split(',').map((part) => part.trim())
  const timestampPart = parts.find((part) => part.startsWith('t='))
  const signatures = parts.filter((part) => part.startsWith('v1='))
  if (!timestampPart || signatures.length === 0) return false

  const timestamp = timestampPart.slice(2)
  const timestampSeconds = Number(timestamp)
  if (!Number.isFinite(timestampSeconds)) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > SIGNATURE_TOLERANCE_SECONDS) return false

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const digest = await crypto.subtle.sign('HMAC', key, textEncoder.encode(`${timestamp}.${payload}`))
  const expected = toHex(digest)
  return signatures.some((part) => timingSafeEqual(part.slice(3), expected))
}

const getSupabaseConfig = (env: Env) => {
  const url = String(env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  return url && serviceKey ? { url, serviceKey } : null
}

const supabaseHeaders = (serviceKey: string) => ({
  Authorization: `Bearer ${serviceKey}`,
  apikey: serviceKey,
  'Content-Type': 'application/json',
})

const userExists = async (url: string, serviceKey: string, userId: string) => {
  const response = await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    headers: supabaseHeaders(serviceKey),
  })
  return response.ok
}

const grantTickets = async (
  url: string,
  serviceKey: string,
  payload: Record<string, unknown>,
) => {
  const response = await fetch(`${url}/rest/v1/rpc/grant_tickets`, {
    method: 'POST',
    headers: { ...supabaseHeaders(serviceKey), Accept: 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await response.text()
  let data: any = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  return { response, data, text }
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Stripe-Signature',
    },
  })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const webhookSecret = String(env.STRIPE_WEBHOOK_SECRET ?? '').trim()
  if (!webhookSecret) return jsonResponse({ error: 'Webhook is not configured.' }, 500)

  const body = await request.text()
  const signature = request.headers.get('stripe-signature') || ''
  if (!(await verifyStripeSignature(body, signature, webhookSecret))) {
    return jsonResponse({ error: 'Invalid signature.' }, 401)
  }

  let event: any = null
  try {
    event = body ? JSON.parse(body) : null
  } catch {
    return jsonResponse({ error: 'Invalid event payload.' }, 400)
  }
  if (!event?.type) return jsonResponse({ error: 'Invalid event payload.' }, 400)
  if (event.type !== 'checkout.session.completed') return jsonResponse({ received: true })

  const session = event.data?.object ?? {}
  if (session.payment_status && session.payment_status !== 'paid') return jsonResponse({ received: true })
  if (String(session.metadata?.app ?? '') !== 'crownai') return jsonResponse({ received: true })

  const priceId = String(session.metadata?.price_id ?? '')
  const plan = PRICE_MAP.get(priceId)
  if (!priceId || !plan) return jsonResponse({ received: true })

  const email = String(session.metadata?.email ?? session.customer_details?.email ?? '')
  const userId = String(session.metadata?.user_id ?? session.client_reference_id ?? '')
  const usageId = String(event.id ?? session.id ?? '')
  const stripeCustomerId = session.customer ? String(session.customer) : null
  if (!email || !userId || !usageId) return jsonResponse({ error: 'Missing metadata.' }, 400)

  const supabase = getSupabaseConfig(env)
  if (!supabase) return jsonResponse({ error: 'Database is not configured.' }, 500)
  if (!(await userExists(supabase.url, supabase.serviceKey, userId))) {
    return jsonResponse({ received: true })
  }

  const result = await grantTickets(supabase.url, supabase.serviceKey, {
    p_usage_id: usageId,
    p_user_id: userId,
    p_email: email,
    p_amount: plan.tickets,
    p_reason: 'stripe_purchase',
    p_metadata: {
      price_id: priceId,
      plan_label: plan.label,
      metadata_tickets: session.metadata?.tickets ?? null,
      session_id: session.id ?? null,
    },
    p_stripe_customer_id: stripeCustomerId,
  })

  if (!result.response.ok) {
    const message = String(result.data?.message ?? result.text ?? 'Failed to grant tickets.').slice(0, 300)
    return jsonResponse({ error: message }, message.includes('INVALID') ? 400 : 500)
  }

  const rpcResult = Array.isArray(result.data) ? result.data[0] : result.data
  if (rpcResult?.already_processed) return jsonResponse({ received: true, duplicate: true })
  return jsonResponse({ received: true })
}
