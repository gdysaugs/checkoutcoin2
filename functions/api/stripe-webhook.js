const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const HANDLED_EVENT_TYPES = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

function parseStripeSignatureHeader(header) {
  const out = { timestamp: null, v1: [] };
  if (!header) return out;
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (!k || !v) continue;
    const key = k.trim();
    const val = v.trim();
    if (key === "t") out.timestamp = Number(val);
    if (key === "v1") out.v1.push(val);
  }
  return out;
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const arr = new Uint8Array(sig);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyStripeSignature(rawBody, signatureHeader, secret, toleranceSec = 300) {
  const parsed = parseStripeSignatureHeader(signatureHeader);
  if (!Number.isFinite(parsed.timestamp) || parsed.v1.length === 0) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${rawBody}`);
  return parsed.v1.some((sig) => timingSafeEqualHex(sig, expected));
}

function adminHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function adminFetch(env, path, options = {}) {
  const res = await fetch(`${env.SUPABASE_URL}${path}`, options);
  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  return { res, text, parsed };
}

async function findTicketEventByUsageId(env, usageId) {
  const q = `/rest/v1/ticket_events?select=id,delta,created_at&usage_id=eq.${encodeURIComponent(usageId)}&limit=1`;
  const { res, parsed } = await adminFetch(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("ticket_events_query_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function getTicketRowById(env, id) {
  const q = `/rest/v1/user_tickets?select=id,email,user_id,tickets&id=eq.${encodeURIComponent(id)}&limit=1`;
  const { res, parsed } = await adminFetch(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("user_tickets_query_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function getTicketRowByUserId(env, userId) {
  const q = `/rest/v1/user_tickets?select=id,email,user_id,tickets&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
  const { res, parsed } = await adminFetch(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("user_tickets_query_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function getTicketRowByEmail(env, email) {
  const q = `/rest/v1/user_tickets?select=id,email,user_id,tickets&email=eq.${encodeURIComponent(email)}&limit=1`;
  const { res, parsed } = await adminFetch(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("user_tickets_query_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function updateTicketRow(env, id, payload) {
  const q = `/rest/v1/user_tickets?id=eq.${encodeURIComponent(id)}`;
  const { res, parsed } = await adminFetch(env, q, {
    method: "PATCH",
    headers: adminHeaders(env, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("user_tickets_update_failed");
  return Array.isArray(parsed) ? parsed[0] || null : null;
}

async function insertTicketRow(env, email, userId) {
  const payload = { email, tickets: 0 };
  if (userId) payload.user_id = userId;
  const { res, parsed } = await adminFetch(env, "/rest/v1/user_tickets", {
    method: "POST",
    headers: adminHeaders(env, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("user_tickets_insert_failed");
  return Array.isArray(parsed) ? parsed[0] || null : null;
}

async function ensureTicketRow(env, userId, email) {
  let row = null;
  if (userId) row = await getTicketRowByUserId(env, userId);
  if (!row) row = await getTicketRowByEmail(env, email);

  if (!row) {
    try {
      const inserted = await insertTicketRow(env, email, userId);
      if (inserted) return inserted;
    } catch {
      // race safe refetch
    }
    if (userId) row = await getTicketRowByUserId(env, userId);
    if (!row) row = await getTicketRowByEmail(env, email);
    if (!row) throw new Error("user_tickets_not_found");
    return row;
  }

  const needsEmail = row.email !== email;
  const needsUserId = Boolean(userId && row.user_id !== userId);
  if (needsEmail || needsUserId) {
    const patch = {};
    if (needsEmail) patch.email = email;
    if (needsUserId) patch.user_id = userId;
    const updated = await updateTicketRow(env, row.id, patch);
    if (updated) return updated;
  }
  return row;
}

async function optimisticCredit(env, rowId, delta) {
  let retries = 5;
  while (retries > 0) {
    retries -= 1;
    const row = await getTicketRowById(env, rowId);
    if (!row) throw new Error("user_tickets_not_found");
    const current = Number(row.tickets || 0);
    const next = current + delta;
    const q = `/rest/v1/user_tickets?id=eq.${encodeURIComponent(rowId)}&tickets=eq.${current}`;
    const { res, parsed } = await adminFetch(env, q, {
      method: "PATCH",
      headers: adminHeaders(env, {
        "content-type": "application/json",
        prefer: "return=representation",
      }),
      body: JSON.stringify({ tickets: next }),
    });
    if (!res.ok) throw new Error("user_tickets_update_failed");
    if (Array.isArray(parsed) && parsed.length > 0) {
      return Number(parsed[0].tickets || next);
    }
  }
  throw new Error("user_tickets_conflict");
}

async function insertTicketEvent(env, payload) {
  const { res, text } = await adminFetch(env, "/rest/v1/ticket_events", {
    method: "POST",
    headers: adminHeaders(env, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (res.ok) return { ok: true };
  if (res.status === 409 || text.includes("ticket_events_usage_id_key") || text.includes("duplicate key")) {
    return { ok: false, duplicate: true };
  }
  return { ok: false, duplicate: false };
}

function parsePriceToCoinsMap(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

function resolveCoinsFromSession(session, env) {
  const md = session?.metadata || {};
  const direct =
    parsePositiveInt(md.coins) ||
    parsePositiveInt(md.coin_amount) ||
    parsePositiveInt(md.tickets) ||
    parsePositiveInt(md.ticket_amount) ||
    parsePositiveInt(md.delta);
  if (direct) return direct;

  const priceMap = parsePriceToCoinsMap(env.STRIPE_PRICE_TO_COINS_MAP || env.STRIPE_PRICE_TO_COINS_JSON);
  const candidates = [
    md.price_id,
    md.stripe_price_id,
    session?.line_items?.data?.[0]?.price?.id,
    session?.display_items?.[0]?.price?.id,
  ].filter(Boolean);
  for (const key of candidates) {
    const mapped = parsePositiveInt(priceMap[key]);
    if (mapped) return mapped;
  }

  return null;
}

function isPaidSession(eventType, session) {
  if (!session || session.object !== "checkout.session") return false;
  if (eventType === "checkout.session.async_payment_succeeded") return true;
  return session.payment_status === "paid" || session.status === "complete";
}

function extractUserContextFromSession(session) {
  const md = session?.metadata || {};
  const email = normalizeEmail(
    session?.customer_details?.email ||
    session?.customer_email ||
    md.email
  );
  const maybeUserId = md.user_id || md.supabase_user_id || session?.client_reference_id;
  const userId = isUuid(maybeUserId) ? maybeUserId : null;
  return { email, userId };
}

async function creditCoinsWithIdempotency(env, { usageId, email, userId, coins, reason, metadata }) {
  const existing = await findTicketEventByUsageId(env, usageId);
  if (existing) {
    const row = userId
      ? await getTicketRowByUserId(env, userId)
      : await getTicketRowByEmail(env, email);
    return {
      alreadyProcessed: true,
      coins: Number(row?.tickets || 0),
    };
  }

  const row = await ensureTicketRow(env, userId, email);
  const newTotal = await optimisticCredit(env, row.id, coins);

  const eventResult = await insertTicketEvent(env, {
    usage_id: usageId,
    email,
    user_id: userId,
    delta: coins,
    reason,
    metadata,
  });

  if (eventResult.ok) {
    return { alreadyProcessed: false, coins: newTotal };
  }

  if (eventResult.duplicate) {
    // rollback best effort
    try {
      await optimisticCredit(env, row.id, -coins);
    } catch {
      // no-op
    }
    const latest = await getTicketRowById(env, row.id);
    return {
      alreadyProcessed: true,
      coins: Number(latest?.tickets || 0),
    };
  }

  // unknown failure: rollback best effort
  try {
    await optimisticCredit(env, row.id, -coins);
  } catch {
    // no-op
  }
  throw new Error("ticket_events_insert_failed");
}

function hasRequiredEnv(env) {
  return Boolean(
    env.SUPABASE_URL &&
    env.SUPABASE_SERVICE_ROLE_KEY &&
    env.SUPABASE_ANON_KEY &&
    env.STRIPE_WEBHOOK_SECRET
  );
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...JSON_HEADERS,
        allow: "POST,OPTIONS",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!hasRequiredEnv(env)) {
    return json({ error: "Missing env vars" }, 500);
  }

  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature");
  const tolerance = parsePositiveInt(env.STRIPE_WEBHOOK_TOLERANCE_SEC) || 300;
  const verified = await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET, tolerance);
  if (!verified) {
    return json({ error: "Invalid signature" }, 400);
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (!HANDLED_EVENT_TYPES.has(event?.type)) {
    return json({ received: true, ignored: true, type: event?.type || "unknown" });
  }

  const session = event?.data?.object;
  if (!isPaidSession(event.type, session)) {
    return json({ received: true, ignored: true, reason: "session_not_paid" });
  }

  const { email, userId } = extractUserContextFromSession(session);
  if (!email) {
    return json({ error: "customer email missing" }, 400);
  }

  const coins = resolveCoinsFromSession(session, env);
  if (!coins) {
    return json({ error: "coins metadata missing" }, 400);
  }

  const usageId = `stripe:${event.id}`;
  try {
    const result = await creditCoinsWithIdempotency(env, {
      usageId,
      email,
      userId,
      coins,
      reason: "stripe_checkout_credit",
      metadata: {
        source: "stripe_webhook",
        event_type: event.type,
        event_id: event.id,
        checkout_session_id: session.id || null,
        livemode: Boolean(event.livemode),
        amount_total: session.amount_total ?? null,
        currency: session.currency || null,
      },
    });

    return json({
      received: true,
      processed: !result.alreadyProcessed,
      coins: result.coins,
      usage_id: usageId,
    });
  } catch (e) {
    return json({ error: "Webhook processing failed", reason: e?.message || "unknown" }, 500);
  }
}
