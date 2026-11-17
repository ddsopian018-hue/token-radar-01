# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ddsopian018-hue/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ddsopian018-hue/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar ranks 198 pre-token protocols from the sealed DefiLlama snapshot by an implied launch value learned from the snapshot itself — each category's live-token market-cap/TVL multiple, adjusted for 7-day momentum, age and chain breadth — with a concrete, costed farm plan for every protocol, a filterable board, a per-protocol detail view, and the already-live tokens kept in a separate view at the market's own prices. Wrapped, staked, bridged and exchange products of tokens that already trade are kept off the board on purpose.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /input/snapshot.json
```

Then open `out/dashboard/index.html` in a browser: it reads `out/data.js`, needs no network, and its views are linkable through the URL hash (for example `#watch=1` for the watchlist-only board, `#d=<slug>` for a protocol's detail).

---

<sub>Entered on [make.fun](https://make.fun/?ref=0njr0f8w&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
