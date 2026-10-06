# 周期领航 · CyclePilot identity

The flat icon combines a white two-piece sail and a mint rising wave on a
graphite rounded tile matching the application's gray-black theme. The sail
represents navigation; the wave represents market
cycles. Broad shapes keep the mark readable in the taskbar, with transparent
outside corners and no text inside the icon.

Palette targets: graphite `#25282F`, mint `#4AE5BE`, white `#F5F6F7`.

The production master is `icon-master.png`. `icon-1024.png` is its 1024 px
export. Run `python scripts/make-icon.py` to regenerate Windows ICO, macOS
ICNS, platform PNG assets and the 64/256 px images consumed by `BrandLogo`.
The script also refreshes the 1024 px export using Tauri's `icon --png 1024`.

Created and refined using the built-in image generation tool. The tool does not
expose a selectable model identifier; GPT Images 2.5 cannot be specified or
verified. Tauri CLI performs platform asset conversion.

Visible window, login and navigation titles use 周期领航 · CyclePilot.
Package identifiers, executable names and update endpoints retain existing
values to keep installations and automatic updates compatible.

## Generation prompt

Create one exceptional flat vector-style software app icon for the brand CyclePilot (Chinese: 周期领航), an intelligent trading platform named for navigating market cycles. NEW direction: an elegant abstract sail catching the wind above one clean upward-flowing wave. One compact integrated geometric mark, no circles, no C-shaped rings, no compass arrow. Square 1024x1024 transparent canvas. A smooth rounded square cobalt-blue tile, solid #2459D3, with 3% transparent outside margins, corner radius 22%. Center a striking white minimalist sail silhouette pointing upward and slightly forward to the right. The sail consists of two beautifully proportioned triangular curved pieces with a narrow diagonal negative-space gap; think refined premium sailing/navigation identity rather than a toy sailboat or paper airplane. A SINGLE bright mint #4AE5BE curved rising wave underneath, sweeping from lower left to upper right, optically integrated with the sail base. Do not draw a literal boat hull, mast, ocean scene or illustration. Very clean broad bold geometry and carefully balanced negative space, instantly recognizable at 24 px. Mark fits in 64% of tile width. Sophisticated calm memorable identity. STRICT flat 2D fills: cobalt tile, pure white sail and mint wave only. No text, letters, numbers, shadows, gradients, shine, bevels, 3D, outlines, grain, texture, glow, mockup or presentation sheet. Rounded-square tile must have real transparent outside corners. One single centered production app icon.

## Refinement prompt

Precise production cleanup of this same CyclePilot flat sail icon. Preserve the exact beautiful white two-piece sail, mint single wave, cobalt tile, all shape geometry, proportions and composition. Fix the perimeter: perfectly smooth continuous rounded-square tile edges with no jagged projections, drips, stray blue pixels, spikes or noise outside it. Everything outside the tile must be completely transparent. Use perfectly uniform flat cobalt blue #2459D3 tile, uniform white #FFFFFF sail, uniform mint #4AE5BE wave. Remove subtle texture/grain and gradient variations. Clean antialiased geometric boundaries only. NO new elements, no rings, no circle, no compass, no text, no outline, no shadows, no glow, no 3D. Return the same square app icon, now crisp and clean.

## Approved palette adaptation prompt

Apply ONE palette adjustment to this approved CyclePilot sail app icon, for a charcoal gray and black trading application. Keep the EXACT white two-piece sail geometry, mint wave geometry, placement, spacing, proportions and rounded tile silhouette. Replace ONLY the cobalt blue tile fill with a solid neutral GRAPHITE CHARCOAL #25282F. No blue tint in the charcoal. Keep the sail solid white #F5F6F7 and the wave solid mint #4AE5BE. Pure flat 2D color fills without gradients, lighting, grain or texture. Maintain clean antialiased edges. Smooth rounded-square tile perimeter, no stray pixels outside, real transparent corners and outside margins. Do not alter the logo shapes. No additions, text, shadows, metallic shine, outlines, rings, 3D or glow. One square final production application icon, gray-black background matched to a dark trading terminal.

## Trading controls

Action controls use scalable Lucide glyphs. Twelve original strategy SVG icons
represent each strategy's signal shape; the same files are used by the strategy
picker, task avatars and task icon picker. Existing generic server defaults
(`quant` / `factor`) resolve to the corresponding strategy icon. Explicit custom
provider/strategy choices retain priority.

Visual acceptance page: `/scripts/trading-brand-ui-preview.html` on isolated
localhost port 5187. It renders the trading page with local fixture stores,
prevents external writes and does not create trading tasks.
