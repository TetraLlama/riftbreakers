import { createStore } from "./store.js";
import { ABILITIES } from "./abilities.js";
import * as E from "./engine.js";
import { createBoard, zoneOf } from "./board.js";
import { rulesHTML } from "./rules.js";

const HEART_COLORS = {
  Arcane: "#a78bfa", Arrow: "#86efac", Bastion: "#94a3b8", Blade: "#f87171", Death: "#6ee7b7",
  Devastation: "#fb923c", Elemental: "#38bdf8", Might: "#facc15", Restoration: "#fde68a",
  Ritual: "#e879f9", Shadow: "#818cf8", Time: "#2dd4bf", Weapon: "#cbd5e1", Companion: "#f9a8d4",
  Achievement: "#fbbf24", Custom: "#64748b",
};

const state = {
  store: null, uid: null, mode: null,
  code: null, room: null, chars: [], log: [], library: null,
  activeId: localStorage.getItem("rbc:active") || null,
  view: "combat",
  libFilter: "", libSource: "",
  unsub: [],
  tokens: [], tokensLoaded: false, charsLoaded: false,
  board: null,
  showRules: false,
};
const processing = new Set();
const dealt = new Set(); // cards already animated in, so re-renders don't replay the deal

/* ---------------- helpers ---------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const byName = new Map(ABILITIES.map((a) => [a.name.toLowerCase(), a]));
const accent = (src) => HEART_COLORS[src] || HEART_COLORS.Custom;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}

function fullText(name) {
  const lib = state.library?.abilities;
  if (!lib) return "";
  const hit = lib.find((a) => a.name.toLowerCase() === String(name).toLowerCase());
  return hit?.text || "";
}

function allLibrary() {
  // Built-in stats, overlaid with anything imported (which may add abilities).
  const map = new Map(ABILITIES.map((a) => [a.name.toLowerCase(), { ...a }]));
  for (const a of state.library?.abilities || []) {
    map.set(a.name.toLowerCase(), { ...map.get(a.name.toLowerCase()), ...a });
  }
  return [...map.values()];
}

function slotFromAbility(a) {
  const slot = {
    name: a.name, cost: a.cost ?? 0, prime: !!a.prime, action: a.action || "Standard",
    range: a.range || "", defense: a.defense || "", source: a.source || "Custom", note: "",
  };
  if (a.name === "Companion") slot.isCompanion = true;
  return slot;
}

const me = () => state.chars.filter((c) => c.owner === state.uid);
const active = () => state.chars.find((c) => c.id === state.activeId) || me()[0] || null;
const inCombat = () => !!state.room?.combatId;

async function commit(char, result) {
  if (result.error) return toast(result.error);
  const { id, ...body } = result.char;
  await state.store.saveCharacter(state.code, char.id, body);
  await state.store.addLog(state.code, result.log.map((text) => ({ text, color: char.color })));
}

/* ---------------- round processing ---------------- */
// Each client advances only the characters it owns, so writes never collide.
async function processRounds() {
  const room = state.room;
  if (!room) return;
  for (const c of me()) {
    const cb = c.combat || E.emptyCombat();
    let result = null;
    let key = null;
    if (room.combatId && cb.combatId !== room.combatId) {
      key = `${c.id}:start:${room.combatId}`;
      if (!processing.has(key)) { processing.add(key); result = E.startCombat(c, room.combatId, room.round); }
    } else if (room.combatId && cb.roundSeen < room.round) {
      key = `${c.id}:round:${room.combatId}:${room.round}`;
      if (!processing.has(key)) { processing.add(key); result = E.startRound(c, room.round); }
    } else if (!room.combatId && cb.combatId) {
      key = `${c.id}:end:${cb.combatId}`;
      if (!processing.has(key)) { processing.add(key); result = E.endCombat(c); }
    }
    if (result) await commit(c, result).catch((e) => { processing.delete(key); console.error(e); });
  }
}

/* ---------------- room actions ---------------- */
async function startCombat() {
  if (!me().length && !state.chars.length) return toast("Add a character first.");
  const combatId = "k" + Date.now().toString(36);
  if (state.room?.combatId) return;
  await state.store.addLog(state.code, [{ text: "⚔ Combat begins. Round 1.", color: "#c0201b" }]);
  await state.store.updateRoom(state.code, (r) => (r.combatId ? null : { combatId, round: 1 }));
}
async function nextRound() {
  const expected = state.room.round;
  await state.store.updateRoom(state.code, (r) => (r.combatId && r.round === expected ? { round: expected + 1, roundStartedAt: Date.now() } : null));
}
async function endCombat() {
  if (!confirm("End combat for everyone? Hands clear and Primes reset.")) return;
  await state.store.updateRoom(state.code, (r) => (r.combatId ? { combatId: null, round: 0 } : null));
  await state.store.addLog(state.code, [{ text: "Combat ends.", color: "#c0201b" }]);
}

