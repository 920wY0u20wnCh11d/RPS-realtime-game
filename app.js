const MAX_PLAYERS = 32;
const ROUND_SECONDS = 10;
const STORE_KEY = "rps8.v1";
const GENESIS = "GEN-0";

const MOVES = ["R", "P", "S"];
const MOVE_LABEL = { R: "🪨", P: "📄", S: "✂️" };

const els = {
  entry: document.getElementById("entry"),
  game: document.getElementById("game"),
  joinFields: document.getElementById("joinFields"),
  nameInput: document.getElementById("nameInput"),
  roomInput: document.getElementById("roomInput"),
  createBtn: document.getElementById("createBtn"),
  joinBtn: document.getElementById("joinBtn"),
  roomCode: document.getElementById("roomCode"),
  timer: document.getElementById("timer"),
  head: document.getElementById("head"),
  status: document.getElementById("status"),
  startRoundBtn: document.getElementById("startRoundBtn"),
  broadcastHeadBtn: document.getElementById("broadcastHeadBtn"),
  lobbyList: document.getElementById("lobbyList"),
  boardList: document.getElementById("boardList"),
  debtsList: document.getElementById("debtsList"),
  logList: document.getElementById("logList"),
  moveButtons: Array.from(document.querySelectorAll("[data-move]")),
};

const state = {
  config: null,
  joinMode: false,
  me: {
    n: "",
    id: "",
    r: "guest",
    t: "",
    kp: null,
  },
  roomCode: "",
  channelName: "",
  pusher: null,
  channel: null,
  connectWatchdog: null,
  realtimeReady: false,
  players: new Map(),
  isHost: false,
  hostTicker: null,
  round: null,
  series: null,
  scores: {},
  debts: {},
  ledger: [],
  logs: [],
  headWarnings: new Set(),
};

const encoder = new TextEncoder();

init().catch((err) => {
  setStatus("Boot failed", "bad");
  log(`Init error: ${err.message}`);
});

async function init() {
  hydrateStore();
  bindUi();
  state.config = await fetchConfig();
  if (!state.config.key || !state.config.cluster) {
    setStatus("Missing PUSHER_KEY/CLUSTER", "bad");
  } else {
    setStatus("Ready");
  }
  render();
}

function bindUi() {
  els.createBtn.addEventListener("click", createRoomFlow);
  els.joinBtn.addEventListener("click", joinRoomFlow);
  els.startRoundBtn.addEventListener("click", startRound);
  els.broadcastHeadBtn.addEventListener("click", broadcastHead);

  els.moveButtons.forEach((btn) => {
    btn.addEventListener("click", () => submitMove(btn.dataset.move));
  });

  els.debtsList.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement)) return;

    const debtId = target.dataset.confirm;
    if (!debtId || !state.channel) return;

    await state.channel.trigger("client-debt-confirm", {
      id: debtId,
      by: state.me.id,
      ts: Date.now(),
    });
  });
}

async function createRoomFlow() {
  const name = normalizeName(els.nameInput.value || "Host");
  if (!name) {
    setStatus("Name required", "warn");
    return;
  }

  const res = await api("/api/create-room", { name });
  if (!res.ok) {
    setStatus(`Create failed: ${res.error}`, "bad");
    return;
  }

  await connectSession({ name, ...res });
}

async function joinRoomFlow() {
  if (!state.joinMode) {
    state.joinMode = true;
    els.joinFields.classList.remove("hidden");
    els.roomInput.focus();
    return;
  }

  const name = normalizeName(els.nameInput.value);
  const roomCode = String(els.roomInput.value || "").trim();
  if (!name || !/^\d{4}$/.test(roomCode)) {
    setStatus("Valid name + 4-digit code needed", "warn");
    return;
  }

  const res = await api("/api/join-room", { name, roomCode });
  if (!res.ok) {
    setStatus(`Join failed: ${res.error}`, "bad");
    return;
  }

  await connectSession({ name, ...res });
}

