# VA Life Bingo

A Christmas party icebreaker and raffle game for the 2026 LSH VA Awards Night.

The game is `public/index.html`. The same file runs in two places:

- **Cloudflare (this repository):** `worker.js` serves the page and keeps the live game in a **D1 database** (`awardsnighticebreaker`, bound as `DB` in `wrangler.jsonc`). Every phone checks `/api/sync` about every 2 seconds and downloads only the parts that changed; actions go to `/api/act`. Guests type their name and the server picks them a free card, so two people never get the same one. The first visit to `/#host` sets the **host PIN**. Cloudflare Workers Builds deploys `main` automatically. The game doesn't use a Durable Object because the account is at its 500-namespace limit.
- **claude.ai artifact:** live data and sign-in come from claude.ai instead.

Opened any other way (for example as a local file), the page starts a preview with example guests.

To test locally: `npx wrangler dev`, then open http://localhost:8787.

The earlier single-device version is still in the git history. It has these views:

- **Get My Card**: guests type their name and tap *Unwrap my card*. They get their own card right away.
  - No two cards have the same set of squares, and each card number has its own ornament design.
  - The game holds 100–150 cards. The host sets the limit.
- **My Card**: a large card with an icon on every square, the current ornament draw and the last five draws, plus the winning pattern for this round.
- **Host Stage**: only editors see this view. The host can:
  - draw the next call, undo the last call, or start a new round;
  - change the pattern before the first call of a round;
  - check Bingo claims, which appear in the order they arrive;
  - confirm winners and run the raffle draw.
- **Shout-outs**: guests thank a teammate in a few seconds. They type who it's for and a message (quick-start prompts help) and pick an ornament. The page shows a live feed and a "Top cheerleaders" list. The host can hide any shout-out or turn on approve-before-showing.
- **Big screen** (`#screen`): a full-screen display for a second Meet share. It shows one shout-out at a time in large type, in the order they were sent.
  - Each shout-out stays up 6–20 seconds; the presenter picks the time.
  - When the queue runs out, recent shout-outs replay as "Encore".
  - Controls hide after 3 seconds. The arrow keys and the space bar skip ahead.
- **How to Play**: the rules and every pattern.

Each new round automatically picks a pattern that hasn't been used yet. The patterns are Any line, Four corners, Postage stamp, Little plus, Little X, Any 2×2 block, Any diagonal and Middle cross.
Each pattern needs only about 4 called squares. In simulations with 150 players, the first Bingo came after 5–9 draws on average.

Opening the file outside claude.ai starts a local preview with example guests.

## Capacity

Load-tested against the real Worker with D1 (`wrangler dev`, then `N=150 node loadtest.mjs`). Every simulated phone checked in every 2 seconds for the whole test:

- **150 participants at once (run twice):**
  - All 150 registered within about 2 s, with no duplicate cards.
  - Every phone received every draw: about 1 s on average, 2.3 s at most.
  - All 30 simultaneous Bingo claims reached the host.
  - All 150 shout-outs arrived, with no errors.
- **300 at once (double):** no crash. 150 got cards and the other 150 were told the cards are full. Draws still reached every phone within 2.6 s.
- **Traffic:** about 100 requests per second with 150 people, roughly 0.7 million for a 2-hour party. That fits easily in the 10 million a month included with **Workers Paid**. The free plan's 100k a day would run out in about 20 minutes.
