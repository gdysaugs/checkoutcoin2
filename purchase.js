(() => {
  const elements = {
    balanceValue: document.getElementById("balanceValue"),
    balanceEmail: document.getElementById("balanceEmail"),
    authChip: document.getElementById("authChip"),
    loggedInBox: document.getElementById("loggedInBox"),
    loggedInEmail: document.getElementById("loggedInEmail"),
    loginBox: document.getElementById("loginBox"),
    loginButton: document.getElementById("loginButton"),
    authMessage: document.getElementById("authMessage"),
    logoutButton: document.getElementById("logoutButton"),
    purchaseMessage: document.getElementById("purchaseMessage"),
    purchaseButtons: Array.from(document.querySelectorAll(".purchase-button")),
  };

  let authClient = null;
  let currentSession = null;
  let ticketCount = null;
  let ticketLoading = false;
  let purchaseLoading = false;
  let refreshId = 0;

  const normalizeErrorMessage = (value, fallback = "処理に失敗しました。") => {
    if (!value) return fallback;
    if (typeof value === "string") return value;
    if (value instanceof Error && value.message) return value.message;
    if (typeof value === "object") {
      const picked = value.error ?? value.message ?? value.detail;
      if (typeof picked === "string" && picked) return picked;
    }
    return fallback;
  };

  const setMessage = (element, message, isError = false) => {
    element.textContent = message || "";
    element.hidden = !message;
    element.classList.toggle("store-message--error", Boolean(message && isError));
  };

  const render = () => {
    const isLoggedIn = Boolean(currentSession);
    const email = currentSession?.user?.email ?? "";

    elements.authChip.textContent = isLoggedIn ? "ログイン中" : "未ログイン";
    elements.authChip.classList.toggle("store-chip--active", isLoggedIn);
    elements.loginBox.hidden = isLoggedIn;
    elements.loggedInBox.hidden = !isLoggedIn;
    elements.loggedInEmail.textContent = email;
    elements.balanceEmail.textContent = isLoggedIn ? email : "ログイン後に表示されます";
    elements.balanceValue.textContent = isLoggedIn
      ? ticketLoading
        ? "確認中"
        : `${ticketCount ?? 0}枚`
      : "--";

    elements.purchaseButtons.forEach((button) => {
      button.disabled = !isLoggedIn || purchaseLoading;
      button.textContent = purchaseLoading ? "処理中..." : "購入する";
    });
  };

  const cleanAuthParams = () => {
    const url = new URL(window.location.href);
    let changed = false;
    ["code", "state", "error", "error_code", "error_description"].forEach((key) => {
      if (url.searchParams.has(key)) {
        url.searchParams.delete(key);
        changed = true;
      }
    });
    if (url.hash.includes("access_token=") || url.hash.includes("refresh_token=")) {
      url.hash = "";
      changed = true;
    }
    if (changed) window.history.replaceState({}, document.title, url.toString());
  };

  const resolveAuthCallback = async () => {
    const url = new URL(window.location.href);
    const authError =
      url.searchParams.get("error_description") ||
      url.searchParams.get("error_code") ||
      url.searchParams.get("error");
    if (authError) {
      cleanAuthParams();
      throw new Error(authError);
    }

    const code = url.searchParams.get("code");
    if (code) {
      // The browser client exchanges PKCE callbacks during initialization.
      // getSession waits for that initialization; exchanging the same code here
      // would consume the verifier twice and surface a false login error.
      const { data, error } = await authClient.auth.getSession();
      cleanAuthParams();
      if (error) throw error;
      if (!data.session) throw new Error("ログインを完了できませんでした。もう一度お試しください。");
      return data.session ?? null;
    }

    if (url.hash.includes("access_token=")) {
      const params = new URLSearchParams(url.hash.slice(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken && refreshToken) {
        const { data, error } = await authClient.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        cleanAuthParams();
        if (error) throw error;
        return data.session ?? null;
      }
    }

    const { data, error } = await authClient.auth.getSession();
    if (error) throw error;
    return data.session ?? null;
  };

  const fetchTickets = async (requestId) => {
    const token = currentSession?.access_token ?? "";
    if (!token) return;
    ticketLoading = true;
    render();
    try {
      const response = await fetch("/api/tickets", {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      const data = await response.json().catch(() => ({}));
      if (requestId !== refreshId) return;
      if (!response.ok) throw new Error(data?.error || "チケット取得に失敗しました。");
      ticketCount = Number(data?.tickets ?? 0);
      setMessage(elements.authMessage, "");
    } catch (error) {
      if (requestId !== refreshId) return;
      ticketCount = null;
      setMessage(elements.authMessage, normalizeErrorMessage(error, "チケット取得に失敗しました。"), true);
    } finally {
      if (requestId === refreshId) {
        ticketLoading = false;
        render();
      }
    }
  };

  const applySession = async (session) => {
    currentSession = session;
    refreshId += 1;
    const requestId = refreshId;
    if (!session) {
      ticketCount = null;
      ticketLoading = false;
    }
    render();
    if (session) await fetchTickets(requestId);
  };

  const handleLogin = async () => {
    if (!authClient) {
      setMessage(elements.authMessage, "認証設定が未完了です。", true);
      return;
    }
    elements.loginButton.disabled = true;
    elements.loginButton.textContent = "接続中...";
    setMessage(elements.authMessage, "");
    try {
      const redirectTo = new URL("/purchase", window.location.origin).toString();
      const { data, error } = await authClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo, skipBrowserRedirect: true },
      });
      if (error) throw error;
      if (!data?.url) throw new Error("認証URLの取得に失敗しました。");
      window.location.assign(data.url);
    } catch (error) {
      setMessage(elements.authMessage, normalizeErrorMessage(error, "ログインに失敗しました。"), true);
      elements.loginButton.disabled = false;
      elements.loginButton.textContent = "Googleでログイン";
    }
  };

  const handleLogout = async () => {
    if (!authClient) return;
    elements.logoutButton.disabled = true;
    try {
      const { error } = await authClient.auth.signOut({ scope: "local" });
      if (error) throw error;
      await applySession(null);
    } catch (error) {
      setMessage(elements.authMessage, normalizeErrorMessage(error, "ログアウトに失敗しました。"), true);
    } finally {
      elements.logoutButton.disabled = false;
    }
  };

  const handleCheckout = async (priceId) => {
    const token = currentSession?.access_token ?? "";
    if (!token) {
      setMessage(elements.purchaseMessage, "ログインしてから購入してください。", true);
      return;
    }
    purchaseLoading = true;
    render();
    setMessage(elements.purchaseMessage, "決済ページを準備しています...");
    try {
      const response = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ price_id: priceId }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data?.url) throw new Error(data?.error || "決済ページの作成に失敗しました。");
      window.location.assign(data.url);
    } catch (error) {
      setMessage(elements.purchaseMessage, normalizeErrorMessage(error, "決済ページの作成に失敗しました。"), true);
      purchaseLoading = false;
      render();
    }
  };

  const initializeAuth = async () => {
    try {
      if (!window.supabase?.createClient) throw new Error("認証ライブラリを読み込めませんでした。");
      const response = await fetch("/api/auth-config", { cache: "no-store" });
      const config = await response.json().catch(() => ({}));
      if (!response.ok || !config?.url || !config?.anonKey) throw new Error("認証設定が未完了です。");

      authClient = window.supabase.createClient(String(config.url), String(config.anonKey), {
        auth: {
          autoRefreshToken: true,
          detectSessionInUrl: true,
          flowType: "pkce",
          persistSession: true,
        },
      });

      const session = await resolveAuthCallback();
      await applySession(session);
      authClient.auth.onAuthStateChange((_event, nextSession) => {
        if (nextSession?.access_token === currentSession?.access_token) return;
        void applySession(nextSession);
      });

      elements.loginButton.disabled = false;
      elements.loginButton.textContent = "Googleでログイン";
    } catch (error) {
      elements.authChip.textContent = "設定エラー";
      elements.loginButton.disabled = false;
      elements.loginButton.textContent = "Googleでログイン";
      setMessage(elements.authMessage, normalizeErrorMessage(error, "認証設定が未完了です。"), true);
      render();
    }
  };

  elements.loginButton.addEventListener("click", handleLogin);
  elements.logoutButton.addEventListener("click", handleLogout);
  elements.purchaseButtons.forEach((button) => {
    button.addEventListener("click", () => handleCheckout(button.dataset.priceId || ""));
  });

  const checkoutStatus = new URL(window.location.href).searchParams.get("checkout");
  if (checkoutStatus === "success") {
    setMessage(elements.purchaseMessage, "購入が完了しました。残高へ反映されるまで少しお待ちください。");
  } else if (checkoutStatus === "cancel") {
    setMessage(elements.purchaseMessage, "購入手続きをキャンセルしました。");
  }

  render();
  void initializeAuth();
})();