/* ---------------- battlefield ---------------- */
const pcTokenId = (charId) => "pc-" + charId;

function makeBoard(code) {
  return createBoard({
    save: (id, t) => state.store.saveToken(code, id, t),
    update: (id, patch) => state.store.updateToken(code, id, patch).catch((e) => console.error(e)),
    remove: (id) => state.store.deleteToken(code, id),
    log: (text, color) => state.store.addLog(code, [{ text, color }]),
    onBusyEnd: () => { if (renderQueued) render(); },
  });
}

// Every character gets a token, created and kept in sync by its owner.
async function syncPcTokens() {
  if (!state.tokensLoaded || !state.charsLoaded) return;
  const mine = me();
  for (let i = 0; i < mine.length; i++) {
    const c = mine[i];
    const id = pcTokenId(c.id);
    const tok = state.tokens.find((t) => t.id === id);
    const key = `tok:${id}:${c.name}:${c.color}`;
    if (processing.has(key)) continue;
    if (!tok) {
      processing.add(key);
      await state.store.saveToken(state.code, id, {
        kind: "pc", charId: c.id, owner: c.owner, label: c.name, color: c.color,
        x: 0.07 + (i % 2) * 0.1, y: 0.22 + ((state.chars.indexOf(c) * 0.19) % 0.7),
        hpMax: null, hp: null, prot: "", parry: null, evasion: null, conds: [], note: "", createdAt: Date.now(),
      });
    } else if (tok.label !== c.name || tok.color !== c.color) {
      processing.add(key);
      await state.store.updateToken(state.code, id, { label: c.name, color: c.color });
    }
  }
}

/* ---------------- rules reference ---------------- */
// Lives outside #app so live re-renders never reset its scroll position.
function setRules(open) {
  state.showRules = open;
  document.documentElement.classList.toggle("no-scroll", open);
  let root = document.getElementById("rules-root");
  if (!open) { root?.remove(); return; }
  if (!root) {
    root = document.createElement("div");
    root.id = "rules-root";
    root.innerHTML = rulesHTML();
    document.body.appendChild(root);
  }
  root.querySelector(".rules-sheet")?.focus();
}

/* ---------------- rendering ---------------- */
let renderQueued = false;
function render() {
  // Don't blow away a field the user is typing in; render when they leave it.
  const ae = document.activeElement;
  if (ae && ae.closest("#app") && ae.matches("input, textarea, select")) { renderQueued = true; return; }
  if (state.board?.isBusy()) { renderQueued = true; return; } // mid-drag
  renderQueued = false;
  const app = $("#app");
  app.innerHTML = state.code ? roomView() : lobbyView();
  // The battlefield is a persistent element; re-attach it rather than rebuild it.
  const slot = $("#board-slot");
  if (slot && state.board) slot.replaceWith(state.board.el);
}
document.addEventListener("focusout", () => setTimeout(() => renderQueued && render(), 0));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.showRules) setRules(false);
});

function lobbyView() {
  const recent = JSON.parse(localStorage.getItem("rbc:recent") || "[]");
  return `
  <div class="lobby">
    <h1>Rift Table</h1>
    <p class="tag">A shared table for Riftbreakers 2e: Loadouts, hands, Aether, and the dark between the zones.</p>
    <form data-form="join">
      <input name="code" placeholder="Room code" maxlength="24" autocomplete="off" aria-label="Room code">
      <button class="btn primary">Enter</button>
    </form>
    <p class="small faint" style="margin-top:10px">Pick any code and share it with your party. Same code, same room.</p>
    <button class="btn ghost sm" data-act="random-room">Make me a code</button>
    <button class="btn ghost sm" data-act="rules">How combat works</button>
    ${recent.length ? `<div class="recent">${recent.map((r) => `<button class="btn sm" data-act="open-room" data-code="${esc(r)}">${esc(r)}</button>`).join("")}</div>` : ""}
    <p class="mode-note">${state.mode === "online" ? "Online: rooms are shared live with anyone who has the code." : "Local mode: rooms live in this browser only. Add a Firebase config to play online (see README)."}</p>
  </div>`;
}

