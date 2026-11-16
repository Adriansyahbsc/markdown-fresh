# markdown-fresh

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Adriansyahbsc/markdown-fresh/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Adriansyahbsc/markdown-fresh/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free Markdown renderer written from scratch as a drop-in
replacement for marked 18.1.3: `parse(markdown)` returns HTML that is
byte-identical to marked's default output (GFM on) while running as a
lean single pass — a line-oriented block parser feeding a scanner-based
inline parser, with no dependencies and no state kept between calls.

## Run it

```sh
MAKEFUN_INPUT_DIR=./input MAKEFUN_OUTPUT_DIR=./output node main.ts
```

---
<sub>Entered on [make.fun](https://make.fun/?ref=kj9js265&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
