// Load test for VA Life Bingo (worker.js + D1): N players + 1 host, all at once, every phone checking in
// every ~2 s like the real page. Run `npx wrangler dev --port 8788`, then `N=150 node loadtest.mjs`
// (BASE=http://host:port to point elsewhere).
const BASE = process.env.BASE || "http://127.0.0.1:8788", N = +(process.env.N || 150), PIN = "4321";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lat = { sync: [], act: [] }, errors = {}; let syncs = 0, bytes = 0;
const bump = c => errors[c] = (errors[c] || 0) + 1;
const rnd = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
async function post(path, body, kind) {
  const t = performance.now();
  const r = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text(); bytes += text.length; lat[kind].push(performance.now() - t);
  let j; try { j = JSON.parse(text); } catch (e) { throw { code: "http_" + r.status }; }
  return j;
}
function player(i, pin) {
  const p = { uid: "g_" + rnd(20), tok: rnd(32), pin, have: {}, s: { game: null, cards: {}, me: null, claims: {} }, seen: new Map(), live: true };
  p.sync = async () => {
    try { const j = await post("/api/sync", { uid: p.uid, tok: p.tok, pin: p.pin, have: p.have }, "sync"); syncs++;
      if (!j.ok) return bump("sync:" + j.code);
      for (const k of ["game", "cards", "claims"]) if (k in j) p.s[k] = j[k];
      p.s.me = j.me; p.have = j.v;
      if (p.s.game) { const n = p.s.game.called.length; if (!p.seen.has(n)) p.seen.set(n, performance.now()); }
    } catch (e) { bump("sync:" + (e.code || "network")); }
  };
  p.loop = async () => { await sleep(Math.random() * 2000); while (p.live) { await p.sync(); await sleep(1700 + Math.random() * 600); } };
  // retries a temporary failure twice, as the real page does
  p.act = async (op, body) => { for (let i = 0; ; i++) { let j;
      try { j = await post("/api/act", { uid: p.uid, tok: p.tok, pin: p.pin, op, ...body }, "act"); } catch (e) { j = { ok: false, code: e.code || "unavailable" }; }
      if (j.ok) return j;
      if (i < 2 && /unavailable|http_5/.test(j.code)) { bump("retried:" + op); await sleep(400 + Math.random() * 900); continue; }
      throw j; } };
  return p;
}
const t0 = performance.now(), phase = n => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${n}`);
const host = player(0, PIN); await host.act("hostLogin", { pin: PIN }).catch(e => bump("hostLogin:" + e.code));
const players = Array.from({ length: N }, (_, i) => player(i + 1, ""));
phase(`${N} phones open the page and start checking in every ~2 s`);
const loops = [host, ...players].map(p => p.loop());
await sleep(2500);
phase("everyone registers at once");
await Promise.all(players.map(async (p, i) => {
  try { const j = await p.act("join", { name: "Guest " + (i + 1) }); p.s.me = j.me; }
  catch (e) { bump("register:" + e.code); }
}));
const reg = players.filter(p => p.s.me && p.s.me.card), distinct = new Set(reg.map(p => p.s.me.card));
phase(`${reg.length} registered, ${distinct.size} distinct cards (duplicates: ${reg.length - distinct.size})`);
let game = { round: 1, called: [], winners: [], deck: 150, pattern: "corners", used: ["corners"] };
const drawAt = new Map(), lags = [];
for (let d = 1; d <= 10; d++) {
  const left = [...Array(29).keys()].filter(x => !game.called.includes(x)); game = { ...game, called: [...game.called, left[Math.floor(Math.random() * left.length)]] };
  await host.act("saveGame", { game }).catch(e => bump("draw:" + e.code)); drawAt.set(d, performance.now());
  // everyone marks within ~3 s of seeing the draw (as real people would)
  await Promise.all(reg.map(async p => { await sleep(2000 + Math.random() * 3000);
    await p.act("patchMe", { patch: { marks: { round: 1, cells: Array.from({ length: d }, (_, k) => k) } } }).catch(e => bump("mark:" + e.code)); }));
}
await sleep(3000);
for (const p of reg) for (let d = 1; d <= 10; d++) if (p.seen.has(d)) lags.push(p.seen.get(d) - drawAt.get(d));
const missed = reg.filter(p => !(p.s.game && p.s.game.called.length === 10)).length;
phase(`10 draws done; phones that missed the latest draw: ${missed}`);
phase("30 players call Bingo at the same moment");
await Promise.all(reg.slice(0, 30).map(p => p.act("patchMe", { patch: { bingo: { round: 1, at: Date.now() }, claimRound: 1 } }).catch(e => bump("bingo:" + e.code))));
await sleep(3000);
phase(`host sees ${Object.keys(host.s.claims || {}).length} claims; guests holding the claims list: ${reg.filter(p => Object.keys(p.s.claims || {}).length).length}`);
phase("every player sends a shout-out at once");
await Promise.all(reg.map((p, i) => p.act("saveShouts", { name: "Guest " + (i + 1), items: [{ id: "s" + i, to: "The whole team", msg: "Merry Christmas and thank you for 2026! #" + i, sticker: "heart", at: Date.now() }] }).catch(e => bump("shout:" + e.code))));
await sleep(3000);
[host, ...players].forEach(p => p.live = false); await Promise.all(loops);
const stats = await (await fetch(BASE + "/api/stats")).json();
const pct = (a, q) => { a = a.slice().sort((x, y) => x - y); return Math.round(a[Math.min(a.length - 1, Math.floor(a.length * q))] || 0); };
const secs = (performance.now() - t0) / 1000;
console.log("\nRESULT " + JSON.stringify({ players: N, registered: reg.length, duplicateCards: reg.length - distinct.size, missedLatestDraw: missed,
  drawReachesPhonesMs: { median: pct(lags, .5), p95: pct(lags, .95), max: pct(lags, 1) },
  syncMs: { p50: pct(lat.sync, .5), p95: pct(lat.sync, .95), max: pct(lat.sync, 1) }, actionMs: { p50: pct(lat.act, .5), p95: pct(lat.act, .95), max: pct(lat.act, 1) },
  requests: syncs + lat.act.length, requestsPerSecond: +((syncs + lat.act.length) / secs).toFixed(1), seconds: +secs.toFixed(0),
  requestsPer2hProjected: Math.round((syncs + lat.act.length) / secs * 7200), MBdown: +(bytes / 1e6).toFixed(1), serverStats: stats, errors }));
process.exit(0);
