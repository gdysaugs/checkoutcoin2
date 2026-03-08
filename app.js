const state = {
  coins: 0,
  active: "",
  session: null,
  user: null,
  supabase: null,
}

const OAUTH_REDIRECT_URL = `${window.location.origin}${window.location.pathname === "/index.html" ? "/index.html" : "/"}`
const PURCHASE_REDIRECT_FLAG_KEY = "post_login_redirect"
const PURCHASE_REDIRECT_PATH = "/purchase.html"

function forwardAuthCallbackToPurchase() {
  const path = window.location.pathname
  if (path !== "/" && path !== "/index.html") return
  const hash = window.location.hash || ""
  const hasAuthHash =
    hash.includes("access_token=") ||
    hash.includes("refresh_token=") ||
    hash.includes("error=")
  if (!hasAuthHash) return

  let shouldForward = false
  try {
    shouldForward = localStorage.getItem(PURCHASE_REDIRECT_FLAG_KEY) === PURCHASE_REDIRECT_PATH
    localStorage.removeItem(PURCHASE_REDIRECT_FLAG_KEY)
  } catch {
    shouldForward = false
  }
  if (!shouldForward) return

  window.location.replace(`${PURCHASE_REDIRECT_PATH}${hash}`)
}

forwardAuthCallbackToPurchase()

const coinsEl = document.getElementById("coins")
const statusEl = document.getElementById("status")
const titleEl = document.getElementById("title")
const authStatusEl = document.getElementById("authStatus")
const loginBtn = document.getElementById("login")
const logoutBtn = document.getElementById("logout")
const refreshBtn = document.getElementById("refresh")
const restartBtn = document.getElementById("restart")

function msg(text, err = false) {
  statusEl.textContent = text
  statusEl.className = err ? "status err" : "status"
}

function renderCoins() {
  coinsEl.textContent = String(state.coins)
}

function updateAuthButtons(loggedIn) {
  if (loginBtn) loginBtn.hidden = loggedIn
  if (logoutBtn) logoutBtn.hidden = !loggedIn
  if (refreshBtn) refreshBtn.hidden = !loggedIn
}

function setStartButtonsEnabled(enabled) {
  document.querySelectorAll(".card button[data-game]").forEach((btn) => {
    btn.disabled = !enabled
  })
}

function clearGames() {
  document.querySelectorAll(".game").forEach((g) => g.classList.remove("active"))
  titleEl.textContent = "ゲームを選んでください"
  state.active = ""
}

function openGame(name) {
  state.active = name
  document.querySelectorAll(".game").forEach((g) => g.classList.remove("active"))
  const target = document.getElementById(`g-${name}`)
  if (target) target.classList.add("active")
  const labels = { othello: "オセロ", shogi: "将棋（ライト版）", connect4: "4目並べ" }
  titleEl.textContent = labels[name] || "ゲーム"
}

