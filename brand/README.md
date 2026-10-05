# AI Trading Desktop identity

The production master is `icon-master.png`. `icon-1024.png` is its 1024 px
export. Tauri generates the Windows ICO, macOS ICNS, platform PNG assets and
the small images used by the app. Run `python scripts/make-icon.py` to regenerate.
The old procedural coin icon and SVG have been replaced.

Created using the built-in image generation tool, then edited with the same
tool for edge cleanup. The tool does not expose a selectable model identifier;
GPT Images 2.5 could not be specified or verified.

## Generation prompt

Create one finished square desktop application icon for a professional AI and
quantitative cryptocurrency trading terminal. A rounded midnight navy/graphite
enamel tile, restrained polished metal edges, three ascending platinum and teal
candlesticks integrated with an angular upward market trajectory subtly
suggesting machine intelligence. Front facing, strong compact silhouette,
generous negative space, crisp thick forms readable at 16–48 px. No text,
coins, Bitcoin symbol, decorative circuitry, particles, mockup or watermark.
Transparent outside corners and small even margins.

## Refinement prompt

Preserve the candlesticks, silver trajectory, palette, rounded-square tile and
front-facing composition. Clean stray pixels outside the smooth silhouette,
with transparent margins; keep the internal design and add no objects or text.

The action controls use scalable Lucide glyphs. Twelve original strategy SVG
icons represent each strategy's signal shape; the same files are used by the
strategy picker, task avatars and the task icon picker. Existing generic server
defaults (`quant` / `factor`) resolve to the corresponding strategy icon.
Explicit custom provider/strategy choices retain priority. Strategy parameters,
paused strategy availability, task timers and server execution remain unchanged.

Visual acceptance page: `/scripts/trading-brand-ui-preview.html` on the isolated
localhost development port 5187. It renders the actual trading page with local
fixture stores, prevents external writes and does not create trading tasks.
