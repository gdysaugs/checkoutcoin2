const state = {
  supabase: null,
  session: null,
  user: null,
  coins: 0,
  checkoutBusy: false,
}

const OAUTH_REDIRECT_URL = `${window.location.origin}/purchase.html`

const coinsEl = document.getElementById("coins")
const statusEl = document.getElementById("status")
const authStatusEl = document.getElementById("authStatus")
const loginGoogleBtn = document.getElementById("loginGoogle")
const loginMagicBtn = document.getElementById("loginMagic")
const magicEmailEl = document.getElementById("magicEmail")
const magicLinkRowEl = document.querySelector(".magic-link-row")
const logoutBtn = document.getElementById("logout")

const PURCHASE_REDIRECT_FLAG_KEY = "post_login_redirect"
const PURCHASE_REDIRECT_PATH = "/purchase.html"

function setStatus(text, isError = false) {
  if (!statusEl) return
  statusEl.textContent = text || ""
  statusEl.className = isError ? "status err" : "status"
}

function setVisible(el, visible) {
  if (!el) return
  el.hidden = !visible
  el.style.display = visible ? "" : "none"
}

function markPostLoginRedirect() {
  try {
    localStorage.setItem(PURCHASE_REDIRECT_FLAG_KEY, PURCHASE_REDIRECT_PATH)
  } catch {
    // ignore storage errors
  }
}

function clearPostLoginRedirect() {
  try {
    localStorage.removeItem(PURCHASE_REDIRECT_FLAG_KEY)
  } catch {
    // ignore storage errors
  }
}

function renderCoins() {
  if (!coinsEl) return
  coinsEl.textContent = String(state.coins)
}

function setPurchaseButtonsEnabled(enabled) {
  document.querySelectorAll(".buy-button").forEach((button) => {
    button.disabled = !enabled || state.checkoutBusy
  })
}

function ensureAuthClient() {
  if (state.supabase) return true
  setStatus("初期化中です。数秒後にもう一度お試しください。", true)
  return false
}

function updateAuthUi() {
  const loggedIn = Boolean(state.session)
  if (authStatusEl) {
    authStatusEl.textContent = loggedIn
      ? state.user?.email || "ログイン中"
      : "ログインしていません"
  }

  setVisible(loginGoogleBtn, !loggedIn)
  setVisible(magicLinkRowEl, !loggedIn)
  setVisible(logoutBtn, loggedIn)

  if (logoutBtn) logoutBtn.disabled = !loggedIn
  setPurchaseButtonsEnabled(loggedIn)
}

async function getConfig() {
  const res = await fetch("/api/public-config", {
    method: "GET",
    headers: { "cache-control": "no-store" },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || "公開設定の取得に失敗しました")
  }
  if (!data.supabaseUrl || !data.supabaseAnonKey) {
    throw new Error("Supabase設定が不足しています")
  }
  return data
}

async function api(path, method = "GET", body = null) {
  const token = state.session?.access_token
  if (!token) throw new Error("ログインが必要です")

  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || "サーバーエラー")
  }
  return data
}

async function syncCoins() {
  if (!state.session) {
    state.coins = 0
    renderCoins()
    return
  }

  const data = await api("/api/coins", "GET")
  state.coins = Number(data.coins || 0)
  renderCoins()
}

async function startCheckout(priceId) {
  if (!state.session) {
    setStatus("購入にはログインが必要です", true)
    return
  }

  state.checkoutBusy = true
  setPurchaseButtonsEnabled(true)

  try {
    const data = await api("/api/stripe-checkout", "POST", { priceId })
    if (!data?.url) {
      throw new Error("決済URLの取得に失敗しました")
    }
    window.location.href = data.url
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "決済開始に失敗しました", true)
  } finally {
    state.checkoutBusy = false
    setPurchaseButtonsEnabled(Boolean(state.session))
  }
}

function bindPurchaseButtons() {
  document.querySelectorAll(".buy-button").forEach((button) => {
    button.addEventListener("click", async () => {
      const priceId = button.getAttribute("data-price-id") || ""
      if (!priceId) {
        setStatus("price_id が未設定です", true)
        return
      }
      await startCheckout(priceId)
    })
  })
}

async function handleCheckoutResult() {
  const url = new URL(window.location.href)
  const result = url.searchParams.get("checkout")
  if (!result) return

  if (result === "success") {
    setStatus("決済が完了しました。コイン残高を更新します。")
    try {
      await syncCoins()
    } catch {
      setStatus("決済は完了しました。コインの反映は再読み込みで確認してください。")
    }
  } else if (result === "cancel") {
    setStatus("決済をキャンセルしました")
  }

  url.searchParams.delete("checkout")
  window.history.replaceState({}, document.title, url.toString())
}

async function onGoogleLoginClick() {
  if (!ensureAuthClient()) return
  try {
    markPostLoginRedirect()
    await state.supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: OAUTH_REDIRECT_URL,
        queryParams: { prompt: "select_account" },
      },
    })
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Googleログインに失敗しました", true)
  }
}

async function onMagicLoginClick() {
  if (!ensureAuthClient()) return
  const email = String(magicEmailEl?.value || "").trim()
  if (!email) {
    setStatus("メールアドレスを入力してください", true)
    return
  }

  try {
    markPostLoginRedirect()
    const { error } = await state.supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: OAUTH_REDIRECT_URL },
    })
    if (error) throw error
    setStatus("ログインメールを送信しました。メールを確認してください。")
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "メールログインに失敗しました", true)
  }
}

async function onLogoutClick() {
  if (!ensureAuthClient()) return
  try {
    await state.supabase.auth.signOut()
    setStatus("ログアウトしました")
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "ログアウトに失敗しました", true)
  }
}

function bindAuthButtons() {
  if (loginGoogleBtn) {
    loginGoogleBtn.addEventListener("click", () => {
      void onGoogleLoginClick()
    })
  }
  if (loginMagicBtn) {
    loginMagicBtn.addEventListener("click", () => {
      void onMagicLoginClick()
    })
  }
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      void onLogoutClick()
    })
  }
}

async function initAuth() {
  let cfg
  try {
    cfg = await getConfig()
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "初期化に失敗しました", true)
    updateAuthUi()
    return
  }

  if (!window.supabase?.createClient) {
    setStatus("Supabaseライブラリの読み込みに失敗しました", true)
    updateAuthUi()
    return
  }

  state.supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })

  const { data: sessionData } = await state.supabase.auth.getSession()
  state.session = sessionData.session
  state.user = sessionData.session?.user || null

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session
    state.user = session?.user || null
    updateAuthUi()

    if (session) {
      try {
        await syncCoins()
      } catch {
        setStatus("コイン残高の取得に失敗しました", true)
      }
    } else {
      state.coins = 0
      renderCoins()
    }
  })

  updateAuthUi()

  if (state.session) {
    clearPostLoginRedirect()
    try {
      await syncCoins()
    } catch {
      setStatus("コイン残高の取得に失敗しました", true)
    }
  } else {
    state.coins = 0
    renderCoins()
  }

  await handleCheckoutResult()
}

bindPurchaseButtons()
bindAuthButtons()
updateAuthUi()
void initAuth()
