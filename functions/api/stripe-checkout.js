const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
}

const PRICE_PLANS = {
  price_1T8HvfAiNL47NYQB3Bf7oFKI: { name: "ライト", coins: 30, amountJpy: 690 },
  price_1T8Hw4AiNL47NYQBrTG7nOfM: { name: "ベーシック", coins: 80, amountJpy: 1680 },
  price_1T8HwTAiNL47NYQBylwGY6xQ: { name: "スタンダード", coins: 170, amountJpy: 3280 },
  price_1T8Hx4AiNL47NYQB5CLzqerl: { name: "プロ", coins: 380, amountJpy: 6480 },
}
const DEFAULT_RETURN_ORIGIN = "https://checkoutcoins2.win"
const ALLOWED_RETURN_HOSTS = new Set(["checkoutcoins2.win", "www.checkoutcoins2.win"])

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  })
}

function getBearerToken(request) {
  const auth = request.headers.get("authorization") || ""
  const parts = auth.split(" ")
  if (parts.length !== 2 || parts[0] !== "Bearer") return null
  return parts[1]
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase()
}

async function fetchSupabaseUser(env, token) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
    },
  })
  if (!res.ok) return null
  return res.json()
}

function getOriginFromRequest(request, env) {
  const configured = String(env.CHECKOUT_RETURN_ORIGIN || "").trim()
  if (configured) return configured.replace(/\/$/, "")
  try {
    const url = new URL(request.url)
    if (ALLOWED_RETURN_HOSTS.has(url.hostname)) {
      return `${url.protocol}//${url.host}`
    }
  } catch {
    // fall through
  }
  return DEFAULT_RETURN_ORIGIN
}

function buildCheckoutPayload({ request, user, priceId, plan, env }) {
  const email = normalizeEmail(user.email)
  const origin = getOriginFromRequest(request, env)
  const successUrl = `${origin}/purchase.html?checkout=success`
  const cancelUrl = `${origin}/purchase.html?checkout=cancel`
  const params = new URLSearchParams()

  params.set("mode", "payment")
  params.set("success_url", successUrl)
  params.set("cancel_url", cancelUrl)
  params.set("line_items[0][price]", priceId)
  params.set("line_items[0][quantity]", "1")
  params.set("client_reference_id", String(user.id))
  params.set("customer_email", email)
  params.set("locale", "ja")
  params.set("metadata[user_id]", String(user.id))
  params.set("metadata[email]", email)
  params.set("metadata[coins]", String(plan.coins))
  params.set("metadata[price_id]", priceId)
  params.set("metadata[plan]", plan.name)
  params.set("metadata[amount_jpy]", String(plan.amountJpy))

  return params
}

function requiredEnvReady(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.STRIPE_SECRET_KEY)
}

export async function onRequest(context) {
  const { request, env } = context

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...JSON_HEADERS,
        allow: "POST,OPTIONS",
      },
    })
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405)
  }

  if (!requiredEnvReady(env)) {
    return json({ error: "Server config missing" }, 500)
  }

  const token = getBearerToken(request)
  if (!token) {
    return json({ error: "ログインが必要です" }, 401)
  }

  const user = await fetchSupabaseUser(env, token)
  if (!user?.id || !user?.email) {
    return json({ error: "ログインが必要です" }, 401)
  }

  const body = await request.json().catch(() => ({}))
  const priceId = String(body?.priceId || "")
  const plan = PRICE_PLANS[priceId]
  if (!plan) {
    return json({ error: "無効な価格IDです" }, 400)
  }

  const stripePayload = buildCheckoutPayload({ request, user, priceId, plan, env })
  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: stripePayload.toString(),
  })

  const text = await stripeRes.text()
  let parsed = null
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }

  if (!stripeRes.ok) {
    const message = parsed?.error?.message || "Stripe checkout session creation failed"
    return json({ error: message }, 502)
  }

  if (!parsed?.url) {
    return json({ error: "checkout_url_missing" }, 502)
  }

  return json({
    ok: true,
    checkoutSessionId: parsed.id,
    url: parsed.url,
  })
}
