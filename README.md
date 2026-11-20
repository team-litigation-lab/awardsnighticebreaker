# VA Life Bingo

A Christmas party icebreaker and raffle game for the 2026 LSH VA Awards Night.

`index.html` is the source of the published Claude artifact. It replaces the earlier single-device version, which is still in the git history. It has these views:

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