async function connectSession(session) {
  state.me.n = session.name;
  state.me.id = session.playerId;
  state.me.r = session.role;
  state.me.t = session.token;
  state.roomCode = session.roomCode;
  state.channelName = session.channel;

  state.me.kp = await loadOrCreateKeys(state.me.id);

  if (state.pusher) {
    state.pusher.disconnect();
  }

  if (state.connectWatchdog) {
    clearTimeout(state.connectWatchdog);
    state.connectWatchdog = null;
  }

  state.realtimeReady = false;

  const authParams = () => ({
    token: state.me.t,
    head: ledgerHead(),
  });

  state.pusher = new Pusher(state.config.key, {
    cluster: state.config.cluster,
    authEndpoint: "/api/pusher-auth",
    auth: {
      paramsProvider: authParams,
    },
    channelAuthorization: {
      endpoint: "/api/pusher-auth",
      transport: "ajax",
      paramsProvider: authParams,
    },
  });

  state.pusher.connection.bind("error", (err) => {
    const details = formatPusherError(err);
    setStatus("Connection error", "bad");
    log(`Pusher error: ${details}`);
  });

  state.pusher.connection.bind("state_change", (states) => {
    if (!states?.current) return;
    if (states.current === "connecting") {
      setStatus("Connecting...");
    }
    if (states.current === "connected") {
      setStatus("Socket connected, joining room...");
    }
    if (states.current === "unavailable" || states.current === "failed") {
      state.realtimeReady = false;
      setStatus("Realtime unavailable", "bad");
    }
    if (states.current === "disconnected") {
      state.realtimeReady = false;
    }
  });

  state.channel = state.pusher.subscribe(state.channelName);
  bindChannel(state.channel);

  state.connectWatchdog = setTimeout(() => {
    if (!state.players.size) {
      setStatus("Join failed: auth/room subscription issue", "bad");
      log("No subscription success event. Check PUSHER env, room code, and pusher-auth response.");
    }
  }, 12000);

  els.entry.classList.add("hidden");
  els.game.classList.remove("hidden");
  saveStore();
  render();
  setStatus("Connecting...");
}

function bindChannel(channel) {
  channel.bind("pusher:subscription_succeeded", (members) => {
    if (state.connectWatchdog) {
      clearTimeout(state.connectWatchdog);
      state.connectWatchdog = null;
    }

    state.realtimeReady = true;
    state.players = new Map();
    members.each((member) => {
      state.players.set(member.id, {
        id: member.id,
        n: member.info?.n || "Player",
        r: member.info?.r || "guest",
      });
      ensureScore(member.id);
    });

    if (members.count > MAX_PLAYERS) {
      setStatus("Room over capacity (32)", "bad");
    }

    recomputeHost();
    setStatus("Connected");
    broadcastHead();
    render();
  });

  channel.bind("pusher:subscription_error", (status) => {
    if (state.connectWatchdog) {
      clearTimeout(state.connectWatchdog);
      state.connectWatchdog = null;
    }

    state.realtimeReady = false;
    const details = formatPusherError(status);
    setStatus(`Join denied (${details.slice(0, 52)})`, "bad");
    log(`Subscription error: ${details}.`);
  });

  channel.bind("pusher:member_added", (member) => {
    state.players.set(member.id, {
      id: member.id,
      n: member.info?.n || "Player",
      r: member.info?.r || "guest",
    });
    ensureScore(member.id);
    recomputeHost();
    render();

    if (state.isHost) {
      log(`${member.info?.n || member.id} joined.`);
    }
  });

  channel.bind("pusher:member_removed", (member) => {
    const left = state.players.get(member.id);
    state.players.delete(member.id);
    recomputeHost();
    log(`${left?.n || member.id} left.`);
    render();
  });

  channel.bind("client-ledger-head", (payload) => {
    if (!payload || payload.pid === state.me.id) return;
    if (payload.head !== ledgerHead()) {
      state.headWarnings.add(payload.pid);
      log(`Hash head mismatch from ${payload.pid.slice(0, 6)}.`);
    }
    render();
  });

  channel.bind("client-round-start", (payload) => {
    if (!payload || !payload.roundId || !payload.deadline) return;

    state.round = {
      id: payload.roundId,
      seriesId: payload.seriesId || null,
      deadline: payload.deadline,
      submissions: {},
      active: payload.active || activePlayerIds(),
      resolved: false,
    };

    els.timer.textContent = `${ROUND_SECONDS}s`;

    setStatus(`Round ${payload.roundId.slice(-4)} live`);
    render();
  });

  channel.bind("client-timer", (payload) => {
    if (!state.round || payload.roundId !== state.round.id) return;
    const remain = Number(payload.remain || 0);
    els.timer.textContent = `${Math.max(0, remain)}s`;
  });

  channel.bind("client-move", (payload) => {
    consumeMove(payload);
  });

  channel.bind("client-round-end", async (payload) => {
    await consumeRoundResult(payload);
  });

  channel.bind("client-debt-confirm", async (payload) => {
    await consumeDebtConfirm(payload);
  });
}