function roomView() {
  const r = state.room || {};
  const c = active();
  return `
  <header class="topbar">
    <span class="brand">Rift Table</span>
    <span class="room-code" data-act="copy-link" title="Copy invite link">${esc(state.code)}</span>
    <span class="badge ${state.mode === "online" ? "online" : ""}">${state.mode === "online" ? "● online" : "local"}</span>
    <span class="spacer"></span>
    ${!state.room ? "" : r.combatId
      ? `<span class="round-pill live">Round ${r.round}</span>
         <button class="btn gold" data-act="next-round" title="Everyone refills Aether and draws to a full hand">Next round ⟳</button>
         <button class="btn danger sm" data-act="end-combat">End combat</button>`
      : `<span class="round-pill">No combat</span>
         <button class="btn gold" data-act="start-combat">Start combat ⚔</button>`}
    <button class="btn sm" data-act="rules" title="Combat flow reference">Rules</button>
    <button class="btn ghost sm" data-act="leave">Leave</button>
  </header>
  <div id="board-slot"></div>
  <main class="layout">
    <section>
      <div class="char-tabs">
        ${me().map((m) => `<button class="char-tab ${c && m.id === c.id ? "active" : ""}" data-act="select-char" data-id="${m.id}"><span class="dot" style="background:${esc(m.color)}"></span>${esc(m.name)}</button>`).join("")}
        ${state.addingChar
          ? `<form class="row-flex" data-form="new-char"><input name="name" placeholder="Character name" maxlength="40" autofocus aria-label="Character name"><button class="btn primary sm">Add</button><button type="button" class="btn ghost sm" data-act="cancel-char">Cancel</button></form>`
          : `<button class="btn sm" data-act="new-char">+ Character</button>`}
      </div>
      ${!state.charsLoaded ? `<div class="panel"><p class="muted" style="margin:0">Gathering the party…</p></div>` : c ? characterView(c) : `<div class="panel"><h3>No character yet</h3><p class="muted">Add a character, fill their 12 Loadout slots, then start combat. Each friend adds their own from their device.</p>${state.addingChar ? "" : `<button class="btn primary" data-act="new-char">+ Add character</button>`}</div>`}
    </section>
    <aside>
      ${partyView()}
      ${logView()}
    </aside>
  </main>`;
}

function characterView(c) {
  const tabs = [["combat", "Combat"], ["loadout", "Loadout"], ["library", "Library"]];
  return `
  <div class="panel">
    <nav class="view-tabs">${tabs.map(([k, l]) => `<button class="view-tab ${state.view === k ? "active" : ""}" data-act="view" data-view="${k}">${l}</button>`).join("")}</nav>
    ${state.view === "combat" ? combatView(c) : state.view === "loadout" ? loadoutView(c) : libraryView(c)}
  </div>`;
}

function aetherPips(c) {
  const cb = c.combat;
  const max = Math.max(E.roundMax(c), cb.aether);
  let pips = "";
  for (let i = 0; i < max; i++) pips += `<span class="pip ${i < cb.aether ? "on" : ""}"></span>`;
  for (let i = 0; i < cb.tempAether; i++) pips += `<span class="pip temp" title="Temporary Aether"></span>`;
  return pips;
}

function combatView(c) {
  const cb = c.combat || E.emptyCombat();
  if (!inCombat()) {
    return `
    <div class="banner info"><span>Not in combat. When someone presses <b>Start combat</b>, every character refills to ${E.roundMax(c)} Aether and rolls a hand of ${c.handSize || 5}.</span></div>
    ${loadoutGrid(c)}
    <div class="row-flex" style="margin-top:14px"><button class="btn gold" data-act="start-combat">Start combat ⚔</button><button class="btn" data-act="view" data-view="loadout">Edit Loadout</button></div>`;
  }
  const avail = E.available(c);
  const hand = cb.hand.map((slotIdx, pos) => cardView(c, slotIdx, pos, avail)).join("");
  const rolls = cb.lastRolls?.length
    ? `<p class="rolls">Last draw: ${cb.lastRolls.map((r) => r.roll === r.slot + 1 ? `<b>${r.roll}</b>` : `<b>${r.roll}</b>→${r.slot + 1}`).join(", ")}</p>` : "";
  return `
  ${cb.pendingPrime ? `<div class="banner"><span>★ <b>${esc(cb.pendingPrime.name)}</b> is Prime. Did it land?</span>
      <button class="btn sm" data-act="prime-landed">Landed: all copies spent</button>
      <button class="btn sm" data-act="prime-resisted">Resisted: lose only this copy</button></div>` : ""}
  <div class="aether-row">
    <div class="aether-num">${avail}<small> / ${E.roundMax(c)}</small></div>
    <div>
      <div class="pips" aria-label="${avail} Aether">${aetherPips(c)}</div>
      <div class="small faint" style="margin-top:4px">Aether${cb.tempAether ? ` · ${cb.tempAether} temporary` : ""}${cb.reactions ? ` · next Reaction +${cb.reactions}` : ""}${cb.nextRoundBonus ? ` · +${cb.nextRoundBonus} next round` : ""}</div>
    </div>
  </div>
  <div class="aether-actions">
    <button class="btn sm" data-act="aether" data-d="-1" data-why="Spent Aether">−1</button>
    <button class="btn sm" data-act="aether" data-d="1" data-why="Gained Aether">+1</button>
    <button class="btn sm" data-act="aether" data-d="-5" data-why="Stood up from Prone">Stand up (5)</button>
    <button class="btn sm" data-act="aether" data-d="-5" data-why="Used a consumable">Potion (5)</button>
    <button class="btn sm" data-act="aether" data-d="-5" data-why="Swapped weapons">Swap weapon (5)</button>
    <button class="btn sm" data-act="temp" data-d="1">+1 Temp</button>
    <button class="btn sm" data-act="bonus" data-d="2" title="e.g. Aether Boost: +2 Aether on your next turn">+2 next round</button>
    <button class="btn sm danger" data-act="fumble">Fumble</button>
  </div>

  <div class="section-head" style="margin-top:22px">
    <h3 style="margin:0">Hand <span class="faint small">(${cb.hand.length}/${c.handSize || 5})</span></h3>
    <div class="row-flex">
      <button class="btn sm" data-act="draw-one" title="e.g. after losing access to an Ability mid-combat">Draw 1</button>
      <button class="btn sm" data-act="draw-full">Draw to ${c.handSize || 5}</button>
    </div>
  </div>
  <div class="hand">${hand || `<div class="empty-hand">Hand is empty. It refills at the start of next round.</div>`}</div>
  <p class="small faint" style="margin-top:10px">Used Abilities go straight back into your Loadout. Discard what you don't want at the end of your turn, and it can be redrawn next round.</p>

  <h3 style="margin-top:20px">Loadout <span class="faint small">(D12)</span></h3>
  ${loadoutGrid(c)}
  ${rolls}`;
}

