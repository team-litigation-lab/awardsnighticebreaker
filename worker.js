// VA Life Bingo on Cloudflare.
// The Worker serves public/index.html (the game) and keeps the live game in a D1 database.
// Phones check /api/sync every ~2 s, sending the version they hold of each part of the game
// (game, cards, shouts, mod, claims); only the parts that changed come back. Actions go to /api/act.
// (No Durable Object: the account is at its Durable Object namespace limit.)

const SHELL_HEAD = `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">` +
  `<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}` +
  `body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>` +
  `</head><body>`;

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/ping") return json({ ok: true });
      if (url.pathname === "/api/stats") { await ensureSchema(env.DB); return json(await stats(env.DB)); }
      if (url.pathname === "/api/sync" && request.method === "POST") { await ensureSchema(env.DB); const b = await body(request); return json(await steady(() => sync(env.DB, b, env))); }
      if (url.pathname === "/api/act" && request.method === "POST") { await ensureSchema(env.DB); const b = await body(request); return json(await steady(() => act(env.DB, b, env))); }
      if (url.pathname.startsWith("/api/")) return json({ ok: false, code: "not_found" }, 404);
    } catch (e) {
      if (e && e.code) return json({ ok: false, code: e.code, message: e.message || "" });
      console.error(e);
      return json({ ok: false, code: "unavailable", message: "The game hit a snag. Try again." }, 503);
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const res = await env.ASSETS.fetch(new Request(new URL("/", url)));
      if (!res.ok) return res;
      const text = await res.text();
      const html = /^\s*<!doctype/i.test(text) ? text : SHELL_HEAD + text + "</body></html>";
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }
    return env.ASSETS.fetch(request);
  },
};

// A burst of writes can find the database briefly busy. Every action is safe to repeat (each one sets a value,
// and a card claim checks who owns the card), so a momentary failure is retried here before the phone sees it.
async function steady(fn) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if ((e && e.code) || i >= 3) throw e; await new Promise(r => setTimeout(r, 40 + Math.random() * 120 * (i + 1))); }
  }
}
async function body(request) {
  const t = await request.text();
  if (t.length > 200000) fail("invalid_argument", "Too much data.");
  try { return JSON.parse(t) || {}; } catch (e) { fail("invalid_argument", "Bad request."); }
}
function fail(code, message) { const e = new Error(message || code); e.code = code; throw e; }

/* ---------------- schema (also created ahead of time; this keeps local dev and a fresh database working) ---------------- */
let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS vers(k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 1)"),
    db.prepare("CREATE TABLE IF NOT EXISTS tokens(uid TEXT PRIMARY KEY, h TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS cards(no INTEGER PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS players(uid TEXT PRIMARY KEY, data TEXT NOT NULL, claimRound INTEGER NOT NULL DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS shouts(uid TEXT PRIMARY KEY, data TEXT NOT NULL)"),
    db.prepare("INSERT OR IGNORE INTO vers(k,n) VALUES ('game',1),('cards',1),('shouts',1),('mod',1),('claims',1)"),
  ]);
  schemaReady = true;
}

/* ---------------- validation ---------------- */
const MAX_CARDS = 155, ITEM_COUNT = 29;   // 150 VAs + 5 extra cards
const PATTERNS = ["line", "corners", "stamp", "plus", "smallx", "block", "diag", "cross"];
const SECTIONS = ["game", "cards", "shouts", "mod", "claims"];
const str = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);
const num = v => (typeof v === "number" && isFinite(v) ? v : 0);
const parse = (t, d) => { try { return t ? JSON.parse(t) : d; } catch (e) { return d; } };
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
  return { round: int(g.round, 1, 9999) || 1, called, winners, deck: [100, 120, 150, 155].includes(g.deck) ? g.deck : 120, pattern, used: used.length ? used : [pattern] };
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

/* ---------------- reads ---------------- */
const bump = (db, ...keys) => db.prepare(`UPDATE vers SET n = n + 1 WHERE k IN (${keys.map(() => "?").join(",")})`).bind(...keys);
async function getGame(db) { const r = await db.prepare("SELECT v FROM kv WHERE k='game'").first(); return cleanGame(parse(r && r.v, null)); }
async function readSection(db, name, game) {
  if (name === "game") return game || getGame(db);
  if (name === "mod") { const r = await db.prepare("SELECT v FROM kv WHERE k='mod'").first(); return cleanMod(parse(r && r.v, null)); }
  if (name === "cards") { const { results } = await db.prepare("SELECT no, owner, name, at FROM cards").all(); const o = {}; for (const c of results) o[c.no] = { owner: c.owner, name: c.name, at: c.at }; return o; }
  if (name === "shouts") { const { results } = await db.prepare("SELECT uid, data FROM shouts").all(); const o = {}; for (const s of results) o[s.uid] = parse(s.data, { name: "", items: [] }); return o; }
  if (name === "claims") { const g = game || await getGame(db); const { results } = await db.prepare("SELECT uid, data FROM players WHERE claimRound = ?").bind(g.round).all(); const o = {}; for (const p of results) o[p.uid] = parse(p.data, null); return o; }
}