function recomputeHost() {
  const hostInRoom = Array.from(state.players.values()).find((p) => p.r === "host");
  const fallback = Array.from(state.players.values()).sort((a, b) => a.id.localeCompare(b.id))[0] || null;
  const hostId = (hostInRoom || fallback)?.id || "";
  state.isHost = hostId === state.me.id;
}

async function startRound() {
  if (!state.isHost || !state.channel || !state.realtimeReady) {
    setStatus("Only host can start", "warn");
    return;
  }

  if (state.series) {
    setStatus("Elimination series already running", "warn");
    return;
  }

  if (state.round) {
    setStatus("Round already active", "warn");
    return;
  }

  const active = activePlayerIds();
  if (active.length < 2) {
    setStatus("Need at least 2 players", "warn");
    return;
  }

  const seriesId = `s${Date.now().toString(36)}`;
  state.series = {
    id: seriesId,
    participants: [...active],
  };

  await startHostedSubRound(active, seriesId);
}

async function startHostedSubRound(active, seriesId) {
  if (!state.isHost || !state.channel || !state.realtimeReady) return;

  const contenders = active.filter((pid) => state.players.has(pid));
  if (contenders.length < 2) {
    state.round = null;
    state.series = null;
    els.timer.textContent = `${ROUND_SECONDS}s`;
    setStatus("Not enough active players", "warn");
    render();
    return;
  }

  const roundId = `r${Date.now().toString(36)}`;
  const deadline = Date.now() + ROUND_SECONDS * 1000;

  state.round = {
    id: roundId,
    seriesId,
    deadline,
    submissions: {},
    active: contenders,
    resolved: false,
  };

  els.timer.textContent = `${ROUND_SECONDS}s`;
  await state.channel.trigger("client-round-start", {
    roundId,
    seriesId,
    deadline,
    active: contenders,
  });

  hostTickerStart(roundId, deadline);
  setStatus(`Round ${roundId.slice(-4)} started`);
  render();
}

function hostTickerStart(roundId, deadline) {
  if (state.hostTicker) {
    clearInterval(state.hostTicker);
  }

  state.hostTicker = setInterval(async () => {
    if (!state.round || state.round.id !== roundId) {
      clearInterval(state.hostTicker);
      state.hostTicker = null;
      return;
    }

    const remain = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    els.timer.textContent = `${remain}s`;
    await state.channel.trigger("client-timer", { roundId, remain });

    if (remain <= 0) {
      await finalizeRound("timer");
    }
  }, 1000);
}

async function submitMove(move) {
  if (!state.round || !state.channel || !state.realtimeReady) {
    setStatus("Round inactive", "warn");
    return;
  }

  if (!state.round.active.includes(state.me.id)) {
    setStatus("You are spectating this elimination step", "warn");
    return;
  }

  if (!MOVES.includes(move)) return;

  if (state.round.submissions[state.me.id]) {
    setStatus("Move already locked");
    return;
  }

  const roundId = state.round.id;
  const signed = await signString(`${roundId}:${move}`);
  const payload = {
    roundId,
    pid: state.me.id,
    m: move,
    a: 0,
    s: signed,
    pk: state.me.kp?.pu || null,
  };

  // Client events are not echoed back to sender; apply local submission first.
  consumeMove(payload);
  await state.channel.trigger("client-move", payload);

  setStatus(`Locked ${MOVE_LABEL[move]}`);
}

