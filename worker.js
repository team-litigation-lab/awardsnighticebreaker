// VA Life Bingo on Cloudflare.
// The Worker serves public/index.html (the game) and hands /ws and /api/* to one
// Durable Object, "Game", which holds the whole live game and pushes every change
// to every open screen over WebSockets (hibernation API, so idle sockets cost nothing).

import { DurableObject } from "cloudflare:workers";

// The game file is written as a page body (that is how claude.ai artifacts are authored),
// so the Worker wraps it in a document shell before serving it.
const SHELL_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
  `<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}` +
  `body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>` +
  `</head><body>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/ping") return json({ ok: true });
    if (url.pathname === "/ws" || url.pathname.startsWith("/api/")) {
      return env.GAME.get(env.GAME.idFromName("main")).fetch(request);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const res = await env.ASSETS.fetch(new Request(new URL("/", url)));
      if (!res.ok) return res;
      const body = await res.text();
      const html = /^\s*<!doctype/i.test(body) ? body : SHELL_HEAD + body + "</body></html>";
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return env.ASSETS.fetch(request);
  },
};

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/* ---------------- validation helpers ---------------- */
const MAX_CARDS = 150, ITEM_COUNT = 29;
const PATTERNS = ["line", "corners", "stamp", "plus", "smallx", "block", "diag", "cross"];
const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function cleanGame(g) {
  g = g && typeof g === "object" ? g : {};
  const called = [];
  for (const x of Array.isArray(g.called) ? g.called : []) { const i = int(x, 0, ITEM_COUNT - 1); if (i !== null && !called.includes(i)) called.push(i); }
  const winners = (Array.isArray(g.winners) ? g.winners : []).slice(-300).map(w => ({
    kind: w && w.kind === "raffle" ? "raffle" : "bingo", uid: str(w && w.uid, 80), name: str(w && w.name, 40),
    card: int(w && w.card, 1, MAX_CARDS) || 0, round: int(w && w.round, 1, 9999) || 1, at: num(w && w.at),
  }));
  const pattern = PATTERNS.includes(g.pattern) ? g.pattern : "line";
  const used = (Array.isArray(g.used) ? g.used : []).filter(k => PATTERNS.includes(k)).slice(0, PATTERNS.length);
  return { round: int(g.round, 1, 9999) || 1, called, winners, deck: [100, 120, 150].includes(g.deck) ? g.deck : 120, pattern, used: used.length ? used : [pattern] };
}
function cleanMarks(m) {
  const cells = [];
  for (const x of m && Array.isArray(m.cells) ? m.cells : []) { const i = int(x, 0, 24); if (i !== null && !cells.includes(i)) cells.push(i); }
  return { round: int(m && m.round, 1, 9999) || 1, cells };
}
function cleanBingo(b, allowStatus) {
  if (!b || typeof b !== "object") return null;
  const out = { round: int(b.round, 1, 9999) || 1, at: num(b.at) };
  if (allowStatus && (b.status === "confirmed" || b.status === "dismissed")) out.status = b.status;
  return out;
}
function cleanShouts(items) {
  return (Array.isArray(items) ? items : []).slice(0, 30).map(it => ({
    id: str(it && it.id, 32), to: str(it && it.to, 40), msg: str(it && it.msg, 160), sticker: str(it && it.sticker, 24), at: num(it && it.at),
  })).filter(it => it.id && it.to && it.msg);
}
function cleanMod(m) {
  const list = a => (Array.isArray(a) ? a : []).map(x => str(x, 120)).filter(Boolean).slice(0, 5000);
  return { hidden: list(m && m.hidden), approved: list(m && m.approved), requireApproval: !!(m && m.requireApproval) };
}

/* ---------------- the live game ---------------- */
export class Game extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.loginTries = new Map();
    ctx.blockConcurrencyWhile(async () => {
      const all = await ctx.storage.list();
      this.game = cleanGame(all.get("game"));
      this.mod = cleanMod(all.get("mod"));
      this.pinHash = all.get("pin") || null;
      this.cards = new Map(); this.players = new Map(); this.shouts = new Map(); this.tokens = new Map();
      for (const [k, v] of all) {
        if (k.startsWith("card:")) this.cards.set(+k.slice(5), v);
        else if (k.startsWith("player:")) this.players.set(k.slice(7), v);
        else if (k.startsWith("shout:")) this.shouts.set(k.slice(6), v);
        else if (k.startsWith("tok:")) this.tokens.set(k.slice(4), v);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      const uid = str(url.searchParams.get("uid"), 64);
      if (!/^g_[a-z0-9]{8,40}$/.test(uid)) return new Response("Missing player id", { status: 400 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["u:" + uid]);
      pair[1].serializeAttachment({ uid, ok: false });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/api/stats") return json({ guests: this.cards.size, calls: this.game.called.length, round: this.game.round, shoutOuts: [...this.shouts.values()].reduce((n, d) => n + (d.items || []).length, 0) });
    return json({ error: "not found" }, 404);
  }

  /* ---- messaging ---- */
  broadcast(msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets()) { try { ws.send(s); } catch (e) {} } }
  toUser(uid, msg) { const s = JSON.stringify(msg); for (const ws of this.ctx.getWebSockets("u:" + uid)) { try { ws.send(s); } catch (e) {} } }
  claims() {
    const out = {};
    for (const [uid, p] of this.players) if (p.claimRound === this.game.round) out[uid] = p;
    return out;
  }
  snapshot(uid, host) {
    return {
      game: this.game, cards: Object.fromEntries(this.cards), claims: this.claims(),
      shouts: Object.fromEntries(this.shouts), mod: this.mod, me: this.players.get(uid) || null,
      hostSet: !!this.pinHash, host,
    };
  }
  async isHost(pin) { return !!(this.pinHash && typeof pin === "string" && pin && (await sha("vlb:" + pin)) === this.pinHash); }

  async webSocketMessage(ws, raw) {
    let m; try { m = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch (e) { return; }
    const id = m && m.id;
    const reply = (o) => { try { ws.send(JSON.stringify({ re: id, ...o })); } catch (e) {} };
    const att = ws.deserializeAttachment() || {};
    try {
      if (m.op === "hello") {
        const tok = str(m.token, 80);
        if (tok.length < 16) return reply({ ok: false, code: "auth" });
        const known = this.tokens.get(att.uid), h = await sha("tok:" + tok);
        if (known && known !== h) return reply({ ok: false, code: "auth", message: "This device id belongs to someone else." });
        if (!known) { this.tokens.set(att.uid, h); await this.ctx.storage.put("tok:" + att.uid, h); }
        ws.serializeAttachment({ uid: att.uid, ok: true });
        return reply({ ok: true, snap: this.snapshot(att.uid, await this.isHost(m.pin)) });
      }
      if (!att.ok) return reply({ ok: false, code: "auth" });
      const uid = att.uid;
      const result = await this.handle(uid, m);
      reply({ ok: true, ...(result || {}) });
    } catch (e) {
      reply({ ok: false, code: (e && e.code) || "error", message: (e && e.message) || "" });
    }
  }
  async webSocketClose(ws) { try { ws.close(); } catch (e) {} }
  async webSocketError(ws) { try { ws.close(); } catch (e) {} }

  async handle(uid, m) {
    const fail = (code, message) => { const e = new Error(message || code); e.code = code; throw e; };
    const needHost = async () => { if (!(await this.isHost(m.pin))) fail("forbidden", "Only the host can do that."); };
    switch (m.op) {
      case "claim": {
        // checked and set without any await in between, so two guests can never get the same card
        const no = int(m.no, 1, MAX_CARDS), name = str(m.name, 40);
        if (!no || !name) fail("invalid_argument", "A card number and a name are required.");
        const cur = this.cards.get(no);
        if (cur && cur.owner !== uid) fail("taken");
        const prev = this.players.get(uid);
        const me = { name, card: no, marks: { round: this.game.round, cells: [] }, bingo: null, claimRound: 0, joinedAt: Date.now() };
        this.cards.set(no, { owner: uid, name, at: Date.now() });
        this.players.set(uid, me);
        const writes = { ["card:" + no]: this.cards.get(no), ["player:" + uid]: me };
        if (prev && prev.card && prev.card !== no && this.cards.get(prev.card)?.owner === uid) {
          this.cards.delete(prev.card); await this.ctx.storage.delete("card:" + prev.card);
          this.broadcast({ t: "card", no: prev.card, data: null });
        }
        await this.ctx.storage.put(writes);
        this.broadcast({ t: "card", no, data: this.cards.get(no) });
        this.toUser(uid, { t: "me", data: me });
        return { me };
      }
      case "release": {
        const no = int(m.no, 1, MAX_CARDS), card = no && this.cards.get(no);
        if (!card) return {};
        if (card.owner !== uid) await needHost();
        const owner = card.owner;
        this.cards.delete(no); await this.ctx.storage.delete("card:" + no);
        const p = this.players.get(owner);
        if (p && p.card === no) { this.players.delete(owner); await this.ctx.storage.delete("player:" + owner); this.toUser(owner, { t: "me", data: null }); }
        this.broadcast({ t: "card", no, data: null });
        if (p && p.claimRound === this.game.round) this.broadcast({ t: "claims", players: this.claims() });
        return {};
      }
      case "patchMe": {
        const p = this.players.get(uid);
        if (!p) fail("invalid_argument", "Register for a card first.");
        const patch = m.patch || {}, next = { ...p };
        if ("marks" in patch) next.marks = cleanMarks(patch.marks);
        if ("bingo" in patch) next.bingo = cleanBingo(patch.bingo, false);
        if ("claimRound" in patch) next.claimRound = int(patch.claimRound, 0, 9999) || 0;
        this.players.set(uid, next); await this.ctx.storage.put("player:" + uid, next);
        this.toUser(uid, { t: "me", data: next });
        if (next.claimRound === this.game.round) this.broadcast({ t: "claims", players: this.claims() });
        return {};
      }
      case "patchPlayer": {
        await needHost();
        const target = str(m.target, 64), p = this.players.get(target);
        if (!p) return {};
        const next = { ...p };
        if (m.patch && "bingo" in m.patch) next.bingo = cleanBingo(m.patch.bingo, true);
        this.players.set(target, next); await this.ctx.storage.put("player:" + target, next);
        this.toUser(target, { t: "me", data: next });
        this.broadcast({ t: "claims", players: this.claims() });
        return {};
      }
      case "saveGame": {
        await needHost();
        const before = this.game.round;
        this.game = cleanGame(m.game); await this.ctx.storage.put("game", this.game);
        this.broadcast({ t: "game", game: this.game });
        if (this.game.round !== before) this.broadcast({ t: "claims", players: this.claims() });
        return {};
      }
      case "saveShouts": {
        const name = str(m.name, 40), items = cleanShouts(m.items);
        if (!name) fail("invalid_argument", "Add your name.");
        const doc = { name, items, updatedAt: Date.now() };
        this.shouts.set(uid, doc); await this.ctx.storage.put("shout:" + uid, doc);
        this.broadcast({ t: "shout", uid, data: doc });
        return {};
      }
      case "saveMod": {
        await needHost();
        this.mod = cleanMod(m.mod); await this.ctx.storage.put("mod", this.mod);
        this.broadcast({ t: "mod", mod: this.mod });
        return {};
      }
      case "hostLogin": {
        const pin = str(m.pin, 40);
        const now = Date.now(), tries = (this.loginTries.get(uid) || []).filter(t => now - t < 60000);
        if (tries.length >= 6) fail("rate_limited", "Too many tries. Wait a minute and try again.");
        tries.push(now); this.loginTries.set(uid, tries);
        if (pin.length < 4) fail("invalid_argument", "The PIN needs at least 4 characters.");
        if (!this.pinHash) {
          this.pinHash = await sha("vlb:" + pin); await this.ctx.storage.put("pin", this.pinHash);
          this.broadcast({ t: "hostSet" });
          return { created: true };
        }
        if (!(await this.isHost(pin))) fail("badpin", "That PIN is not right.");
        return {};
      }
      default: fail("invalid_argument", "Unknown action.");
    }
  }
}
