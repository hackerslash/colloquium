# Design — Colloquium

A locked design system for this app. Every surface reads this file before
emitting UI code. Do not regenerate per screen — extend or amend this file when
the system needs to grow.

## Genre
atmospheric — dark-first canvas, single warm accent, fade-only motion, plain
but slightly poetic copy. The instrument is dark; the conversation is the light.

## Macrostructure family
This is an app, not a marketing site. One shell, layered surfaces.

- App shell:   Workbench — persistent left rail + focused main pane. The rail
  sits on the deepest background tier; active surfaces step up in elevation.
- Modals:      centered elevated panel over a dimmed canvas, tab rail when a
  modal holds more than ~4 sections (Settings).
- Empty/first-run: centered, atmospheric ground behind the content.

## Theme — Midnight (dark, default) / Day (light)
Token **names are fixed** — Tailwind utilities (`bg-bg-base`, `text-text-muted`,
`bg-accent`) depend on them. Only values change. Values live in
`src/styles/globals.css` and are mirrored in `## Exports` below.

Dark:
- `--color-bg-base`      oklch(15% 0.028 270)   deepest indigo canvas
- `--color-bg-primary`   oklch(18% 0.030 270)
- `--color-bg-secondary` oklch(21% 0.032 270)
- `--color-bg-tertiary`  oklch(24% 0.034 270)
- `--color-bg-elevated`  oklch(21% 0.032 270)
- `--color-border`       oklch(30% 0.030 270)
- `--color-text-primary` oklch(96% 0.008 270)
- `--color-accent`       oklch(80% 0.14 75)     ember (warm amber)
- `--color-accent-ink`   oklch(20% 0.040 270)

Day: cool indigo-tinted paper, ember deepened to oklch(62% 0.13 65) for
contrast on light. Full set in `globals.css`.

Accent discipline: one warm hue (ember). Accent appears on the primary CTA,
focus rings, the active-nav indicator, unread dots, and small radial glows —
never on display text (no gradient text), never above ~5% of a viewport.

## Typography
- Display: "Fraunces Variable", roman (`font-style: normal` — never italic on
  headings or the wordmark). Used for the wordmark and empty-state titles.
- Body:    "Inter Variable", 400/500/600. `font-feature-settings: "cv05","cv11"`.
- The wordmark "Colloquium" is roman Fraunces; brand emphasis is carried by the
  ember accent, not by italics.

## Spacing
Tailwind v4 default 4-point scale (`p-3`, `gap-2`, …). No custom spacing tokens.

## Motion
- Library: `motion` (motion/react), already present.
- Reveal: fade / fade+scale only. No slide-heavy or bounce entrances on nav.
- Atmospheric ground: at most 2 static radial blooms on first-run; soft radial
  glow behind empty-state icons. Blooms are static (no animation).
- Reduced-motion: opacity-only, ≤150ms.

## Microinteractions stance
- Active-nav = a left ember indicator bar + elevated row background, not a
  hover-lift translate.
- Silent success over celebratory toasts.
- Focus rings show instantly (never animated), ≥3:1 contrast, ember.

## CTA voice
- Primary: filled ember, `--color-accent-ink` text, rounded, confident.
- Secondary: subtle elevated surface (`bg-bg-secondary`), text-primary.

## Per-surface allowances
- First-run / onboarding MAY use atmospheric CSS blooms.
- App surfaces (chat, calls, rooms) MUST NOT add enrichment — function carries.
- Empty states MAY use a single radial glow behind the icon.

## What surfaces MUST share
- The "Colloquium" wordmark (roman Fraunces).
- The ember accent and its placement (CTA, focus, active-nav, unread).
- Fraunces (display) + Inter (body).
- CTA button shape and rhythm.

## Exports

### tokens.css
```css
:root[data-theme="dark"] {
  --color-bg-base: oklch(15% 0.028 270);
  --color-bg-primary: oklch(18% 0.030 270);
  --color-bg-secondary: oklch(21% 0.032 270);
  --color-bg-tertiary: oklch(24% 0.034 270);
  --color-bg-elevated: oklch(21% 0.032 270);
  --color-border: oklch(30% 0.030 270);
  --color-border-strong: oklch(40% 0.030 270);
  --color-text-primary: oklch(96% 0.008 270);
  --color-text-secondary: oklch(76% 0.014 270);
  --color-text-muted: oklch(60% 0.018 270);
  --color-accent: oklch(80% 0.14 75);
  --color-accent-hover: oklch(85% 0.14 75);
  --color-accent-active: oklch(74% 0.13 75);
  --color-accent-ink: oklch(20% 0.040 270);
  --color-danger: oklch(65% 0.18 25);
  --color-success: oklch(74% 0.14 155);
  --color-warning: oklch(80% 0.13 80);
  --color-unread: oklch(80% 0.14 75);
  --font-display: "Fraunces Variable", ui-serif, Georgia, serif;
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
}
```

### Tailwind v4 `@theme`
The token block in `src/styles/globals.css` already exposes these via
`@theme inline`, so Tailwind utilities (`bg-bg-base`, `text-accent`, etc.) map
straight through. No separate config file.
