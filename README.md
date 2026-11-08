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

- `GET /` — searchable community frontend with a local discovery inventory and next-craft branches
- `GET /health` — host health check
- `GET /api/status` — upstream commit, last update, parser status and counts
- `GET /api/recipes` — recipe map, base elements and emoji map
- `GET /api/route` — dependency-ordered completion route and reachability

The frontend reloads the API snapshot once per minute, so visitors see newly
published data without refreshing the page manually.

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


## Readium account sign-in and saved progress

The explorer can sign in with an existing Readium username and password. It uses the same Firebase Authentication project and username mapping as Readium (`<username>@readium.chat`), then reads the signed-in user's existing cloud Alchemy save from:

`userAlchemy/<Firebase UID>`

The save's `elements` array seeds the explorer's inventory. It does **not** create Readium accounts, change passwords, write discoveries back to Readium, or proxy credentials through the Node server. The explorer's manual inventory edits are temporary to the current browser session; use **Reload Readium save** to discard those edits and reload the cloud copy.

If sign-in works but the save cannot be read, the Firebase Realtime Database rules may deny reads from the Render deployment. The rules must permit an authenticated user to read only their own `userAlchemy/$uid` record. Do not make the entire `userAlchemy` tree publicly readable or writable. The Firebase Authentication authorized-domains list must also include the deployed Render hostname (and any custom domain).