function consumeMove(payload) {
  if (!payload || !state.round || payload.roundId !== state.round.id) return;

  if (!state.round.active.includes(payload.pid)) return;
  if (state.round.submissions[payload.pid]) return;

  state.round.submissions[payload.pid] = {
    pid: payload.pid,
    m: payload.m,
    a: payload.a ? 1 : 0,
    s: payload.s || "",
    pk: payload.pk || null,
  };

  if (state.isHost && allSubmitted()) {
    finalizeRound("all_submitted");
  }

  render();
}

function allSubmitted() {
  if (!state.round) return false;
  return state.round.active.every((pid) => Boolean(state.round.submissions[pid]));
}

async function finalizeRound(reason) {
  if (!state.isHost || !state.round || state.round.resolved || !state.channel) return;
  state.round.resolved = true;

  const currentRound = state.round;

  const missing = currentRound.active.filter((pid) => !currentRound.submissions[pid]);
  missing.forEach((pid) => {
    currentRound.submissions[pid] = {
      pid,
      m: MOVES[Math.floor(Math.random() * MOVES.length)],
      a: 1,
      s: "",
      pk: null,
    };
  });

  const resolution = resolveRound(currentRound.submissions, currentRound.active);

  const moveRows = currentRound.active.map((pid) => {
      const sub = currentRound.submissions[pid];
      return { p: pid, m: sub.m, a: sub.a };
    });

  const sig = {};
  currentRound.active.forEach((pid) => {
    if (currentRound.submissions[pid].s) {
      sig[pid] = currentRound.submissions[pid].s;
    }
  });

  let phase = "tie";
  let nextActive = [...currentRound.active];
  let finalLoser = null;
  const participants = state.series?.participants || [...currentRound.active];

  if (!resolution.tie) {
    if (resolution.l.length > 1) {
      phase = "continue";
      nextActive = [...resolution.l];
    } else {
      phase = "done";
      finalLoser = resolution.l[0] || null;
      const winners = participants.filter((pid) => pid !== finalLoser && state.players.has(pid));

      winners.forEach((pid) => {
        ensureScore(pid).w += 1;
      });

      if (finalLoser) {
        ensureScore(finalLoser).l += 1;
        createDebts(currentRound.seriesId || currentRound.id, [finalLoser], winners);
      }
    }
  }

  await appendLedgerBlock({
      k: "m",
      r: currentRound.id,
      sid: currentRound.seriesId || null,
      ph: phase,
      u: resolution.u,
      w: resolution.w,
      l: resolution.l,
      m: moveRows,
      why: reason,
    }, sig);

  const payload = {
    roundId: currentRound.id,
    seriesId: currentRound.seriesId || null,
    phase,
    finalLoser,
    participants,
    nextActive,
    tie: resolution.tie,
    u: resolution.u,
    w: resolution.w,
    l: resolution.l,
    submissions: currentRound.submissions,
    debts: state.debts,
    scores: state.scores,
  };

  await state.channel.trigger("client-round-end", payload);

  if (state.hostTicker) {
    clearInterval(state.hostTicker);
    state.hostTicker = null;
  }

  applyOutcomePrompt(payload);

  state.round = null;

  if (phase === "continue" || phase === "tie") {
    const stillHost = state.isHost;
    const sid = currentRound.seriesId;
    setStatus(phase === "tie" ? "Draw, rerolling..." : "Elimination continues...");
    setTimeout(() => {
      if (!stillHost || !sid || !state.isHost || !state.realtimeReady) return;
      startHostedSubRound(nextActive, sid);
    }, 1200);
  } else {
    state.series = null;
    els.timer.textContent = `${ROUND_SECONDS}s`;
    setStatus("Series complete");
  }

  saveStore();
  render();
}

