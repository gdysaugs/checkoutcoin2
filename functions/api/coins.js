const BASE_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: BASE_HEADERS,
  });
}

function getBearerToken(request) {
  const auth = request.headers.get("authorization") || "";
  const parts = auth.split(" ");
  if (parts.length !== 2 || parts[0] !== "Bearer") return null;
  return parts[1];
}

function adminHeaders(env, extra = {}) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    ...extra,
  };
}

async function adminFetchJson(env, path, options = {}) {
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
  return { res, parsed, text };
}

async function fetchSupabaseUser(env, token) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    method: "GET",
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

async function callRpc(env, name, payload) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!res.ok) {
    if (text.includes("function") || text.includes("Could not find")) {
      throw new Error("rpc_missing");
    }
    throw new Error("rpc_failed");
  }
  return parsed || {};
}

async function getTicketsByUserId(env, userId) {
  const q = `/rest/v1/user_tickets?select=id,email,user_id,tickets&user_id=eq.${encodeURIComponent(userId)}&limit=1`;
  const { res, parsed } = await adminFetchJson(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("rest_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function getTicketsByEmail(env, email) {
  const q = `/rest/v1/user_tickets?select=id,email,user_id,tickets&email=eq.${encodeURIComponent(email)}&limit=1`;
  const { res, parsed } = await adminFetchJson(env, q, {
    method: "GET",
    headers: adminHeaders(env, { accept: "application/json" }),
  });
  if (!res.ok) throw new Error("rest_failed");
  if (Array.isArray(parsed) && parsed.length > 0) return parsed[0];
  return null;
}

async function updateTicketsRow(env, id, payload) {
  const q = `/rest/v1/user_tickets?id=eq.${encodeURIComponent(id)}`;
  const { res, parsed } = await adminFetchJson(env, q, {
    method: "PATCH",
    headers: adminHeaders(env, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("rest_failed");
  return Array.isArray(parsed) ? parsed[0] || null : null;
}

async function insertTicketsRow(env, email, userId) {
  const { res, parsed } = await adminFetchJson(env, "/rest/v1/user_tickets", {
    method: "POST",
    headers: adminHeaders(env, {
      "content-type": "application/json",
      prefer: "return=representation",
    }),
    body: JSON.stringify({
      email,
      user_id: userId,
      tickets: 0,
    }),
  });
  if (!res.ok) {
    // insert race: caller should refetch
    throw new Error("insert_failed");
  }
  return Array.isArray(parsed) ? parsed[0] || null : null;
}

async function ensureTicketsRow(env, userId, email) {
  let row = await getTicketsByUserId(env, userId);
  if (row) return row;

  row = await getTicketsByEmail(env, email);
  if (row) {
    if (!row.user_id || row.user_id !== userId || row.email !== email) {
      const updated = await updateTicketsRow(env, row.id, { user_id: userId, email });
      if (updated) return updated;
    }
    return row;
  }

  try {
    const inserted = await insertTicketsRow(env, email, userId);
    if (inserted) return inserted;
  } catch {
    // ignore and refetch for race safety
  }

  row = await getTicketsByUserId(env, userId);
  if (row) return row;
  row = await getTicketsByEmail(env, email);
  if (row) return row;
  throw new Error("row_not_created");
}

async function consumeTicketsDirect(env, userId, email, cost) {
  let retries = 3;
  while (retries > 0) {
    retries -= 1;
    const row = await ensureTicketsRow(env, userId, email);
    const current = Number(row.tickets || 0);
    if (current < cost) {
      return { ok: false, tickets: current };
    }

    const q = `/rest/v1/user_tickets?id=eq.${encodeURIComponent(row.id)}&tickets=eq.${current}`;
    const { res, parsed } = await adminFetchJson(env, q, {
      method: "PATCH",
      headers: adminHeaders(env, {
        "content-type": "application/json",
        prefer: "return=representation",
      }),
      body: JSON.stringify({ tickets: current - cost }),
    });

    if (!res.ok) throw new Error("rest_failed");
    if (Array.isArray(parsed) && parsed.length > 0) {
      return { ok: true, tickets: Number(parsed[0].tickets || 0) };
    }
    // optimistic lock miss -> retry
  }
  throw new Error("consume_conflict");
}

function validateEnv(env) {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export async function onRequest(context) {
  const { request, env } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...BASE_HEADERS,
        allow: "GET,POST,OPTIONS",
      },
    });
  }

  if (!validateEnv(env)) {
    return json({ error: "Server config missing" }, 500);
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const token = getBearerToken(request);
  if (!token) return json({ error: "Unauthorized" }, 401);

  const user = await fetchSupabaseUser(env, token);
  if (!user?.id || !user?.email) {
    return json({ error: "Unauthorized" }, 401);
  }

  const userId = user.id;
  const email = normalizeEmail(user.email);

  try {
    if (request.method === "GET") {
      let coins = 0;
      try {
        const result = await callRpc(env, "get_user_tickets_shared", {
          p_user_id: userId,
          p_email: email,
        });
        coins = Number(result?.tickets || 0);
      } catch (e) {
        if (e?.message === "rpc_missing" || e?.message === "rpc_failed") {
          const row = await ensureTicketsRow(env, userId, email);
          coins = Number(row?.tickets || 0);
        } else {
          throw e;
        }
      }
      return json({ coins, email });
    }

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    if (action !== "consume") {
      return json({ error: "Invalid action" }, 400);
    }

    const cost = Number(body?.cost || 0);
    const reason = String(body?.reason || "game_play").slice(0, 120);
    if (!Number.isInteger(cost) || cost <= 0) {
      return json({ error: "Invalid cost" }, 400);
    }

    let result;
    try {
      result = await callRpc(env, "consume_user_tickets_shared", {
        p_user_id: userId,
        p_email: email,
        p_cost: cost,
        p_reason: reason,
      });
    } catch (e) {
      if (e?.message === "rpc_missing" || e?.message === "rpc_failed") {
        result = await consumeTicketsDirect(env, userId, email, cost);
      } else {
        throw e;
      }
    }

    if (result?.ok === false) {
      return json({ error: "Not enough coins", coins: Number(result?.tickets || 0) }, 409);
    }

    return json({ coins: Number(result?.tickets || 0) });
  } catch (e) {
    return json({ error: "Server error" }, 500);
  }
}
