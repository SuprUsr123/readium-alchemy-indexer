import express from "express";
import { parse } from "acorn";

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
      try {
        const value = findVariableValue(ast, name);
        if (value !== undefined) extracted[name] = value;
      } catch (error) {
        throw error;
      }
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

function buildCompletionRoute(base, recipes) {
  const known = new Set(base);
  const route = [];
  let tier = 0;
  let changed = true;

  while (changed) {
    changed = false;
    tier++;

    // All recipes in a tier are evaluated against the same previous-tier set.
    const additions = [];
    for (const [pair, output] of Object.entries(recipes)) {
      if (typeof pair !== "string" || typeof output !== "string" || known.has(output)) {
        continue;
      }
      const splitAt = pair.indexOf("+");
      if (splitAt < 0) continue;

      const ingredient1 = pair.slice(0, splitAt);
      const ingredient2 = pair.slice(splitAt + 1);
      if (known.has(ingredient1) && known.has(ingredient2)) {
        additions.push({ element: output, ingredient1, ingredient2, recipeKey: pair });
      }
    }

    additions.sort((a, b) => a.element.localeCompare(b.element));
    for (const item of additions) {
      if (known.has(item.element)) continue;
      known.add(item.element);
      route.push({ tier, ...item });
      changed = true;
    }
  }

  const outputs = new Set(Object.values(recipes));
  return {
    route,
    reachable: [...known].sort((a, b) => a.localeCompare(b)),
    unreachable: [...outputs].filter(item => !known.has(item)).sort()
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

app.use(express.json());

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

app.get("/api/recipes", (_req, res) => {
  res.json({
    commit: state.commit,
    base: state.base,
    recipes: state.recipes,
    emoji: state.emoji
  });
});

app.get("/api/route", (_req, res) => {
  res.json({
    commit: state.commit,
    base: state.base,
    route: state.route,
    reachable: state.reachable,
    unreachable: state.unreachable,
    counts: state.counts
  });
});


const PAGE = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Readium Alchemy Explorer</title>
<style>
:root{--bg:#101318;--panel:#1a202a;--line:#303b49;--text:#e9eef5;--muted:#aab6c5;--accent:#8abaff;--good:#8de0b0}
*{box-sizing:border-box;transition:none !important;animation:none !important}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 Arial,sans-serif}
header,main{max-width:1100px;margin:auto;padding:22px 18px}header{border-bottom:1px solid var(--line)}
h1{margin:0;font-size:1.9rem}p{color:var(--muted);margin:5px 0}
.stats{display:flex;flex-wrap:wrap;margin-top:15px}.stats>*{margin:0 9px 9px 0}.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 13px;min-width:115px;flex:1}.stat b{display:block;font-size:1.35rem}.stat span{color:var(--muted);font-size:.8rem}
.tools{display:flex;flex-wrap:wrap;margin:15px 0}.tools>*{margin:0 9px 9px 0}.tools input{flex:1;min-width:200px}
input,button,select{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px;min-height:48px}
button{cursor:pointer}button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:not-allowed}
.tabs{display:flex;margin:12px 0;flex-wrap:wrap}.tabs>*{margin:0 7px 7px 0}.tab.active{border-color:var(--accent);background:#233248}
#status{font-size:.85rem;margin-top:8px}.tier{border:1px solid var(--line);border-radius:10px;background:var(--panel);margin:10px 0;overflow:hidden}
summary{padding:12px 14px;cursor:pointer;font-weight:650}.recipe{display:grid;grid-template-columns:26px 1fr 1.3fr;gap:9px;padding:9px 14px;border-top:1px solid var(--line);align-items:center}.muted{color:var(--muted)}.element{font-weight:650}.ingredients{color:var(--muted);overflow-wrap:break-word}
.inventory-layout{display:grid;grid-template-columns:minmax(240px,.85fr) minmax(0,1.5fr);gap:14px;align-items:start}.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px;min-width:0}.panel h2{font-size:1.05rem;margin:0 0 5px}.panel p{font-size:.88rem}.inventory-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:6px;margin-top:12px;max-height:480px;overflow:auto}.pick{display:flex;align-items:center;min-height:48px;border:1px solid var(--line);border-radius:8px;padding:7px 9px;min-width:0}.pick input{padding:0;accent-color:var(--accent);min-width:24px;min-height:24px;margin-right:8px}.pick span{overflow-wrap:break-word}.inventory-actions{display:flex;flex-wrap:wrap;margin-top:10px}.inventory-actions>*{margin:0 7px 7px 0}.count{color:var(--good);font-size:.85rem}.branch-list{display:grid;gap:11px;margin-top:12px}.branch{border:1px solid var(--line);border-radius:10px;padding:12px;background:#151b23}.branch-flow{display:grid;grid-template-columns:minmax(0,1fr) 24px minmax(0,1fr) 24px minmax(0,1.1fr);gap:7px;align-items:center}.node{border:1px solid #425267;border-radius:8px;padding:9px;text-align:center;min-width:0;overflow-wrap:break-word;background:#202a37}.node.output{border-color:#527c68;background:#1b3028}.plus,.arrow{text-align:center;color:var(--muted);font-weight:700}.branch-foot{display:flex;justify-content:space-between;align-items:center;margin-top:10px;color:var(--muted);font-size:.82rem}.branch-foot button{padding:6px 10px;font-size:.85rem}.empty{border:1px dashed var(--line);border-radius:10px;padding:20px;text-align:center;color:var(--muted)}.pill{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:2px 8px;margin:3px;font-size:.8rem;color:var(--muted)}
@media(max-width:720px){.inventory-layout{grid-template-columns:1fr}.inventory-list{max-height:300px}.branch-flow{grid-template-columns:1fr}.plus,.arrow{line-height:1}.branch-foot{align-items:flex-start;flex-direction:column}.recipe{grid-template-columns:1fr}.ingredients{padding-left:0}.stats>*{margin-right:6px}.stat{min-width:90px}}

.account{max-width:1100px;margin:18px auto 0;padding:0 18px}
.account-panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px}
.account-row{display:flex;flex-wrap:wrap;align-items:center}.account-row>*{margin:0 8px 8px 0}
.account-row input{flex:1;min-width:160px}
.account-note{font-size:.82rem;color:var(--muted);margin-top:8px}
.account-status{font-size:.9rem;margin-top:8px}
.account-status.error{color:#ff9b9b}
.account-status.good{color:var(--good)}
.target-tools{display:flex;flex-wrap:wrap;margin:12px 0}.target-tools>*{margin:0 8px 8px 0}
.target-tools select{flex:1;min-width:220px}
.path-step{display:grid;grid-template-columns:minmax(0,1fr) 22px minmax(0,1fr) 22px minmax(0,1.1fr);gap:7px;align-items:center;padding:9px;border-top:1px solid var(--line)}
.path-step:first-child{border-top:0}
@media(max-width:720px){.path-step{grid-template-columns:1fr}.path-step .plus,.path-step .arrow{line-height:1}}

:root{--bg:#111111;--panel:#222222;--line:#555555;--text:#eeeeee;--muted:#b8b8b8;--accent:#88bbff;--good:#eeeeee}
body{font:20px/1.5 Georgia,"Times New Roman",serif}
h1{font-size:34px}
input,select{background:#222222;color:#eeeeee;border-color:#555555}
button{background:#eeeeee;color:#111111;border-color:#eeeeee}
.tab.active{background:#111111;color:#eeeeee;border-color:#eeeeee}
.branch{background:#1a1a1a}
.node{border-color:#555555;background:#222222}
.node.output{border-color:#777777;background:#333333}
.recipe{grid-template-columns:minmax(0,1fr) minmax(0,1.3fr)}
.recipe>*{min-width:0;overflow-wrap:anywhere}
.stat,.tier,.panel,.branch,.pick,.node,.empty,.pill,.account-panel,input,button,select{border-radius:0}
@media(max-width:720px){.recipe{grid-template-columns:1fr}}
</style>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-auth.js"></script>
<script src="https://www.gstatic.com/firebasejs/8.10.1/firebase-database.js"></script>
</head><body>

<section class="account">
 <div class="account-panel">
  <h2 id="account-title" style="margin:0 0 8px">Sign in with Readium</h2>
  <div id="account-login" class="account-row">
   <input id="readium-username" autocomplete="username" autocapitalize="none" placeholder="Readium username">
   <input id="readium-password" type="password" autocomplete="current-password" placeholder="Readium password">
   <button id="readium-login">Sign in</button>
  </div>
  <div id="account-user" class="account-row" hidden>
   <span id="account-name"></span>
   <button id="account-reload" type="button">Reload Readium save</button>
   <button id="account-logout" type="button">Sign out</button>
  </div>
  <div id="account-status" class="account-status">Sign in to load your existing Readium Alchemy discoveries.</div>
  <div class="account-note">Uses Readium's existing Firebase sign-in. Your password is sent directly to Firebase Authentication, not to this community server. This explorer reads your cloud save; manual inventory edits stay in this browser session and are not written back to Readium.</div>
 </div>
</section>
<header><h1>Readium Alchemy Explorer</h1><p>Community recipe explorer · load your Readium discoveries, branch into available recipes, and plan a route to any reachable element.</p>
<div class="stats" id="stats"></div><div id="status">Loading data…</div></header>
<main><div class="tabs"><button class="tab active" data-view="inventory">My discoveries</button><button class="tab" data-view="route">Completion route</button><button class="tab" data-view="recipes">All recipes</button></div>
<div class="tools"><input id="search" placeholder="Search elements or recipes…" type="search"></div><div id="content"></div></main>
<script>

let DATA=null, view="inventory", owned=new Set(), cloudElements=[];
let auth=null, db=null, currentUser=null, authReady=false, manualEdits=false;
const $=id=>document.getElementById(id);
const STORE_KEY="readium-alchemy-session-owned-v2";
function el(tag,cls,txt){const n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n}
// Use removeChild loops for older Chromium builds.
function clearChildren(node){while(node.firstChild){node.removeChild(node.firstChild)}}
function accountStatus(message,kind=""){const n=$("account-status");n.textContent=message;n.className="account-status"+(kind?" "+kind:"")}
function usernameEmail(username){return username+"@readium.chat"}
function validUsername(username){return /^[a-z0-9._-]{3,20}$/.test(username)}
function setAccountUI(user){
 currentUser=user||null;
 $("account-login").hidden=!!user;
 $("account-user").hidden=!user;
 $("account-title").textContent=user?"Readium account connected":"Sign in with Readium";
 $("account-name").textContent=user?(user.displayName||user.email||"Signed in"):"";
}
function initFirebase(){
 const firebaseConfig={
  apiKey:"AIzaSyBM8k1SltnksCRZ5NvgggfQ952H3DZIyDY",
  authDomain:"readium-33755.firebaseapp.com",
  databaseURL:"https://readium-33755-default-rtdb.firebaseio.com",
  projectId:"readium-33755",
  storageBucket:"readium-33755.firebasestorage.app",
  messagingSenderId:"1062133935488",
  appId:"1:1062133935488:web:a00716635022a998f32565"
 };
 try{
  if(!window.firebase){accountStatus("Firebase SDK could not load. Check your connection or content blockers.","error");return}
  if(!firebase.apps.length)firebase.initializeApp(firebaseConfig);
  auth=firebase.auth();db=firebase.database();
  auth.onAuthStateChanged(async user=>{
   setAccountUI(user);
   if(user){await readReadiumSave(user)}
   else{owned=new Set((DATA && DATA.all && DATA.all.base) || []);cloudElements=[];manualEdits=false;render();accountStatus("Signed out. Sign in to read your Readium cloud save.")}
  });
 }catch(e){accountStatus("Could not initialize Readium sign-in: "+e.message,"error")}
}
async function signIn(){
 const username=$("readium-username").value.trim().toLowerCase();
 const password=$("readium-password").value;
 if(!validUsername(username)){accountStatus("Enter your Readium username (3–20 letters, numbers, dots, dashes or underscores).","error");return}
 if(!password){accountStatus("Enter your Readium password.","error");return}
 $("readium-login").disabled=true;accountStatus("Signing in with Readium…");
 try{await auth.signInWithEmailAndPassword(usernameEmail(username),password);$("readium-password").value=""}
 catch(e){
  const messages={
   "auth/invalid-email":"That username could not be used as a Readium login.",
   "auth/user-not-found":"No Readium account was found for that username.",
   "auth/wrong-password":"Incorrect username or password.",
   "auth/invalid-credential":"Incorrect username or password.",
   "auth/too-many-requests":"Firebase temporarily blocked sign-in attempts. Try again later.",
   "auth/network-request-failed":"Network error while contacting Readium Authentication."
  };
  accountStatus(messages[e.code]||("Sign-in failed: "+e.message),"error")
 }finally{$("readium-login").disabled=false}
}
async function readReadiumSave(user){
 accountStatus("Reading your Readium Alchemy save…");
 $("account-reload").disabled=true;
 try{
  const snap=await db.ref("userAlchemy/"+user.uid).once("value");
  const save=snap.val()||{};
  const list=Array.isArray(save.elements)?save.elements:[];
  cloudElements=[...new Set(list.filter(x=>typeof x==="string"))];
  owned=new Set([...((DATA && DATA.all && DATA.all.base) || []),...cloudElements]);
  manualEdits=false;
  render();
  accountStatus(cloudElements.length
   ? "Loaded "+cloudElements.length+" saved discoveries from Readium. Your four basics are included."
   : "Your Readium cloud save is empty or has no discoveries yet. Starting with the four basics.",
   "good");
 }catch(e){
  accountStatus("Could not read userAlchemy/"+user.uid+": "+e.message+". Check Readium's Firebase database rules for authenticated reads.","error");
  owned=new Set((DATA && DATA.all && DATA.all.base) || []);render()
 }finally{$("account-reload").disabled=false}
}
function reloadReadiumSave(){if(currentUser)readReadiumSave(currentUser)}
function signOut(){if(auth)auth.signOut().catch(e=>accountStatus("Sign-out failed: "+e.message,"error"))}
function allElements(){return [...new Set([...((DATA && DATA.all && DATA.all.base) || []),...((DATA && DATA.r && DATA.r.reachable) || [])])].sort((a,b)=>a.localeCompare(b))}
function possibleCrafts(){
 const result=[];
 for(const [pair,out] of Object.entries(DATA.all.recipes)){
  const i=pair.indexOf("+");if(i<0||owned.has(out))continue;
  const a=pair.slice(0,i),b=pair.slice(i+1);
  if(owned.has(a)&&owned.has(b))result.push({a,b,out})
 }
 return result.sort((x,y)=>x.out.localeCompare(y.out))
}
function buildOwnedClosure(){
 const known=new Set(owned),chosen=new Map(),route=[];
 let changed=true,tier=0;
 while(changed){
  changed=false;tier++;
  const additions=[];
  for(const [pair,out] of Object.entries(DATA.all.recipes)){
   if(known.has(out))continue;
   const i=pair.indexOf("+");if(i<0)continue;
   const a=pair.slice(0,i),b=pair.slice(i+1);
   if(known.has(a)&&known.has(b))additions.push({a,b,out});
  }
  additions.sort((a,b)=>a.out.localeCompare(b.out));
  for(const item of additions){
   if(known.has(item.out))continue;
   known.add(item.out);chosen.set(item.out,item);route.push({...item,tier});changed=true;
  }
 }
 return {known,chosen,route}
}
function planTo(target){
 const closure=buildOwnedClosure(),steps=[],done=new Set(),visiting=new Set();
 function visit(name){
  if(owned.has(name)||done.has(name))return true;
  if(visiting.has(name))return false;
  const recipe=closure.chosen.get(name);if(!recipe)return false;
  visiting.add(name);
  if(!visit(recipe.a)||!visit(recipe.b)){visiting.delete(name);return false}
  visiting.delete(name);done.add(name);steps.push(recipe);return true;
 }
 return visit(target)?steps:null
}
function renderInventory(root,q){
 const layout=el("div","inventory-layout"),left=el("section","panel"),right=el("section","panel");
 left.append(el("h2","","Your Readium discoveries"),el("p","","Loaded from your Readium account. You can adjust this working selection to explore alternatives; changes are session-only."));
 const count=el("div","count",owned.size+" selected");left.append(count);
 const list=el("div","inventory-list");
 for(const name of allElements()){
  if(q&&!name.toLowerCase().includes(q))continue;
  const label=el("label","pick"),check=el("input");check.type="checkbox";check.checked=owned.has(name);
  check.addEventListener("change",()=>{if(check.checked)owned.add(name);else if(!(DATA.all.base||[]).includes(name))owned.delete(name);manualEdits=true;render()});
  if((DATA.all.base||[]).includes(name)){check.checked=true;check.disabled=true}
  label.append(check,el("span","",name));list.append(label)
 }
 left.append(list);
 const actions=el("div","inventory-actions"),reload=el("button","","Reload cloud save"),basics=el("button","","Reset to basics");
 reload.onclick=reloadReadiumSave;basics.onclick=()=>{owned=new Set(DATA.all.base);manualEdits=true;render()};
 actions.append(reload,basics);left.append(actions);
 right.append(el("h2","","What can you create next?"));
 const crafts=possibleCrafts();
 right.append(el("p","",crafts.length?crafts.length+" new recipes are immediately craftable from this selection.":"No new recipes are available yet. Add more discoveries on the left."));
 const branches=el("div","branch-list");
 for(const c of crafts){
  const card=el("article","branch"),flow=el("div","branch-flow");
  flow.append(el("div","node",c.a),el("div","plus","+"),el("div","node",c.b),el("div","arrow","→"),el("div","node output",c.out));
  const foot=el("div","branch-foot"),note=el("span","","Both ingredients are in your inventory"),add=el("button","","Add to working inventory");
  add.onclick=()=>{owned.add(c.out);manualEdits=true;render()};
  foot.append(note,add);card.append(flow,foot);branches.append(card)
 }
 if(!crafts.length)branches.append(el("div","empty","Your current inventory has no new direct recipes. Try adding another saved discovery or plan a route below."));
 right.append(branches);
 const planPanel=el("section","panel");planPanel.style.marginTop="14px";
 planPanel.append(el("h2","","Plan a path to an element"),el("p","","Choose an element you haven't discovered. The explorer will trace the recipe dependencies back to what you already own."));
 const tools=el("div","target-tools"),select=el("select"),go=el("button","","Show path");
 select.id="target-element";
 const closure=buildOwnedClosure();
 const targets=[...closure.known].filter(n=>!owned.has(n)).sort((a,b)=>a.localeCompare(b));
 select.append(new Option(targets.length?"Choose a target…":"No undiscovered reachable targets",""));
 for(const target of targets)select.append(new Option(target+" · "+(planTo(target)||[]).length+" new crafts",target));
 go.disabled=!targets.length;
 const result=el("div","branch-list");go.onclick=()=>{
  clearChildren(result);const target=select.value;if(!target)return;
  const steps=planTo(target);
  if(!steps){result.append(el("div","empty","No valid path was found from this inventory."));return}
  result.append(el("p","count",steps.length+" new elements to craft to reach "+target));
  steps.forEach((step,index)=>{
   const line=el("div","path-step");
   line.append(el("div","node",step.a),el("div","plus","+"),el("div","node",step.b),el("div","arrow","→"),el("div","node output",step.out));
   const wrap=el("article","branch");wrap.append(el("div","branch-foot","Step "+(index+1)),line);result.append(wrap)
  })
 };
 tools.append(select,go);planPanel.append(tools,result);right.append(planPanel);
 layout.append(left,right);root.append(layout)
}
async function load(){
 $("status").textContent="Fetching latest parsed data…";
 try{
  const [s,r,all]=await Promise.all([fetch("/api/status").then(x=>x.json()),fetch("/api/route").then(x=>x.json()),fetch("/api/recipes").then(x=>x.json())]);
  DATA={s,r,all};
  if(!authReady){owned=new Set(all.base||[])}
  clearChildren($("stats"));
  const c=s.counts||{};
  for(const [label,value] of [["Elements",c.reachableElements],["Craftable",c.craftableElements],["Recipes",c.recipeEntries],["Tiers",c.tiers]]){
   const d=el("div","stat");d.append(el("b","",(value === undefined || value === null ? "—" : value)),el("span","",label));$("stats").append(d)
  }
  $("status").textContent="Commit "+((s.commit ? s.commit.slice(0,12) : null)||"unknown")+" · Updated "+(s.updatedAt||"not yet")+" · "+(s.commitMessage||"")+(s.error?" · Sync warning: "+s.error:"");
  render();
 }catch(e){$("status").textContent="Could not load data: "+e.message}
}
function render(){
 if(!DATA)return;
 const q=$("search").value.trim().toLowerCase(),root=$("content");clearChildren(root);
 if(view==="inventory"){renderInventory(root,q)}
 else if(view==="route"){
  const groups=new Map();
  for(const r of DATA.r.route){if(q&&!(r.element+" "+r.ingredient1+" "+r.ingredient2).toLowerCase().includes(q))continue;if(!groups.has(r.tier))groups.set(r.tier,[]);groups.get(r.tier).push(r)}
  for(const [tier,rows] of groups){const d=el("details","tier");d.open=Number(tier)<=2;d.append(el("summary","","Tier "+tier+" — "+rows.length+" elements"));for(const r of rows){const line=el("div","recipe");line.append(el("span","element",r.element),el("span","ingredients",r.ingredient1+" + "+r.ingredient2));d.append(line)}root.append(d)}
 }else{
  const box=el("div","tier");
  for(const [pair,out] of Object.entries(DATA.all.recipes).sort((a,b)=>a[0].localeCompare(b[0]))){if(q&&!(pair+" "+out).toLowerCase().includes(q))continue;const line=el("div","recipe");line.append(el("span","ingredients",pair.replace("+"," + ")),el("span","element",out));box.append(line)}
  root.append(box)
 }
}
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{view=b.dataset.view;document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x===b));render()});
$("search").oninput=render;
$("readium-login").onclick=signIn;
$("readium-password").addEventListener("keydown",e=>{if(e.key==="Enter")signIn()});
$("readium-username").addEventListener("keydown",e=>{if(e.key==="Enter")$("readium-password").focus()});
$("account-reload").onclick=reloadReadiumSave;
$("account-logout").onclick=signOut;
load().then(()=>{authReady=true;initFirebase()});
setInterval(load,60000);

</script></body></html>`;

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`[server] Listening on port ${PORT}`);
  await refresh({ force: true });
  setInterval(() => refresh(), POLL_MS).unref();
  console.log(`[sync] Poll interval: ${POLL_SECONDS}s`);
});