/* identity: each device sends a random id + secret; the first use of an id records the secret's hash */
async function identify(db, b) {
  const uid = str(b.uid, 64), tok = str(b.tok, 80);
  if (!/^g_[a-z0-9]{8,40}$/.test(uid) || tok.length < 16) fail("auth", "Missing device id.");
  const h = await sha("tok:" + tok);
  const row = await db.prepare("SELECT h FROM tokens WHERE uid = ?").bind(uid).first();
  if (!row) { await db.prepare("INSERT OR IGNORE INTO tokens(uid, h) VALUES (?, ?)").bind(uid, h).run(); const again = await db.prepare("SELECT h FROM tokens WHERE uid = ?").bind(uid).first(); if (again.h !== h) fail("auth", "This device id belongs to someone else."); }
  else if (row.h !== h) fail("auth", "This device id belongs to someone else.");
  return uid;
}
/* The host PIN is the HOST_PIN secret set in Cloudflare (Workers & Pages → awardsnighticebreaker → Settings →
   Variables and Secrets). It can't be created or changed from the website, so no guest can claim the host page.
   Without the secret, nobody can sign in as host. */
const pinOf = env => str(env && env.HOST_PIN, 40);
async function isHost(db, pin, env) {
  pin = str(pin, 40); const real = pinOf(env);
  if (!pin || real.length < 4) return false;
  return (await sha("vlb:" + pin)) === (await sha("vlb:" + real));   // compare digests, not the raw strings
}

async function sync(db, b, env) {
  // the hot path (every phone, every ~2 s): identity, versions, my card and the host PIN in ONE round trip
  const uid = str(b.uid, 64), tok = str(b.tok, 80);
  if (!/^g_[a-z0-9]{8,40}$/.test(uid) || tok.length < 16) fail("auth", "Missing device id.");
  const [tokRow, vers, meRow] = await db.batch([
    db.prepare("SELECT h FROM tokens WHERE uid = ?").bind(uid),
    db.prepare("SELECT k, n FROM vers"),
    db.prepare("SELECT data FROM players WHERE uid = ?").bind(uid),
  ]);
  if (!tokRow.results[0]) await identify(db, b);
  else if (tokRow.results[0].h !== await sha("tok:" + tok)) fail("auth", "This device id belongs to someone else.");
  const v = {}; for (const r of vers.results) v[r.k] = r.n;
  const host = await isHost(db, b.pin, env);
  const have = b.have && typeof b.have === "object" ? b.have : {};
  const out = { ok: true, v: {}, me: meRow.results[0] ? parse(meRow.results[0].data, null) : null, host, hostSet: pinOf(env).length >= 4 };
  const want = SECTIONS.filter(k => (k !== "claims" || host) && have[k] !== v[k]);
  let game = null;
  if (want.includes("game") || want.includes("claims")) game = await getGame(db);
  for (const k of want) out[k] = await readSection(db, k, game);
  for (const k of SECTIONS) if (k !== "claims" || host) out.v[k] = v[k];
  return out;
}

async function stats(db) {
  const [c, s, g] = await db.batch([db.prepare("SELECT COUNT(*) AS n FROM cards"), db.prepare("SELECT data FROM shouts"), db.prepare("SELECT v FROM kv WHERE k='game'")]);
  const game = cleanGame(parse(g.results[0] && g.results[0].v, null));
  return { guests: c.results[0].n, calls: game.called.length, round: game.round, shoutOuts: s.results.reduce((n, r) => n + (parse(r.data, { items: [] }).items || []).length, 0) };
}