async function getConfig() {
  const res = await fetch("/api/public-config", {
    method: "GET",
    headers: { "cache-control": "no-store" },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "公開設定の取得に失敗しました")
  if (!data.supabaseUrl || !data.supabaseAnonKey) {
    throw new Error("Supabase設定が未設定です")
  }
  return data
}

async function api(path, method = "GET", body = null) {
  if (!state.session?.access_token) throw new Error("ログインが必要です")
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${state.session.access_token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "サーバーエラー")
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

async function consume(cost, label) {
  if (!state.session) {
    msg("ログインしてください", true)
    return false
  }
  const data = await api("/api/coins", "POST", {
    action: "consume",
    cost,
    reason: label,
  })
  state.coins = Number(data.coins || 0)
  renderCoins()
  msg(`${label} を開始 (-${cost} コイン)`)
  return true
}

async function initAuth() {
  let cfg
  try {
    cfg = await getConfig()
  } catch (e) {
    msg(e.message || "Supabase設定の取得に失敗しました", true)
    authStatusEl.textContent = "Supabase設定なし"
    setStartButtonsEnabled(false)
    return
  }

  if (!window.supabase?.createClient) {
    msg("Supabaseライブラリの読み込みに失敗しました", true)
    authStatusEl.textContent = "Supabase設定なし"
    setStartButtonsEnabled(false)
    return
  }

  state.supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  })

  loginBtn.onclick = async () => {
    try {
      await state.supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: OAUTH_REDIRECT_URL,
          queryParams: { prompt: "select_account" },
        },
      })
    } catch (e) {
      msg(e.message || "ログイン開始に失敗しました", true)
    }
  }

  logoutBtn.onclick = async () => {
    try {
      await state.supabase.auth.signOut()
      state.session = null
      state.user = null
      updateAuthButtons(false)
      setStartButtonsEnabled(false)
      clearGames()
      state.coins = 0
      renderCoins()
      authStatusEl.textContent = "ログインしていません"
      msg("ログアウトしました")
    } catch (e) {
      msg(e.message || "ログアウト失敗", true)
    }
  }

  refreshBtn.onclick = async () => {
    try {
      await syncCoins()
      msg("コインを更新しました")
    } catch (e) {
      msg(e.message || "更新失敗", true)
    }
  }

  const { data: sessionData } = await state.supabase.auth.getSession()
  state.session = sessionData.session
  state.user = sessionData.session?.user || null

  state.supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session
    state.user = session?.user || null
    if (!session) {
      updateAuthButtons(false)
      setStartButtonsEnabled(false)
      clearGames()
      state.coins = 0
      renderCoins()
      authStatusEl.textContent = "ログインしていません"
      return
    }
    updateAuthButtons(true)
    authStatusEl.textContent = session.user?.email || "ログイン中"
    setStartButtonsEnabled(true)
    try {
      await syncCoins()
    } catch (e) {
      msg(e.message || "コイン取得失敗", true)
    }
  })

  if (state.session) {
    updateAuthButtons(true)
    authStatusEl.textContent = state.user?.email || "ログイン中"
    setStartButtonsEnabled(true)
    await syncCoins()
  } else {
    updateAuthButtons(false)
    authStatusEl.textContent = "ログインしていません"
    setStartButtonsEnabled(false)
    state.coins = 0
    renderCoins()
  }
}

document.querySelectorAll(".card button[data-game]").forEach((btn) => {
  btn.onclick = async () => {
    const game = btn.dataset.game
    const cost = Number(btn.dataset.cost || 0)
    const label = game === "othello" ? "オセロ" : game === "shogi" ? "将棋" : "4目並べ"
    try {
      const ok = await consume(cost, label)
      if (!ok) return
      openGame(game)
      if (game === "othello") initOthello()
      if (game === "shogi") initShogi()
      if (game === "connect4") initConnect4()
    } catch (e) {
      msg(e.message || "処理失敗", true)
    }
  }
})

restartBtn.onclick = () => {
  if (!state.active) {
    msg("先にゲームを開始してください", true)
    return
  }
  if (state.active === "othello") initOthello()
  if (state.active === "shogi") initShogi()
  if (state.active === "connect4") initConnect4()
  msg("現在のゲームをリセットしました")
}

const o = { board: [], turn: "B", over: false }
const oBoardEl = document.getElementById("othelloBoard")
const oInfoEl = document.getElementById("othelloInfo")
const oDirs = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
]
const oId = (r, c) => r * 8 + c
const oIn = (r, c) => r >= 0 && r < 8 && c >= 0 && c < 8
const oOpp = (p) => (p === "B" ? "W" : "B")

function oFlips(board, r, c, p) {
  if (board[oId(r, c)]) return []
  const enemy = oOpp(p)
  const out = []
  for (const [dr, dc] of oDirs) {
    let rr = r + dr
    let cc = c + dc
    const line = []
    while (oIn(rr, cc) && board[oId(rr, cc)] === enemy) {
      line.push(oId(rr, cc))
      rr += dr
      cc += dc
    }
    if (line.length && oIn(rr, cc) && board[oId(rr, cc)] === p) {
      out.push(...line)
    }
  }
  return out
}

function oMoves(board, p) {
  const out = new Map()
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const flips = oFlips(board, r, c, p)
      if (flips.length) out.set(oId(r, c), flips)
    }
  }
  return out
}

function oCount(piece) {
  return o.board.filter((v) => v === piece).length
}

function oPlace(index, legal) {
  if (!legal.has(index) || o.over) return
  o.board[index] = o.turn
  for (const id of legal.get(index)) o.board[id] = o.turn

  const next = oOpp(o.turn)
  const nextMoves = oMoves(o.board, next)
  if (nextMoves.size > 0) {
    o.turn = next
  } else {
    const selfMoves = oMoves(o.board, o.turn)
    if (selfMoves.size === 0) {
      o.over = true
    } else {
      msg(next === "B" ? "黒は置けないためパス" : "白は置けないためパス")
    }
  }
  renderOthello()
}