function cardView(c, slotIdx, pos, avail) {
  const s = E.effectiveSlot(c, slotIdx);
  if (!s) return "";
  const cost = E.playCost(c, slotIdx);
  const afford = cost <= avail && !s.spent;
  const text = s.note || fullText(s.name) || (E.WEAPON_STRIKES[s.name]?.text ?? "");
  const dealKey = `${c.id}:${c.combat.combatId}:${c.combat.roundSeen}:${slotIdx}:${(c.combat.lastRolls || []).map((r) => r.slot).join(".")}`;
  const fresh = !dealt.has(dealKey);
  dealt.add(dealKey);
  return `
  <article class="card ${afford ? "" : "unaffordable"} ${fresh ? "fresh" : ""}" style="--accent:${accent(s.source)}">
    <div class="top">
      <div>
        <div class="name">${esc(s.name)}</div>
        ${s.transformedFrom ? `<div class="was">was ${esc(s.transformedFrom)}</div>` : ""}
      </div>
      <div class="cost" title="Aether cost">${cost}</div>
    </div>
    <div class="meta">
      <span class="chip slot">#${slotIdx + 1}</span>
      ${s.prime ? `<span class="chip prime">Prime</span>` : ""}
      ${s.action === "Reaction" ? `<span class="chip react">Reaction${c.combat.reactions ? ` +${c.combat.reactions}` : ""}</span>` : ""}
      ${s.range ? `<span class="chip">Range ${esc(s.range)}</span>` : ""}
      ${s.defense ? `<span class="chip">vs ${esc(s.defense)}</span>` : ""}
    </div>
    ${text ? `<div class="text">${esc(text)}</div>` : `<div class="text"></div>`}
    <div class="actions">
      <button class="btn primary sm" data-act="play" data-pos="${pos}" ${afford ? "" : "disabled"}>${s.action === "Reaction" ? "React" : "Use"}</button>
      <button class="btn sm" data-act="play-free" data-pos="${pos}" title="Use without paying Aether (e.g. Tactician)">Free</button>
      <button class="btn sm" data-act="discard" data-pos="${pos}" title="Discard back to Loadout">✕</button>
    </div>
  </article>`;
}

function loadoutGrid(c) {
  const cb = c.combat || E.emptyCombat();
  const rolled = new Set((cb.lastRolls || []).map((r) => r.slot));
  return `<div class="d12-grid">${c.loadout.map((raw, i) => {
    if (!raw) return `<div class="d12 empty"><span class="n">${i + 1}</span><span class="nm">empty</span></div>`;
    const s = inCombat() ? E.effectiveSlot(c, i) : raw;
    const gone = !!s.transformedFrom;
    return `<div class="d12 ${cb.hand.includes(i) ? "in-hand" : ""} ${rolled.has(i) ? "rolled" : ""} ${gone ? "gone" : ""}" style="--accent:${accent(s.source)}" title="${esc(gone ? `${raw.name} → ${s.name}` : s.name)}">
      <span class="n">${i + 1}</span> <span class="faint small">${s.cost ?? ""}◆</span>
      <span class="nm">${esc(gone ? raw.name : s.name)}</span></div>`;
  }).join("")}</div>`;
}

