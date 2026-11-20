// Load test for VA Life Bingo: N players + 1 host, all at once.
// Run `npx wrangler dev --port 8788`, then `N=150 node loadtest.mjs` (BASE=host:port to point elsewhere).
const BASE = process.env.BASE || "127.0.0.1:8788", N = +(process.env.N || 150), PIN = "4321";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const lat = [], errors = {}; let pushes = 0, pushBytes = 0;
const bump = c => errors[c] = (errors[c] || 0) + 1;
function client(i, isHost) {
  const uid = "g_" + (isHost ? "host" : "p") + String(i).padStart(12, "0") + "x" + process.pid;
  const c = { uid, tok: "t" + String(i).padStart(30, "0") + process.pid, seq: 0, pend: new Map(), state: { game: null, cards: {}, me: null, claims: {} } };
  c.connect = () => new Promise((res, rej) => {
    const ws = new WebSocket(`ws://${BASE}/ws?uid=${uid}`); c.ws = ws;
    ws.onopen = async () => { try { const r = await c.send({ op: "hello", token: c.tok, pin: isHost ? PIN : "" }); Object.assign(c.state, r.snap); res(c); } catch (e) { rej(e); } };
    ws.onerror = () => rej({ code: "ws_error" });
    ws.onmessage = e => { const m = JSON.parse(e.data);
      if (m.re !== undefined) { const p = c.pend.get(m.re); if (p) { c.pend.delete(m.re); lat.push(performance.now() - p.t); m.ok ? p.res(m) : p.rej(m); } return; }
      pushes++; pushBytes += e.data.length;
      if (m.t === "game") c.state.game = m.game; else if (m.t === "card") { if (m.data) c.state.cards[m.no] = m.data; else delete c.state.cards[m.no]; }
      else if (m.t === "me") c.state.me = m.data; else if (m.t === "claims") c.state.claims = m.players; };
  });
  c.send = msg => new Promise((res, rej) => { const id = ++c.seq; c.pend.set(id, { res, rej, t: performance.now() }); c.ws.send(JSON.stringify({ ...msg, id }));
    setTimeout(() => { if (c.pend.has(id)) { c.pend.delete(id); rej({ code: "timeout" }); } }, 15000); });
  return c;
}
const CARD = no => { /* not needed server-side */ };
const t0 = performance.now(); const phase = (n) => console.log(`[${((performance.now()-t0)/1000).toFixed(1)}s] ${n}`);
const host = client(0, true); await host.connect();
await host.send({ op: "hostLogin", pin: PIN }).catch(e => bump("hostLogin:" + e.code));
const players = Array.from({ length: N }, (_, i) => client(i + 1, false));
phase(`connecting ${N} players at once`);
const conn = await Promise.allSettled(players.map(p => p.connect()));
const connected = players.filter((p, i) => conn[i].status === "fulfilled");
phase(`${connected.length}/${N} connected`);
// register: each picks a random free card, retries on "taken"
phase("everyone registers at once");
await Promise.all(connected.map(async (p, i) => {
  for (let t = 0; t < 12; t++) {
    const free = []; for (let n = 1; n <= 150; n++) if (!p.state.cards[n]) free.push(n);
    if (!free.length) { bump("register:full"); return; }
    try { const r = await p.send({ op: "claim", no: free[Math.floor(Math.random() * free.length)], name: "Guest " + (i + 1) }); p.state.me = r.me; return; }
    catch (e) { if (e.code !== "taken") { bump("register:" + e.code); return; } p.state.cards[e.no || 0] = 1; await sleep(Math.random() * 50); }
  }
  bump("register:gave_up");
}));
const registered = connected.filter(p => p.state.me && p.state.me.card);
const cardsTaken = new Set(registered.map(p => p.state.me.card));
phase(`${registered.length} registered, ${cardsTaken.size} distinct cards (duplicates: ${registered.length - cardsTaken.size})`);
// host draws 12; after each draw everyone marks within ~1s
let game = { round: 1, called: [], winners: [], deck: 150, pattern: "corners", used: ["corners"] };
for (let d = 0; d < 12; d++) {
  const left = [...Array(29).keys()].filter(x => !game.called.includes(x)); game = { ...game, called: [...game.called, left[Math.floor(Math.random() * left.length)]] };
  await host.send({ op: "saveGame", game, pin: PIN }).catch(e => bump("draw:" + e.code));
  await sleep(150);
  await Promise.all(registered.map(async p => { await sleep(Math.random() * 1000);
    const cells = Array.from({ length: Math.min(24, d + 1) }, (_, k) => k);
    await p.send({ op: "patchMe", patch: { marks: { round: 1, cells } } }).catch(e => bump("mark:" + e.code)); }));
}
const sawAllDraws = registered.filter(p => p.state.game && p.state.game.called.length === 12).length;
phase(`12 draws done; ${sawAllDraws}/${registered.length} players received every draw`);
// 30 Bingo claims at the same moment
phase("30 players call Bingo at the same moment");
await Promise.all(registered.slice(0, 30).map(p => p.send({ op: "patchMe", patch: { bingo: { round: 1, at: Date.now() }, claimRound: 1 } }).catch(e => bump("bingo:" + e.code))));
await sleep(500);
const hostClaims = Object.keys(host.state.claims || {}).length;
const guestClaimsLeak = registered.filter(p => Object.keys(p.state.claims || {}).length).length;
phase(`host sees ${hostClaims} claims; guests who received the claims list: ${guestClaimsLeak}`);
await Promise.all(Object.keys(host.state.claims).slice(0, 5).map(id => host.send({ op: "patchPlayer", target: id, patch: { bingo: { round: 1, at: 1, status: "confirmed" } }, pin: PIN }).catch(e => bump("confirm:" + e.code))));
// shout-out burst
phase("every player sends a shout-out at once");
await Promise.all(registered.map((p, i) => p.send({ op: "saveShouts", name: "Guest " + (i + 1), items: [{ id: "s" + i, to: "The whole team", msg: "Merry Christmas and thank you for an amazing 2026! #" + i, sticker: "heart", at: Date.now() }] }).catch(e => bump("shout:" + e.code))));
// everyone drops and reconnects at once
phase("everyone's connection drops and reconnects at once");
registered.forEach(p => p.ws.close()); await sleep(300);
const rec = await Promise.allSettled(registered.map(p => p.connect()));
const kept = registered.filter((p, i) => rec[i].status === "fulfilled" && p.state.me && cardsTaken.has(p.state.me.card)).length;
phase(`${rec.filter(r => r.status === "fulfilled").length}/${registered.length} reconnected; ${kept} still have their card`);
const stats = await (await fetch(`http://${BASE}/api/stats`)).json();
lat.sort((a, b) => a - b); const pct = q => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))].toFixed(0);
console.log("\nRESULT", JSON.stringify({ players: N, connected: connected.length, registered: registered.length, duplicateCards: registered.length - cardsTaken.size,
  receivedAllDraws: sawAllDraws, hostClaims, claimsLeakedToGuests: guestClaimsLeak, reconnectedWithCard: kept, serverStats: stats,
  requests: lat.length, latencyMs: { p50: pct(.5), p95: pct(.95), p99: pct(.99), max: lat[lat.length - 1].toFixed(0) },
  pushesReceived: pushes, pushMB: (pushBytes / 1e6).toFixed(2), errors }));
[host, ...players].forEach(p => { try { p.ws.close(); } catch (e) {} });
process.exit(0);
