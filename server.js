import express from "express";
import { parse } from "acorn";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const REPO = process.env.GITHUB_REPO || "readchickn/readium";
const BRANCH = process.env.GITHUB_BRANCH || "main";
const configuredPollSeconds = Number.parseInt(process.env.POLL_SECONDS || "300", 10);
const POLL_SECONDS = Number.isFinite(configuredPollSeconds) ? Math.max(60, configuredPollSeconds) : 300;
const POLL_MS = POLL_SECONDS * 1000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

let state = {
  status: "starting",
  commit: null,
  commitUrl: null,
  commitMessage: null,
  updatedAt: null,
  error: null,
  base: [],
  recipes: {},
  emoji: {},
  route: [],
  reachable: [],
  unreachable: [],
  counts: {}
};

let refreshInFlight = null;
let assets = null;

// One collator instead of repeated localeCompare calls (much faster for sorts).
const collator = new Intl.Collator("en");
const compare = collator.compare;

/*
 * Pre-serialised, pre-gzipped responses. The data only changes when the
 * upstream commit changes, so JSON.stringify and gzip run once per refresh
 * instead of once per request, and clients revalidate with a cheap 304.
 */
function makeAsset(body, type) {
  const buf = Buffer.from(body, "utf8");
  const tag = createHash("sha1").update(buf).digest("base64url").slice(0, 16);
  return { buf, gz: gzipSync(buf, { level: 9 }), etag: `W/"${tag}"`, type };
}

function sendAsset(req, res, asset) {
  if (!asset) return res.status(503).json({ error: "Data is not ready yet" });
  res.set({ ETag: asset.etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
  if (req.headers["if-none-match"] === asset.etag) return res.status(304).end();
  res.type(asset.type);
  if (/\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
    res.set("Content-Encoding", "gzip");
    return res.send(asset.gz);
  }
  return res.send(asset.buf);
}

const PAGE_ASSET = makeAsset(
  readFileSync(new URL("./public/index.html", import.meta.url), "utf8"),
  "html"
);

function githubHeaders() {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "Readium-Alchemy-Sync/1.0"
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  return headers;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${url}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": "Readium-Alchemy-Sync/1.0" },
    signal: AbortSignal.timeout(45_000)
  });
  if (!response.ok) {
    throw new Error(`Source download failed (${response.status}): ${url}`);
  }
  return response.text();
}

/*
 * Parse inline JavaScript with Acorn and extract a top-level variable's
 * literal value. This avoids brittle brace-counting and supports unquoted
 * object keys, trailing commas, escaped strings, etc.
 */
function findVariableValue(ast, variableName) {
  for (const statement of ast.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (declaration.id?.type === "Identifier" &&
          declaration.id.name === variableName) {
        return literalFromAst(declaration.init, variableName);
      }
    }
  }
  return undefined;
}

function literalFromAst(node, label) {
  if (!node) throw new Error(`${label} has no initializer`);

  if (node.type === "Literal") return node.value;

  if (node.type === "ArrayExpression") {
    return node.elements.map((item) => {
      if (!item) return null;
      return literalFromAst(item, label);
    });
  }

  if (node.type === "ObjectExpression") {
    const result = {};
    for (const property of node.properties) {
      if (property.type !== "Property" || property.kind !== "init" || property.computed) {
        throw new Error(`${label} contains an unsupported object property`);
      }
      const key = property.key.type === "Identifier"
        ? property.key.name
        : property.key.value;
      result[String(key)] = literalFromAst(property.value, label);
    }
    return result;
  }

  throw new Error(`${label} contains non-literal JavaScript (${node.type})`);
}

function extractDataFromHtml(html) {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());

  let extracted = {};
  const wanted = new Set(["ALC_RECIPES", "ALC_EMOJI", "ALC_BASE"]);

  for (const script of scripts) {
    let ast;
    try {
      ast = parse(script, {
        ecmaVersion: "latest",
        sourceType: "script",
        allowHashBang: true
      });
    } catch {
      // A script can contain browser-specific syntax unrelated to the data.
      // Continue; a missing required variable will produce a clear error below.
      continue;
    }

    for (const name of wanted) {
      if (Object.hasOwn(extracted, name)) continue;
      const value = findVariableValue(ast, name);
      if (value !== undefined) extracted[name] = value;
    }
  }

  for (const name of wanted) {
    if (!Object.hasOwn(extracted, name)) {
      throw new Error(`Could not parse ${name} from upstream index.html`);
    }
  }

  if (!Array.isArray(extracted.ALC_BASE) ||
      typeof extracted.ALC_RECIPES !== "object" ||
      extracted.ALC_RECIPES === null ||
      typeof extracted.ALC_EMOJI !== "object" ||
      extracted.ALC_EMOJI === null) {
    throw new Error("Upstream alchemy data has an unexpected structure");
  }

  return {
    base: extracted.ALC_BASE,
    recipes: extracted.ALC_RECIPES,
    emoji: extracted.ALC_EMOJI
  };
}

function parseRecipes(recipes) {
  const list = [];
  for (const [pair, output] of Object.entries(recipes)) {
    if (typeof pair !== "string" || typeof output !== "string") continue;
    const splitAt = pair.indexOf("+");
    if (splitAt < 0) continue;
    list.push({
      element: output,
      ingredient1: pair.slice(0, splitAt),
      ingredient2: pair.slice(splitAt + 1),
      recipeKey: pair
    });
  }
  return list;
}