function loadoutView(c) {
  const problems = E.loadoutProblems(c);
  const names = allLibrary().map((a) => `<option value="${esc(a.name)}">${esc(a.source)} · ${a.cost}◆${a.prime ? " · Prime" : ""}</option>`).join("");
  const companions = allLibrary().filter((a) => a.source === "Companion" && a.name !== "Companion");
  const rows = c.loadout.map((s, i) => `
    <div class="slot-row" style="--accent:${accent(s?.source)}">
      <span class="n">${i + 1}</span>
      <input list="ability-names" value="${esc(s?.name || "")}" placeholder="Empty slot. Type or pick an Ability" data-edit="name" data-slot="${i}" aria-label="Slot ${i + 1} ability">
      <input type="number" min="0" max="20" value="${s ? s.cost : ""}" data-edit="cost" data-slot="${i}" aria-label="Aether cost" title="Aether cost" ${s ? "" : "disabled"}>
      <span class="flags">
        <label class="check"><input type="checkbox" data-edit="prime" data-slot="${i}" ${s?.prime ? "checked" : ""} ${s ? "" : "disabled"}>Prime</label>
        <label class="check"><input type="checkbox" data-edit="reaction" data-slot="${i}" ${s?.action === "Reaction" ? "checked" : ""} ${s ? "" : "disabled"}>Reaction</label>
      </span>
      <span class="row-flex row-btns">
        <button class="btn sm ghost" data-act="dup-slot" data-slot="${i}" ${s ? "" : "disabled"} title="Copy into next empty slot">⧉</button>
        <button class="btn sm ghost" data-act="clear-slot" data-slot="${i}" ${s ? "" : "disabled"} title="Clear slot">✕</button>
      </span>
      ${s ? `<div class="extra">
        ${s.isCompanion ? `<label>Companion's Loadout Ability
          <select data-edit="companion" data-slot="${i}">
            <option value="">(none)</option>
            ${companions.map((a) => `<option ${s.companionAbility?.name === a.name ? "selected" : ""}>${esc(a.name)}</option>`).join("")}
          </select></label>` : ""}
        <textarea data-edit="note" data-slot="${i}" placeholder="${esc(fullText(s.name) ? "Effect text comes from the imported library. Add your own note here to override it." : "Effect / notes (optional), shown on the card")}">${esc(s.note || "")}</textarea>
      </div>` : ""}
    </div>`).join("");

  return `
  ${inCombat() ? `<div class="banner"><span>You're in combat. By the rules, a Loadout can only be changed out of combat (once per 24h, 10 minutes of concentration). Edits apply right away.</span></div>` : ""}
  <div class="settings-grid">
    <label>Character name<input value="${esc(c.name)}" data-edit="char-name"></label>
    <label>Max Aether<input type="number" min="1" max="30" value="${c.aetherMax}" data-edit="aetherMax"></label>
    <label>Hand size<input type="number" min="1" max="12" value="${c.handSize || 5}" data-edit="handSize"></label>
    <label>Weapon Strike (replaces spent Primes)
      <select data-edit="weaponStrike">${Object.keys(E.WEAPON_STRIKES).map((w) => `<option ${c.weaponStrike === w ? "selected" : ""}>${w}</option>`).join("")}</select></label>
    <label class="check" style="flex-direction:row;color:var(--text)"><input type="checkbox" data-edit="dualWield" ${c.dualWield ? "checked" : ""}>Dual wielding (+2 Aether/round)</label>
    <label>Color<input type="color" value="${esc(c.color)}" data-edit="color" style="height:36px;padding:2px"></label>
  </div>
  ${problems.length ? `<ul class="problems">${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
  <datalist id="ability-names">${names}</datalist>
  <h3 style="margin-top:18px">Ability Loadout: roll D12</h3>
  <div>${rows}</div>
  <div class="row-flex" style="margin-top:14px">
    <button class="btn sm" data-act="view" data-view="library">Browse library →</button>
    <span class="spacer"></span>
    <button class="btn sm danger" data-act="delete-char">Delete character</button>
  </div>`;
}

function libraryView(c) {
  const q = state.libFilter.toLowerCase();
  const list = allLibrary()
    .filter((a) => !state.libSource || a.source === state.libSource)
    .filter((a) => !q || a.name.toLowerCase().includes(q) || (a.text || "").toLowerCase().includes(q));
  const sources = [...new Set(allLibrary().map((a) => a.source))];
  const hasText = !!state.library?.abilities?.length;
  return `
  <div class="lib-controls">
    <input placeholder="Search abilities…" value="${esc(state.libFilter)}" data-edit="lib-filter" aria-label="Search">
    <select data-edit="lib-source" aria-label="Heart"><option value="">All sources</option>${sources.map((s) => `<option ${state.libSource === s ? "selected" : ""}>${esc(s)}</option>`).join("")}</select>
    <label class="btn sm" title="Import private/abilities-full.json made by tools/extract_abilities.py">Import rules text…<input type="file" accept=".json,application/json" data-edit="import" hidden></label>
  </div>
  ${hasText ? "" : `<p class="small faint">Showing costs and stats only. To see full effect text on cards, run <code>tools/extract_abilities.py</code> on your PDF and import the JSON it makes. It's stored in this room only.</p>`}
  <div class="lib-list">${list.map((a) => `
    <div class="lib-item" style="--accent:${accent(a.source)}">
      <div class="row"><b>${esc(a.name)}</b><button class="btn sm" data-act="add-ability" data-name="${esc(a.name)}">+ Add</button></div>
      <div class="meta" style="display:flex;gap:4px;flex-wrap:wrap">
        <span class="chip">${esc(a.source)}</span><span class="chip">${a.cost}◆</span>
        ${a.prime ? `<span class="chip prime">Prime</span>` : ""}${a.action === "Reaction" ? `<span class="chip react">Reaction</span>` : ""}
        ${a.range ? `<span class="chip">Range ${esc(a.range)}</span>` : ""}${a.defense ? `<span class="chip">vs ${esc(a.defense)}</span>` : ""}
      </div>
      ${a.text ? `<div class="text">${esc(a.text)}</div>` : ""}
    </div>`).join("")}</div>`;
}

function partyView() {
  if (!state.chars.length) return "";
  return `<div class="panel"><h3>Party</h3>${state.chars.map((c) => {
    const cb = c.combat || E.emptyCombat();
    const mine = c.owner === state.uid;
    const hand = inCombat() ? cb.hand.map((i) => E.effectiveSlot(c, i)?.name).filter(Boolean) : [];
    const tok = state.tokens.find((t) => t.id === pcTokenId(c.id));
    const hp = tok?.hpMax > 0 ? `${Number.isFinite(tok.hp) ? tok.hp : tok.hpMax}/${tok.hpMax} HP` : "";
    return `<div class="party-member">
      <div class="row"><span class="dot" style="background:${esc(c.color)}"></span><span class="nm">${esc(c.name)}${mine ? ` <span class="faint small">(you)</span>` : ""}</span>
        ${inCombat() ? `<span class="mini-aether">${E.available(c)}◆</span>` : ""}
        ${mine ? "" : `<button class="btn sm ghost" data-act="take" data-id="${c.id}" title="Control this character from this device">Take</button>`}</div>
      ${tok ? `<div class="hand-list">Zone ${zoneOf(tok.x)}${hp ? ` · ${hp}` : ""}${tok.conds?.length ? ` · ${tok.conds.map(esc).join(", ")}` : ""}</div>` : ""}
      ${hand.length ? `<div class="hand-list">${hand.map(esc).join(" · ")}</div>` : ""}
      ${cb.spentPrimes?.length ? `<div class="hand-list">Primes spent: ${cb.spentPrimes.map(esc).join(", ")}</div>` : ""}
    </div>`;
  }).join("")}</div>`;
}

function logView() {
  const fmt = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `<div class="panel"><h3>Combat log</h3><div class="log">${state.log.length
    ? state.log.map((l) => `<div class="log-entry" style="--c:${esc(l.color || "")}"><time>${fmt(l.t)}</time>${esc(l.text)}</div>`).join("")
    : `<p class="faint small">Nothing yet.</p>`}</div></div>`;
}

/* ---------------- events ---------------- */
document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const c = active();
  const pos = Number(el.dataset.pos);
  try {
    switch (act) {
      case "random-room": {
        const words = ["EMBER", "RIFT", "AETHER", "HOLLOW", "SPIRE", "VIOLET", "BONE", "STORM", "LABYRINTH", "HELOS"];
        return openRoom(`${words[Math.floor(Math.random() * words.length)]}-${Math.floor(1000 + Math.random() * 9000)}`);
      }
      case "open-room": return openRoom(el.dataset.code);
      case "rules": return setRules(true);
      case "close-rules":
        // The backdrop shares this action; ignore clicks that land inside the sheet.
        if (el.classList.contains("rules-overlay") && e.target !== el) return;
        return setRules(false);
      case "rules-jump": document.getElementById(el.dataset.to)?.scrollIntoView({ behavior: "smooth", block: "start" }); return;
      case "leave": location.hash = ""; return;
      case "copy-link":
        await navigator.clipboard?.writeText(location.href).catch(() => {});
        return toast("Invite link copied.");
      case "start-combat": return startCombat();
      case "next-round": return nextRound();
      case "end-combat": return endCombat();
      case "view": state.view = el.dataset.view; return render();
      case "select-char": state.activeId = el.dataset.id; localStorage.setItem("rbc:active", state.activeId); return render();
      case "new-char": state.addingChar = true; render(); $('[data-form="new-char"] input')?.focus(); return;
      case "cancel-char": state.addingChar = false; return render();
      case "take": {
        const t = state.chars.find((x) => x.id === el.dataset.id);
        if (t && confirm(`Control ${t.name} from this device?`)) await commit(t, { char: { ...t, owner: state.uid }, log: [`${t.name} changed hands.`] });
        return;
      }
      case "delete-char":
        if (c && confirm(`Delete ${c.name}? This can't be undone.`)) {
          await state.store.deleteCharacter(state.code, c.id);
          await state.store.deleteToken(state.code, pcTokenId(c.id));
          state.view = "combat";
        }
        return;
    }
    if (!c) return;
    switch (act) {
      case "play": return commit(c, E.play(c, pos));
      case "play-free": return commit(c, E.play(c, pos, { free: true }));
      case "discard": return commit(c, E.discard(c, pos));
      case "prime-landed": return commit(c, E.primeLanded(c));
      case "prime-resisted": return commit(c, E.primeResisted(c));
      case "draw-one": return commit(c, E.drawOne(c));
      case "draw-full": return commit(c, E.drawToFull(c));
      case "fumble": return commit(c, E.fumble(c));
      case "aether": return commit(c, E.adjustAether(c, Number(el.dataset.d), el.dataset.why));
      case "temp": {
        const ch = structuredClone(c); ch.combat.tempAether += Number(el.dataset.d);
        return commit(c, { char: ch, log: [`${c.name} gains ${el.dataset.d} temporary Aether.`] });
      }
      case "bonus": {
        const ch = structuredClone(c); ch.combat.nextRoundBonus += Number(el.dataset.d);
        return commit(c, { char: ch, log: [`${c.name} will have +${el.dataset.d} Aether next round.`] });
      }
      case "clear-slot": return editSlot(c, Number(el.dataset.slot), () => null);
      case "dup-slot": {
        const i = Number(el.dataset.slot);
        const free = c.loadout.findIndex((s) => !s);
        if (free < 0) return toast("No empty slot.");
        if (E.copiesOf(c.loadout, c.loadout[i].name) >= E.MAX_COPIES) return toast(`Max ${E.MAX_COPIES} copies of an Ability.`);
        return editSlot(c, free, () => structuredClone(c.loadout[i]));
      }
      case "add-ability": {
        const a = allLibrary().find((x) => x.name === el.dataset.name);
        const free = c.loadout.findIndex((s) => !s);
        if (free < 0) return toast("Loadout is full. Clear a slot first.");
        if (E.copiesOf(c.loadout, a.name) >= E.MAX_COPIES) return toast(`Max ${E.MAX_COPIES} copies of ${a.name}.`);
        if (a.name === "Companion" && c.loadout.some((s) => s?.isCompanion)) return toast("Only one Companion per Loadout.");
        await editSlot(c, free, () => slotFromAbility(a));
        return toast(`${a.name} → slot ${free + 1}`);
      }
    }
  } catch (err) {
    console.error(err);
    toast("Something went wrong: " + (err.message || err));
  }
});