function renderOthello() {
  oBoardEl.innerHTML = ""
  const legal = oMoves(o.board, o.turn)
  for (let r = 0; r < 8; r += 1) {
    for (let c = 0; c < 8; c += 1) {
      const id = oId(r, c)
      const btn = document.createElement("button")
      if (legal.has(id) && !o.over) btn.classList.add("hint")
      const piece = o.board[id]
      if (piece) {
        const disk = document.createElement("span")
        disk.className = `disk ${piece === "B" ? "b" : "w"}`
        btn.appendChild(disk)
      }
      btn.onclick = () => oPlace(id, legal)
      oBoardEl.appendChild(btn)
    }
  }

  const b = oCount("B")
  const w = oCount("W")
  if (o.over) {
    const result = b === w ? "引き分け" : b > w ? "黒の勝ち" : "白の勝ち"
    oInfoEl.textContent = `終了: 黒 ${b} / 白 ${w} (${result})`
    return
  }
  const turnText = o.turn === "B" ? "黒の番" : "白の番"
  oInfoEl.textContent = `${turnText} / 黒 ${b} / 白 ${w}`
}

function initOthello() {
  o.board = Array(64).fill(null)
  o.board[oId(3, 3)] = "W"
  o.board[oId(3, 4)] = "B"
  o.board[oId(4, 3)] = "B"
  o.board[oId(4, 4)] = "W"
  o.turn = "B"
  o.over = false
  renderOthello()
}

const s = { board: [], turn: "P1", selected: -1, over: false, winner: "" }
const sBoardEl = document.getElementById("shogiBoard")
const sInfoEl = document.getElementById("shogiInfo")
const sId = (r, c) => r * 5 + c
const sIn = (r, c) => r >= 0 && r < 5 && c >= 0 && c < 5
const sTurnNext = (t) => (t === "P1" ? "P2" : "P1")

function sOwner(piece) {
  if (!piece) return ""
  return piece === piece.toUpperCase() ? "P1" : "P2"
}

function sType(piece) {
  return piece ? piece.toUpperCase() : ""
}

function sForward(player) {
  return player === "P1" ? -1 : 1
}

function sGlyph(piece) {
  if (!piece) return ""
  const map = { K: "玉", G: "金", S: "銀", P: "歩" }
  const label = map[sType(piece)] || piece
  if (sOwner(piece) === "P2") return `<span class="p2">${label}</span>`
  return label
}

function sMoves(index) {
  const piece = s.board[index]
  if (!piece) return []
  const owner = sOwner(piece)
  if (owner !== s.turn) return []
  const type = sType(piece)
  const r = Math.floor(index / 5)
  const c = index % 5
  const f = sForward(owner)
  const deltas = []

  if (type === "K") {
    deltas.push(
      [-1, -1], [-1, 0], [-1, 1],
      [0, -1],           [0, 1],
      [1, -1],  [1, 0],  [1, 1],
    )
  } else if (type === "G") {
    deltas.push([f, -1], [f, 0], [f, 1], [0, -1], [0, 1], [-f, 0])
  } else if (type === "S") {
    deltas.push([f, -1], [f, 0], [f, 1], [-f, -1], [-f, 1])
  } else if (type === "P") {
    deltas.push([f, 0])
  }

  const out = []
  for (const [dr, dc] of deltas) {
    const rr = r + dr
    const cc = c + dc
    if (!sIn(rr, cc)) continue
    const to = sId(rr, cc)
    const target = s.board[to]
    if (!target || sOwner(target) !== owner) out.push(to)
  }
  return out
}

function sRender() {
  sBoardEl.innerHTML = ""
  const legal = s.selected >= 0 ? new Set(sMoves(s.selected)) : new Set()

  for (let i = 0; i < 25; i += 1) {
    const btn = document.createElement("button")
    const piece = s.board[i]
    if (piece) btn.innerHTML = sGlyph(piece)
    if (s.selected === i) btn.classList.add("sel")
    if (legal.has(i)) btn.classList.add("legal")
    btn.onclick = () => sTap(i, legal)
    sBoardEl.appendChild(btn)
  }

  if (s.over) {
    sInfoEl.textContent = `終了: ${s.winner} の勝ち`
  } else {
    sInfoEl.textContent = `${s.turn === "P1" ? "先手" : "後手"}の番`
  }
}

