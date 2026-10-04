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

## Deploy to Cloudflare Pages

This is a static Vite app; it does not need a Worker adapter. The Wrangler config points Pages at Vite's `dist/` output.

### Connect a Git repository

In Cloudflare, create a **Pages** project and connect this repository with these build settings:

- Build command: `pnpm build`
- Build output directory: `dist`
- Install command: `pnpm install --frozen-lockfile`

If using Protomaps, add `VITE_PROTOMAPS_API_KEY` to the Pages project's environment variables for both Production and Preview builds. This value is embedded in the client bundle, so it is public; restrict its allowed origins in Protomaps. If unset, the app uses OpenFreeMap.

### Deploy with Wrangler

Authenticate once, create the Pages project (only needed the first time), then build and deploy:

```sh
pnpm wrangler login
pnpm wrangler pages project create s2viewer
pnpm run deploy
```

Use `pnpm run preview` to build and test the production output locally with the Pages runtime. For local deployments, put `VITE_PROTOMAPS_API_KEY` in `.env` before building.

## Visible S2 levels

Change `VISIBLE_LEVEL_COUNT` in `src/lib/s2.ts` to set how many grid levels are shown at once. Use a value from 1 to 31.

Search accepts a decimal S2 cell ID, an S2 key such as `4/001`, or a latitude/longitude pair such as `37.77, -122.42`. Searches are stored in the URL hash for sharing.