async function editSlot(c, i, fn) {
  const ch = structuredClone(c);
  ch.loadout[i] = fn(ch.loadout[i]);
  return commit(c, { char: ch, log: [] });
}

document.addEventListener("change", async (e) => {
  const el = e.target;
  const kind = el.dataset?.edit;
  if (!kind) return;
  const c = active();
  if (kind === "lib-source") { state.libSource = el.value; return render(); }
  if (kind === "import") return importLibrary(el.files[0]);
  if (!c) return;
  const ch = structuredClone(c);
  const i = Number(el.dataset.slot);
  switch (kind) {
    case "char-name": ch.name = el.value.trim().slice(0, 40) || c.name; break;
    case "aetherMax": ch.aetherMax = clampInt(el.value, 1, 30, 10); break;
    case "handSize": ch.handSize = clampInt(el.value, 1, 12, 5); break;
    case "weaponStrike": ch.weaponStrike = el.value; break;
    case "dualWield": ch.dualWield = el.checked; break;
    case "color": ch.color = el.value; break;
    case "name": {
      const v = el.value.trim();
      if (!v) { ch.loadout[i] = null; break; }
      const hit = allLibrary().find((a) => a.name.toLowerCase() === v.toLowerCase());
      if (E.copiesOf(c.loadout.filter((_, k) => k !== i), hit?.name || v) >= E.MAX_COPIES) toast(`Heads up: more than ${E.MAX_COPIES} copies of ${v}.`);
      ch.loadout[i] = hit ? slotFromAbility(hit) : { ...(c.loadout[i] || { cost: 0, prime: false, action: "Standard", range: "", defense: "", note: "" }), name: v.slice(0, 60), source: "Custom" };
      break;
    }
    case "cost": ch.loadout[i].cost = clampInt(el.value, 0, 30, 0); break;
    case "prime": ch.loadout[i].prime = el.checked; break;
    case "reaction": ch.loadout[i].action = el.checked ? "Reaction" : "Standard"; break;
    case "note": ch.loadout[i].note = el.value.slice(0, 600); break;
    case "companion": {
      const a = allLibrary().find((x) => x.name === el.value);
      ch.loadout[i].companionAbility = a ? slotFromAbility(a) : null;
      break;
    }
    default: return;
  }
  await commit(c, { char: ch, log: [] });
});