/* ---------------- actions ---------------- */
const loginTries = new Map();
async function act(db, m, env) {
  const uid = await identify(db, m);
  const needHost = async () => { if (!(await isHost(db, m.pin, env))) fail("forbidden", "Only the host can do that."); };
  switch (m.op) {
    case "join": {
      // Register by name: the server picks a free card itself, so 150 people joining at once never collide.
      const name = str(m.name, 40);
      if (!name) fail("invalid_argument", "Type your name.");
      const mine = await db.prepare("SELECT no FROM cards WHERE owner = ?").bind(uid).first();
      let no = mine ? mine.no : null;
      for (let t = 0; !no && t < 8; t++) {
        const pick = await db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${MAX_CARDS})
          SELECT x FROM n WHERE x NOT IN (SELECT no FROM cards) ORDER BY random() LIMIT 1`).first();
        if (!pick) fail("full", `All ${MAX_CARDS} cards are taken.`);
        await db.prepare("INSERT INTO cards(no, owner, name, at) VALUES (?, ?, ?, ?) ON CONFLICT(no) DO NOTHING").bind(pick.x, uid, name, Date.now()).run();
        const own = await db.prepare("SELECT owner FROM cards WHERE no = ?").bind(pick.x).first();
        if (own && own.owner === uid) no = pick.x;
      }
      if (!no) fail("busy", "Lots of guests are registering right now. Tap the button again.");
      m = { ...m, no };
    }
    // falls through: claim the card picked above
    case "claim": {
      const no = int(m.no, 1, MAX_CARDS), name = str(m.name, 40);
      if (!no || !name) fail("invalid_argument", "A card number and a name are required.");
      // The card's primary key makes this atomic: of two guests claiming the same card, one insert wins.
      await db.prepare("INSERT INTO cards(no, owner, name, at) VALUES (?, ?, ?, ?) ON CONFLICT(no) DO NOTHING").bind(no, uid, name, Date.now()).run();
      const own = await db.prepare("SELECT owner FROM cards WHERE no = ?").bind(no).first();
      if (!own || own.owner !== uid) fail("taken");
      const game = await getGame(db);
      const me = { name, card: no, marks: { round: game.round, cells: [] }, bingo: null, claimRound: 0, joinedAt: Date.now() };
      await db.batch([
        db.prepare("DELETE FROM cards WHERE owner = ? AND no <> ?").bind(uid, no),   // one card per guest
        db.prepare("UPDATE cards SET name = ? WHERE no = ?").bind(name, no),
        db.prepare("INSERT OR REPLACE INTO players(uid, data, claimRound) VALUES (?, ?, 0)").bind(uid, JSON.stringify(me)),
        bump(db, "cards", "claims"),
      ]);
      return { ok: true, me };
    }
    case "release": {
      const no = int(m.no, 1, MAX_CARDS);
      const card = no && await db.prepare("SELECT owner FROM cards WHERE no = ?").bind(no).first();
      if (!card) return { ok: true };
      if (card.owner !== uid) await needHost();
      await db.batch([
        db.prepare("DELETE FROM cards WHERE no = ?").bind(no),
        db.prepare("DELETE FROM players WHERE uid = ?").bind(card.owner),
        bump(db, "cards", "claims"),
      ]);
      return { ok: true };
    }
    case "patchMe": {
      const row = await db.prepare("SELECT data FROM players WHERE uid = ?").bind(uid).first();
      if (!row) fail("invalid_argument", "Register for a card first.");
      const next = parse(row.data, {}), patch = m.patch || {};
      if ("marks" in patch) next.marks = cleanMarks(patch.marks);
      if ("bingo" in patch) next.bingo = cleanBingo(patch.bingo, false);
      if ("claimRound" in patch) next.claimRound = int(patch.claimRound, 0, 9999) || 0;
      const stmts = [db.prepare("UPDATE players SET data = ?, claimRound = ? WHERE uid = ?").bind(JSON.stringify(next), next.claimRound || 0, uid)];
      if ("bingo" in patch || "claimRound" in patch || (next.claimRound || 0) > 0) stmts.push(bump(db, "claims"));
      await db.batch(stmts);
      return { ok: true, me: next };
    }
    case "patchPlayer": {
      await needHost();
      const target = str(m.target, 64), row = await db.prepare("SELECT data FROM players WHERE uid = ?").bind(target).first();
      if (!row) return { ok: true };
      const next = parse(row.data, {});
      if (m.patch && "bingo" in m.patch) next.bingo = cleanBingo(m.patch.bingo, true);
      await db.batch([db.prepare("UPDATE players SET data = ? WHERE uid = ?").bind(JSON.stringify(next), target), bump(db, "claims")]);
      return { ok: true };
    }
    case "saveGame": {
      await needHost();
      const game = cleanGame(m.game);
      await db.batch([db.prepare("INSERT OR REPLACE INTO kv(k, v) VALUES ('game', ?)").bind(JSON.stringify(game)), bump(db, "game", "claims")]);
      return { ok: true };
    }
    case "saveShouts": {
      const name = str(m.name, 40), items = cleanShouts(m.items);
      if (!name) fail("invalid_argument", "Add your name.");
      await db.batch([db.prepare("INSERT OR REPLACE INTO shouts(uid, data) VALUES (?, ?)").bind(uid, JSON.stringify({ name, items, updatedAt: Date.now() })), bump(db, "shouts")]);
      return { ok: true };
    }
    case "saveMod": {
      await needHost();
      await db.batch([db.prepare("INSERT OR REPLACE INTO kv(k, v) VALUES ('mod', ?)").bind(JSON.stringify(cleanMod(m.mod))), bump(db, "mod")]);
      return { ok: true };
    }
    case "hostLogin": {
      const pin = str(m.pin, 40), now = Date.now();
      const tries = (loginTries.get(uid) || []).filter(t => now - t < 60000);
      if (tries.length >= 6) fail("rate_limited", "Too many tries. Wait a minute and try again.");
      tries.push(now); loginTries.set(uid, tries);
      if (pinOf(env).length < 4) fail("not_setup", "The host page is locked: no host PIN has been set up in Cloudflare yet.");
      if (!(await isHost(db, pin, env))) fail("badpin", "That PIN is not right.");
      return { ok: true, claims: await readSection(db, "claims") };
    }
    default: fail("invalid_argument", "Unknown action.");
  }
}