async function consumeRoundResult(payload) {
  if (!payload) return;

  if (!state.isHost) {
    state.scores = payload.scores || state.scores;
    state.debts = payload.debts || state.debts;

    if (payload.submissions) {
      const sig = {};
      Object.keys(payload.submissions).forEach((pid) => {
        if (payload.submissions[pid].s) sig[pid] = payload.submissions[pid].s;
      });

      const moveRows = Object.keys(payload.submissions).map((pid) => ({
        p: pid,
        m: payload.submissions[pid].m,
        a: payload.submissions[pid].a ? 1 : 0,
      }));

      await appendLedgerBlock({
        k: "m",
        r: payload.roundId,
        sid: payload.seriesId || null,
        ph: payload.phase || "done",
        u: payload.u,
        w: payload.w,
        l: payload.l,
        m: moveRows,
      }, sig, true);
    }
  }

  applyOutcomePrompt(payload);

  if (payload.phase === "tie") {
    log("Round tie (1 or 3 symbols). Re-roll.");
    setStatus("Draw, rerolling...");
  } else if (payload.phase === "continue") {
    log(`Round done. Elimination continues with ${payload.nextActive.length} contenders.`);
    setStatus("Elimination continues...");
  } else {
    log(`Round done. Winners: ${payload.w.length} / Losers: ${payload.l.length}`);
    setStatus("Series complete");
  }

  state.round = null;
  if (payload.phase === "done") {
    state.series = null;
    els.timer.textContent = `${ROUND_SECONDS}s`;
  }
  saveStore();
  render();
}

function applyOutcomePrompt(payload) {
  const phase = payload.phase || (payload.tie ? "tie" : "done");

  let verdict = "DRAW";
  if (phase === "continue") {
    verdict = payload.nextActive?.includes(state.me.id) ? "LOSE - play again" : "WIN - safe";
  } else if (phase === "done") {
    verdict = payload.finalLoser === state.me.id ? "LOSE" : "WIN";
  }

  setTimeout(() => {
    window.alert(`Round Result: ${verdict}`);
  }, 0);
}

function resolveRound(submissions, active) {
  const picks = active.map((pid) => submissions[pid]?.m).filter(Boolean);
  const uniq = Array.from(new Set(picks));

  if (uniq.length === 1 || uniq.length === 3) {
    return { tie: true, u: uniq, w: [], l: [] };
  }

  const [a, b] = uniq;
  const aBeatsB = beats(a, b);
  const winningChoice = aBeatsB ? a : b;

  const winners = active.filter((pid) => submissions[pid].m === winningChoice);
  const losers = active.filter((pid) => submissions[pid].m !== winningChoice);

  return { tie: winners.length === 0 || losers.length === 0, u: uniq, w: winners, l: losers };
}

function beats(a, b) {
  return (a === "R" && b === "S") || (a === "S" && b === "P") || (a === "P" && b === "R");
}

function createDebts(roundId, losers, recipients) {
  losers.forEach((loser) => {
    const need = recipients.filter((r) => r !== loser);
    if (!need.length) return;

    const id = `${roundId}:${loser}`;
    state.debts[id] = {
      id,
      r: roundId,
      l: loser,
      p: need,
      c: [],
      th: Math.ceil(need.length / 2),
      d: 0,
    };
  });
}

async function consumeDebtConfirm(payload) {
  if (!payload || !payload.id || !payload.by) return;

  const debt = state.debts[payload.id];
  if (!debt || debt.d) return;
  if (!debt.p.includes(payload.by)) return;

  if (!debt.c.includes(payload.by)) {
    debt.c.push(payload.by);
  }

  if (!debt.d && debt.c.length >= debt.th) {
    debt.d = 1;
    ensureScore(debt.l).sd += 1;

    await appendLedgerBlock({
      k: "sd",
      id: debt.id,
      l: debt.l,
      c: debt.c.length,
      th: debt.th,
    });

    log(`Debt dismissed for ${shortName(debt.l)} at 50% confirmations.`);
  }

  saveStore();
  render();
}

function activePlayerIds() {
  return Array.from(state.players.keys()).slice(0, MAX_PLAYERS);
}