document.addEventListener("input", (e) => {
  if (e.target.dataset?.edit === "lib-filter") {
    state.libFilter = e.target.value;
    clearTimeout(document.libT);
    document.libT = setTimeout(() => {
      const pos = e.target.selectionStart;
      e.target.blur(); render();
      const f = $('[data-edit="lib-filter"]'); f?.focus(); f?.setSelectionRange(pos, pos);
    }, 200);
  }
});

document.addEventListener("submit", async (e) => {
  const f = e.target.closest("[data-form]");
  if (!f) return;
  e.preventDefault();
  if (f.dataset.form === "join") return openRoom(f.code.value);
  if (f.dataset.form === "new-char") {
    const name = f.name.value.trim().slice(0, 40);
    if (!name) return;
    state.addingChar = false;
    f.name.blur();
    const ch = E.newCharacter(state.uid, name);
    ch.loadout[0] = slotFromAbility(byName.get("weapon strike (one-handed)"));
    const id = await state.store.addCharacter(state.code, ch);
    state.activeId = id; localStorage.setItem("rbc:active", id);
    state.view = "loadout";
    render();
  }
});

const clampInt = (v, lo, hi, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

async function importLibrary(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const abilities = (data.abilities || []).filter((a) => a && typeof a.name === "string").map((a) => ({
      name: a.name.slice(0, 80), source: String(a.source || "Custom").slice(0, 30), cost: Number(a.cost) || 0,
      prime: !!a.prime, action: a.action === "Reaction" ? "Reaction" : "Standard",
      range: String(a.range || "").slice(0, 30), defense: String(a.defense || "").slice(0, 40), text: String(a.text || "").slice(0, 1200),
    }));
    if (!abilities.length) return toast("No abilities found in that file.");
    await state.store.saveLibrary(state.code, { abilities });
    toast(`Imported ${abilities.length} abilities into this room.`);
  } catch (err) {
    console.error(err);
    toast("Couldn't read that file.");
  }
}

