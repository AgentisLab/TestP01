# Gas Tracker — PWA v0.5

Installable, offline-capable Progressive Web App for finding the cheapest fuel
nearby. Smartphone portrait only (~360–430px) for this phase — no tablet/desktop
layouts.

## Surfaces

- **Onboarding** — welcome → fuel type (regular / super / diesel) → favorite brands (multi-select)
- **Map** — cheapest-hero pin with smart callout + satellite pins → mini-card hero
- **Pricing** — live price list by fuel type, regional average, favorites first
- **Settings** — profile, favorite brands, notification toggles, version

## Stack

Static HTML/CSS/JS — **no build step**. Deploys as-is on Vercel.

- `index.html` — single-page app shell (4 tab/section views)
- `manifest.webmanifest` — PWA manifest (standalone, theme `#0284c7`)
- `sw.js` — service worker, cache-first app shell (installable + offline)
- `vercel.json` — static deploy config
- `icons/` — 192 & 512 PWA icons

## Brand

AgentisLab: primary `#0284c7`, Inter (UI), Space Grotesk (headings), light theme only.

## Data

Mock adapter in `index.html` (fuel types match the live schema: `regular` / `super`
/ `diesel`). Live Neon read wiring is a follow-up; the app is fully navigable in
mock mode with no external dependency.
