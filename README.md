# Readium Alchemy Community Index (Node.js)

A community-deployable Node.js service that independently watches the public
`readchickn/readium` repository. It needs **no upstream webhook**, no write access
to Readium, and no GitHub account. The server polls GitHub itself.

## How updates work

1. On startup, the service fetches the latest commit on the configured branch.
2. Every `POLL_SECONDS` (default: 300), it checks the GitHub commits API.
3. If the SHA changed, it downloads `index.html` from that exact commit SHA.
4. Acorn parses the inline JavaScript and extracts `ALC_RECIPES`, `ALC_EMOJI`,
   and `ALC_BASE` as literal data (it does not execute Readium's code).
5. The server recalculates reachability and a dependency-ordered crafting route.
6. The frontend and JSON API serve the latest successfully parsed snapshot.

The **My discoveries** view lets each visitor select the elements they have made.
It saves that inventory in their browser, then displays every recipe currently
craftable from pairs in that inventory as a branching ingredient → result path.
Selecting **I made this · Add** adds the result to the inventory and immediately
reveals the next set of available branches. This is local to each visitor; it
does not write to Readium or share player progress.

Using the immutable commit SHA for the raw file avoids mixing a new commit
metadata response with a stale branch-cached `index.html`. If parsing a new
commit fails, the service keeps serving the last good snapshot and reports the
error in `/api/status` and its logs.

## Run locally

Requires Node.js 20+.

```sh
npm install
npm start
```

Open `http://localhost:10000`.

## Deploy on Render

1. Fork this project or push it into a repository you control.
2. In Render, create a **Blueprint** from that repository, or create a Web
   Service with the settings below.
3. Render reads `render.yaml` and configures the Node service.
4. Deploy. No webhook configuration or secret is needed.

Manual Render settings:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/health`

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `10000` | HTTP port (Render supplies this automatically) |
| `GITHUB_REPO` | `readchickn/readium` | Public upstream repository |
| `GITHUB_BRANCH` | `main` | Branch to monitor |
| `POLL_SECONDS` | `300` | Poll interval; minimum 60 seconds |
| `GITHUB_TOKEN` | empty | Optional token for higher GitHub API rate limits |

The default five-minute interval makes 12 commit checks per hour per running
instance, comfortably below GitHub's usual unauthenticated REST API limit.
If several community instances are deployed, each instance polls independently.

## Render free-tier caveat

A process cannot poll while its hosting instance is stopped or asleep. On a
host that sleeps when idle, the next incoming request wakes the service; startup
then fetches the current upstream commit. For genuinely continuous five-minute
polling, use an always-on instance or a host that does not suspend background
processes. The application itself does not depend on a webhook.

## Endpoints

- `GET /` — searchable community frontend (`public/index.html`) with a local discovery inventory and next-craft branches
- `GET /health` — host health check
- `GET /api/version` — tiny `{status, commit, updatedAt, error}` object the frontend polls
- `GET /api/bundle` — compact payload the frontend uses (elements, recipes and route as arrays, no emoji)
- `GET /api/status` — upstream commit, last update, parser status and counts
- `GET /api/recipes` — recipe map, base elements and emoji map
- `GET /api/route` — dependency-ordered completion route and reachability

`/`, `/api/bundle`, `/api/recipes` and `/api/route` are serialised and gzipped once
per upstream commit, carry an `ETag`, and answer `If-None-Match` with `304`.
The frontend polls `/api/version` every five minutes (skipped while the page is
hidden) and only downloads and redraws when the commit changed.

## Kindle browser notes

The frontend targets the Kindle experimental browser (Chromium 75, JIT-less,
e-ink). Keep `public/index.html` to ES2019 (no `?.`, `??`, `replaceChildren`),
system fonts, no emoji, no transitions or animations, no flexbox `gap`, and
48px touch targets. Lists are paged ("Show more") and use one delegated event
listener per view so the interpreter and the e-ink panel redraw as little as
possible.

## Community maintenance

- Open an issue if the upstream HTML structure changes or parsing fails.
- Pull requests are welcome for parser compatibility, accessibility, UI, and
  deployment improvements.
- Keep the extractor data-only: do not `eval` or execute upstream JavaScript.
- Keep polling respectful; avoid intervals shorter than 60 seconds.
- Do not add Firebase credentials or private player-save data. This index reads
  only public game definitions.

## Parser compatibility

The parser expects top-level literal declarations named `ALC_RECIPES`,
`ALC_EMOJI`, and `ALC_BASE` in an inline script. If upstream turns these into
computed values, moves them into external scripts, or renames them, the parser
will fail closed rather than publish partial data. Update the extractor and add
a regression fixture when that happens.