/* ---------------- routing ---------------- */
function openRoom(raw) {
  const code = String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
  if (!code) return toast("Enter a room code.");
  location.hash = code;
}

async function enterRoomFromHash() {
  state.unsub.forEach((u) => u());
  state.unsub = [];
  const code = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  state.code = code || null;
  state.room = null; state.chars = []; state.log = []; state.library = null;
  state.tokens = []; state.tokensLoaded = false; state.charsLoaded = false;
  state.board = null;
  if (!code) return render();
  state.board = makeBoard(code);

  const recent = JSON.parse(localStorage.getItem("rbc:recent") || "[]").filter((r) => r !== code);
  localStorage.setItem("rbc:recent", JSON.stringify([code, ...recent].slice(0, 6)));

  render();
  await state.store.ensureRoom(code);
  const s = state.store;
  state.unsub.push(
    s.watchRoom(code, (r) => { state.room = r; render(); processRounds(); }),
    s.watchCharacters(code, (cs) => { state.chars = cs; state.charsLoaded = true; render(); processRounds(); syncPcTokens(); }),
    s.watchTokens(code, (ts) => {
      state.tokens = ts; state.tokensLoaded = true;
      state.board?.update(ts);
      render(); // party panel shows zone / Health
      syncPcTokens();
    }),
    s.watchLog(code, (l) => { state.log = l; render(); }),
    s.watchLibrary(code, (lib) => { state.library = lib; render(); }),
  );
}

(async function main() {
  try {
    const { store, uid, mode } = await createStore();
    Object.assign(state, { store, uid, mode });
  } catch (err) {
    console.error(err);
    $("#app").innerHTML = `<div class="lobby"><h1>Rift Table</h1><p class="tag">Couldn't connect to Firebase. Check js/config.js and that Anonymous sign-in is enabled.</p><pre class="small faint">${esc(err.message || err)}</pre></div>`;
    return;
  }
  window.addEventListener("hashchange", enterRoomFromHash);
  enterRoomFromHash();
})();