function buildCompletionRoute(base, recipes) {
  const known = new Set(base);
  const route = [];
  // Parse every pair once; each tier only rescans recipes that are still open.
  let pending = parseRecipes(recipes);
  let tier = 0;

  while (pending.length) {
    tier++;
    // All recipes in a tier are evaluated against the same previous-tier set.
    const additions = [];
    const stillPending = [];
    for (const recipe of pending) {
      if (known.has(recipe.element)) continue;
      if (known.has(recipe.ingredient1) && known.has(recipe.ingredient2)) additions.push(recipe);
      else stillPending.push(recipe);
    }
    if (!additions.length) break;
    pending = stillPending;

    additions.sort((a, b) => compare(a.element, b.element));
    for (const item of additions) {
      if (known.has(item.element)) continue;
      known.add(item.element);
      route.push({ tier, ...item });
    }
  }

  const outputs = new Set(Object.values(recipes));
  return {
    route,
    reachable: [...known].sort(compare),
    unreachable: [...outputs].filter(item => !known.has(item)).sort()
  };
}

/* Compact payload for the Kindle frontend: arrays instead of keyed objects, no emoji. */
function buildAssets(s) {
  const elements = [...new Set([...s.base, ...s.reachable])].sort(compare);
  const recipes = parseRecipes(s.recipes)
    .sort((a, b) => compare(a.recipeKey, b.recipeKey))
    .map(r => [r.ingredient1, r.ingredient2, r.element]);
  const bundle = {
    commit: s.commit,
    updatedAt: s.updatedAt,
    commitMessage: s.commitMessage,
    counts: s.counts,
    base: s.base,
    elements,
    recipes,
    route: s.route.map(r => [r.tier, r.element, r.ingredient1, r.ingredient2])
  };
  return {
    bundle: makeAsset(JSON.stringify(bundle), "json"),
    recipes: makeAsset(JSON.stringify({
      commit: s.commit, base: s.base, recipes: s.recipes, emoji: s.emoji
    }), "json"),
    route: makeAsset(JSON.stringify({
      commit: s.commit, base: s.base, route: s.route, reachable: s.reachable,
      unreachable: s.unreachable, counts: s.counts
    }), "json")
  };
}

async function refresh({ force = false } = {}) {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const commit = await fetchJson(
        `${API}/repos/${REPO}/commits/${encodeURIComponent(BRANCH)}`,
        { headers: githubHeaders() }
      );

      if (!force && commit.sha === state.commit && state.status === "ok") {
        return false;
      }

      const source = await fetchText(`${RAW}/${REPO}/${commit.sha}/index.html`);
      const { base, recipes, emoji } = extractDataFromHtml(source);
      const { route, reachable, unreachable } = buildCompletionRoute(base, recipes);
      const distinctOutputs = new Set(Object.values(recipes));

      state = {
        status: "ok",
        commit: commit.sha,
        commitUrl: commit.html_url,
        commitMessage: (commit.commit?.message || "").split("\n")[0],
        updatedAt: new Date().toISOString(),
        error: null,
        base,
        recipes,
        emoji,
        route,
        reachable,
        unreachable,
        counts: {
          baseElements: base.length,
          recipeEntries: Object.keys(recipes).length,
          distinctOutputs: distinctOutputs.size,
          reachableElements: reachable.length,
          craftableElements: reachable.length - base.length,
          unreachableOutputs: unreachable.length,
          tiers: route.reduce((max, item) => Math.max(max, item.tier), 0)
        }
      };

      assets = buildAssets(state);

      console.log(
        `[sync] Updated ${commit.sha.slice(0, 12)}: ` +
        `${Object.keys(recipes).length} recipes, ${reachable.length} reachable elements`
      );
      return true;
    } catch (error) {
      console.error("[sync] Refresh failed:", error);
      state.error = error.message;
      if (state.status !== "ok") state.status = "error";
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

app.disable("x-powered-by");
app.set("etag", false);

app.get("/health", (_req, res) => {
  // Liveness check: keep Render from restarting a healthy process just
  // because GitHub is temporarily unavailable. Upstream status is in /api/status.
  res.status(200).json({
    process: "ok",
    upstream: state.status,
    commit: state.commit,
    error: state.error
  });
});

app.get("/api/status", (_req, res) => {
  const { status, commit, commitUrl, commitMessage, updatedAt, error, counts, base } = state;
  res.json({ status, commit, commitUrl, commitMessage, updatedAt, error, counts, base });
});

// Tiny endpoint the frontend polls; it only downloads the bundle when `commit` changes.
app.get("/api/version", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    status: state.status,
    commit: state.commit,
    updatedAt: state.updatedAt,
    error: state.error
  });
});

app.get("/api/bundle", (req, res) => sendAsset(req, res, assets && assets.bundle));
app.get("/api/recipes", (req, res) => sendAsset(req, res, assets && assets.recipes));
app.get("/api/route", (req, res) => sendAsset(req, res, assets && assets.route));
app.get("/", (req, res) => sendAsset(req, res, PAGE_ASSET));

// Serve the empty snapshot immediately so a failed first fetch behaves like the original (200 + empty data).
assets = buildAssets(state);

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[server] Listening on port ${PORT}`);
  await refresh({ force: true });
  setInterval(() => refresh(), POLL_MS).unref();
  console.log(`[sync] Poll interval: ${POLL_SECONDS}s`);
});