async function appendLedgerBlock(data, signatures = {}, fromRemote = false) {
  const i = state.ledger.length;
  const t = Date.now();
  const ph = i ? state.ledger[i - 1].h : GENESIS;
  const p = state.me.id;

  const payload = { i, t, ph, d: data, sig: signatures, p };
  payload.h = await sha256Hex(JSON.stringify(payload));

  state.ledger.push(payload);
  await maybePruneLedger();

  if (!fromRemote) {
    broadcastHead();
  }

  saveStore();
  renderHead();
}

async function maybePruneLedger() {
  const settled = state.ledger.filter((b) => b.d?.k === "sd");
  if (settled.length < 8) return;

  const cut = settled.length - 2;
  if (cut <= 0) return;

  const pruneHashes = new Set(settled.slice(0, cut).map((b) => b.h));
  const keep = state.ledger.filter((b) => !pruneHashes.has(b.h));

  const checkpointData = {
    k: "cp",
    c: cut,
    f: settled[0].h,
    z: settled[cut - 1].h,
    at: Date.now(),
  };

  const checkpoint = {
    i: 0,
    t: Date.now(),
    ph: GENESIS,
    d: checkpointData,
    sig: {},
    p: state.me.id,
    h: "",
  };

  const rebuilt = [checkpoint, ...keep];
  state.ledger = await resealLedger(rebuilt);
  log(`Ledger pruned: ${cut} settled blocks folded into checkpoint.`);
}

async function resealLedger(chain) {
  const rebuilt = [];
  for (let i = 0; i < chain.length; i += 1) {
    const prev = rebuilt[i - 1];
    const ph = i === 0 ? GENESIS : prev.h;
    const block = {
      i,
      t: chain[i].t,
      ph,
      d: chain[i].d,
      sig: chain[i].sig || {},
      p: chain[i].p,
      h: "",
    };
    block.h = await sha256Hex(JSON.stringify(block));
    rebuilt.push(block);
  }
  return rebuilt;
}

function broadcastHead() {
  if (!state.channel || !state.realtimeReady) {
    setStatus("Not connected yet", "warn");
    return;
  }

  state.channel.trigger("client-ledger-head", {
    pid: state.me.id,
    head: ledgerHead(),
    len: state.ledger.length,
  });
}

function ledgerHead() {
  return state.ledger.length ? state.ledger[state.ledger.length - 1].h : GENESIS;
}

function ensureScore(pid) {
  if (!state.scores[pid]) {
    state.scores[pid] = { w: 0, l: 0, sd: 0 };
  }
  return state.scores[pid];
}

function setStatus(msg, cls = "") {
  els.status.textContent = msg;
  els.status.className = `metric ${cls}`.trim();
}

function shortName(pid) {
  return state.players.get(pid)?.n || pid.slice(0, 6);
}

function log(message) {
  state.logs.unshift(`[${new Date().toLocaleTimeString()}] ${message}`);
  state.logs = state.logs.slice(0, 60);
  renderLog();
}

function render() {
  els.roomCode.textContent = state.roomCode || "----";
  renderHead();
  renderLobby();
  renderBoard();
  renderDebts();
  renderLog();

  els.startRoundBtn.disabled = !state.isHost || Boolean(state.round) || Boolean(state.series);
}

function renderHead() {
  const head = ledgerHead();
  els.head.textContent = head === GENESIS ? GENESIS : head.slice(0, 14);
  if (state.headWarnings.size) {
    els.head.textContent += ` !${state.headWarnings.size}`;
    els.head.className = "metric hash bad";
  } else {
    els.head.className = "metric hash";
  }
}

function renderLobby() {
  const list = Array.from(state.players.values())
    .sort((a, b) => a.n.localeCompare(b.n))
    .map((p) => {
      const you = p.id === state.me.id ? " (YOU)" : "";
      const host = p.r === "host" ? " [HOST]" : "";
      return `<li>${p.n}${you}${host}</li>`;
    })
    .join("");
  els.lobbyList.innerHTML = list || "<li>No players</li>";
}

