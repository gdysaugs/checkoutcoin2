type Env = {
  SUPABASE_URL?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
  STRIPE_SECRET_KEY?: string
}

type PurchasePlan = {
  label: string
  tickets: number
}

type AuthUser = {
  id?: string
  email?: string
  app_metadata?: { provider?: string }
  identities?: Array<{ provider?: string }>
}

const PRICE_MAP = new Map<string, PurchasePlan>([
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

const extractBearerToken = (request: Request) => {
  const match = (request.headers.get('Authorization') || '').match(/Bearer\s+(.+)/i)
  return match ? match[1] : ''
}

const isGoogleUser = (user: AuthUser) =>
  user.app_metadata?.provider === 'google' ||
  Boolean(user.identities?.some((identity) => identity.provider === 'google'))

const authenticateUser = async (request: Request, env: Env) => {
  const token = extractBearerToken(request)
  if (!token) return { error: jsonResponse({ error: 'ログインが必要です。' }, 401) }

  const supabaseUrl = String(env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '')
  const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()
  if (!supabaseUrl || !serviceKey) {
    return { error: jsonResponse({ error: '認証設定が未完了です。' }, 500) }
  }

  let response: Response
  try {
    response = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: serviceKey,
        Accept: 'application/json',
      },
    })
  } catch {
    return { error: jsonResponse({ error: '認証サービスへ接続できませんでした。' }, 502) }
  }
  if (!response.ok) return { error: jsonResponse({ error: '認証に失敗しました。' }, 401) }

  const user = (await response.json().catch(() => null)) as AuthUser | null
  if (!user?.id || !user.email) return { error: jsonResponse({ error: 'ユーザー情報を取得できませんでした。' }, 401) }
  if (!isGoogleUser(user)) return { error: jsonResponse({ error: 'Googleログインのみ利用できます。' }, 403) }
  return { user }
}

const parseStripeResponse = async (response: Response) => {
  const text = await response.text()
  try {
    return { data: text ? JSON.parse(text) : null, text }
  } catch {
    return { data: null, text }
  }
}

export const onRequestOptions: PagesFunction = async () =>
  new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const auth = await authenticateUser(request, env)
  if ('error' in auth) return auth.error

  const stripeKey = String(env.STRIPE_SECRET_KEY ?? '').trim()
  if (!stripeKey) return jsonResponse({ error: 'Stripeの設定が未完了です。' }, 500)

  const payload = await request.json().catch(() => null) as { price_id?: unknown; priceId?: unknown } | null
  if (!payload) return jsonResponse({ error: 'Invalid request body.' }, 400)

  const priceId = String(payload.price_id ?? payload.priceId ?? '')
  const plan = PRICE_MAP.get(priceId)
  if (!plan) return jsonResponse({ error: '不正なプランです。' }, 400)

  const requestOrigin = new URL(request.url).origin
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', `${requestOrigin}/purchase?checkout=success`)
  params.set('cancel_url', `${requestOrigin}/purchase?checkout=cancel`)
  params.set('line_items[0][price]', priceId)
  params.set('line_items[0][quantity]', '1')
  params.set('client_reference_id', auth.user.id)
  params.set('customer_email', auth.user.email)
  params.set('metadata[user_id]', auth.user.id)
  params.set('metadata[email]', auth.user.email)
  params.set('metadata[tickets]', String(plan.tickets))
  params.set('metadata[price_id]', priceId)
  params.set('metadata[plan_label]', plan.label)
  params.set('metadata[plan_kind]', 'payment')
  params.set('metadata[app]', 'crownai')
  params.set('payment_intent_data[statement_descriptor]', 'CROWNAI')

  let stripeResponse: Response
  try {
    stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    })
  } catch {
    return jsonResponse({ error: 'Stripe APIへの接続に失敗しました。' }, 502)
  }

  const stripe = await parseStripeResponse(stripeResponse)
  if (!stripeResponse.ok) {
    const message = String(stripe.data?.error?.message ?? stripe.text ?? '').trim().slice(0, 300)
    return jsonResponse({ error: message || 'Stripeのセッション作成に失敗しました。' }, 500)
  }

  const checkoutUrl = typeof stripe.data?.url === 'string' ? stripe.data.url : ''
  if (!checkoutUrl) return jsonResponse({ error: 'StripeセッションURLの取得に失敗しました。' }, 500)
  return jsonResponse({ url: checkoutUrl })
}
