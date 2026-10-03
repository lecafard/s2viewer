# S2 Grid Viewer

## Run locally

```sh
pnpm install
cp .env.example .env
```

Set `VITE_PROTOMAPS_API_KEY` in `.env`, then start the development server:

```sh
pnpm dev
```

Vite exposes `VITE_` variables to the browser. The Protomaps key is therefore included in map requests; configure its allowed origins in your Protomaps account. Without a key, the viewer uses OpenFreeMap.

## Visible S2 levels

Change `VISIBLE_LEVEL_COUNT` in `src/lib/s2.ts` to set how many grid levels are shown at once. Use a value from 1 to 31.