function sTap(index, legal) {
  if (s.over) return
  const piece = s.board[index]

  if (s.selected < 0) {
    if (piece && sOwner(piece) === s.turn) {
      s.selected = index
      sRender()
    }
    return
  }

  if (index === s.selected) {
    s.selected = -1
    sRender()
    return
  }

  if (legal.has(index)) {
    const from = s.selected
    const moving = s.board[from]
    const captured = s.board[index]
    s.board[index] = moving
    s.board[from] = ""
    s.selected = -1

    if (captured && sType(captured) === "K") {
      s.over = true
      s.winner = s.turn === "P1" ? "先手" : "後手"
      sRender()
      return
    }

    s.turn = sTurnNext(s.turn)
    sRender()
    return
  }

  if (piece && sOwner(piece) === s.turn) {
    s.selected = index
  } else {
    s.selected = -1
  }
  sRender()
}

function initShogi() {
  s.board = [
    "s", "k", "g", "s", "p",
    "",  "",  "p", "",  "",
    "",  "",  "",  "",  "",
    "",  "",  "P", "",  "",
    "P", "S", "G", "K", "S",
  ]
  s.turn = "P1"
  s.selected = -1
  s.over = false
  s.winner = ""
  sRender()
}

const c4 = { board: [], turn: 1, over: false, winner: 0 }
const c4InfoEl = document.getElementById("connectInfo")
const c4ControlsEl = document.getElementById("c4Controls")
const c4BoardEl = document.getElementById("c4Board")
const C4_ROWS = 6
const C4_COLS = 7

function c4Inside(r, c) {
  return r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS
}

function c4CheckDir(r, c, dr, dc, player) {
  let count = 0
  let rr = r
  let cc = c
  while (c4Inside(rr, cc) && c4.board[rr][cc] === player) {
    count += 1
    rr += dr
    cc += dc
  }
  return count
}

function c4IsWin(r, c, player) {
  const lines = [
    [[0, -1], [0, 1]],
    [[-1, 0], [1, 0]],
    [[-1, -1], [1, 1]],
    [[-1, 1], [1, -1]],
  ]
  for (const [a, b] of lines) {
    const total = c4CheckDir(r, c, a[0], a[1], player) + c4CheckDir(r, c, b[0], b[1], player) - 1
    if (total >= 4) return true
  }
  return false
}

function c4Drop(col) {
  if (c4.over) return
  let row = -1
  for (let r = C4_ROWS - 1; r >= 0; r -= 1) {
    if (c4.board[r][col] === 0) {
      row = r
      break
    }
  }
  if (row < 0) return

  c4.board[row][col] = c4.turn
  if (c4IsWin(row, col, c4.turn)) {
    c4.over = true
    c4.winner = c4.turn
    c4Render()
    return
  }

  const full = c4.board.every((line) => line.every((v) => v !== 0))
  if (full) {
    c4.over = true
    c4.winner = 0
    c4Render()
    return
  }

  c4.turn = c4.turn === 1 ? 2 : 1
  c4Render()
}

function c4Render() {
  c4ControlsEl.innerHTML = ""
  for (let c = 0; c < C4_COLS; c += 1) {
    const btn = document.createElement("button")
    btn.textContent = String(c + 1)
    btn.disabled = c4.over
    btn.onclick = () => c4Drop(c)
    c4ControlsEl.appendChild(btn)
  }

  c4BoardEl.innerHTML = ""
  for (let r = 0; r < C4_ROWS; r += 1) {
    const row = document.createElement("div")
    row.className = "c4-row"
    for (let c = 0; c < C4_COLS; c += 1) {
      const cell = document.createElement("div")
      const v = c4.board[r][c]
      cell.className = `c4-cell${v === 1 ? " p1" : v === 2 ? " p2" : ""}`
      row.appendChild(cell)
    }
    c4BoardEl.appendChild(row)
  }

  if (c4.over) {
    if (c4.winner === 0) {
      c4InfoEl.textContent = "終了: 引き分け"
    } else {
      c4InfoEl.textContent = `終了: ${c4.winner === 1 ? "先手" : "後手"}の勝ち`
    }
  } else {
    c4InfoEl.textContent = `${c4.turn === 1 ? "先手" : "後手"}の番`
  }
}

function initConnect4() {
  c4.board = Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(0))
  c4.turn = 1
  c4.over = false
  c4.winner = 0
  c4Render()
}

void initAuth()