function renderBoard() {
  const rows = Array.from(state.players.values()).map((p) => {
    const s = ensureScore(p.id);
    return {
      n: p.n,
      id: p.id,
      net: s.w - s.l,
      w: s.w,
      l: s.l,
      sd: s.sd,
    };
  });

  rows.sort((a, b) => b.net - a.net || b.sd - a.sd || a.n.localeCompare(b.n));

  els.boardList.innerHTML = rows
    .map((r, idx) => `<li>#${idx + 1} ${r.n} | Net ${r.net} | W${r.w}/L${r.l} | Settled ${r.sd}</li>`)
    .join("");
}

function renderDebts() {
  const entries = Object.values(state.debts);
  if (!entries.length) {
    els.debtsList.innerHTML = "<li>No debts yet.</li>";
    return;
  }

  entries.sort((a, b) => b.r.localeCompare(a.r));

  els.debtsList.innerHTML = entries
    .map((d) => {
      const loser = shortName(d.l);
      const recipients = d.p.map(shortName).join(", ");
      const mine = d.p.includes(state.me.id) && !d.c.includes(state.me.id) && !d.d;
      const badge = d.d ? "<span class='good'>DISMISSED</span>" : "<span class='warn'>ACTIVE</span>";
      const btn = mine ? `<button class='btn btn-alt' data-confirm='${d.id}'>Confirm Drink Received</button>` : "";
      return `<li>${badge} | ${loser} owes: ${recipients}<br/>Confirmations: ${d.c.length}/${d.th}${btn}</li>`;
    })
    .join("");
}

function renderLog() {
  els.logList.innerHTML = state.logs.map((line) => `<li>${line}</li>`).join("");
}

async function fetchConfig() {
  const res = await fetch("/api/public-config");
  if (!res.ok) return { key: "", cluster: "" };
  return res.json();
}

async function api(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({ ok: false, error: "bad_json" }));
  return data;
}

function normalizeName(name) {
  return String(name || "").trim().replace(/\s+/g, " ").slice(0, 20);
}

function formatPusherError(value) {
  if (value == null) return "unknown";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const best =
    value?.error?.data?.error ||
    value?.error?.data?.message ||
    value?.error?.message ||
    value?.message ||
    value?.type;

  if (best) {
    const status = value?.status || value?.error?.data?.status;
    return status ? `${best} (status ${status})` : String(best);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return "unreadable_error";
  }
}

function hydrateStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1) return;

    state.me = {
      ...state.me,
      ...parsed.me,
      n: parsed.me?.n || "",
      id: parsed.me?.id || "",
      r: parsed.me?.r || "guest",
      t: parsed.me?.t || "",
      kp: parsed.me?.kp || null,
    };
    state.ledger = Array.isArray(parsed.l) ? parsed.l : [];
    state.scores = parsed.sc || {};
    state.debts = parsed.db || {};
  } catch {
    localStorage.removeItem(STORE_KEY);
  }
}

function saveStore() {
  const compact = {
    v: 1,
    me: state.me,
    l: state.ledger,
    sc: state.scores,
    db: state.debts,
  };

  localStorage.setItem(STORE_KEY, JSON.stringify(compact));
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function signString(message) {
  if (!state.me.kp?.pr) return "";
  const key = await crypto.subtle.importKey(
    "jwk",
    state.me.kp.pr,
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    key,
    encoder.encode(message)
  );

  return bytesToBase64(new Uint8Array(sig));
}

async function loadOrCreateKeys(playerId) {
  const kp = state.me.kp;
  if (kp?.pu && kp?.pr) return kp;

  const generated = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );

  const pu = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const pr = await crypto.subtle.exportKey("jwk", generated.privateKey);

  const pair = {
    kid: await sha256Hex(`${playerId}:${JSON.stringify(pu)}`),
    pu,
    pr,
  };

  state.me.kp = pair;
  saveStore();
  return pair;
}

function bytesToBase64(bytes) {
  let str = "";
  bytes.forEach((b) => {
    str += String.fromCharCode(b);
  });
  return btoa(str);
}
