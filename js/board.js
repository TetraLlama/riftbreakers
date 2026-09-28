// Shared battlefield: the book's Combat Zone Grid (4 zones, party starts in
// Zone 1, enemies in Zone 4) as a freeform board with draggable tokens.
//
// The board owns its DOM and diffs tokens by id, so a token being dragged or
// an inspector field being typed in is never clobbered by a live update.
// Positions are stored as fractions (0-1) of the board, so every screen size
// shows the same layout. A token's zone is derived from its x position.

export const ZONES = 4;
const ROMAN = ["I", "II", "III", "IV"];
export const CONDITIONS = [
  "Asleep", "Bleeding", "Blinded", "Burning", "Charmed", "Concealed", "Cursed", "Dazed",
  "Engaged", "Frightened", "Freezing", "Paralyzed", "Poisoned", "Prone", "Restrained", "Stunned",
];
// Protection values used in the bestiary: flat reductions or a die rolled per hit.
const PROTECTION = ["1", "2", "3", "4", "5", "6", "D3", "D4", "D6", "D8", "D10", "D12", "D4+1", "D6+1"];
const PROT_TIP = "Protection (armor): subtract it from the damage of each hit. If it's a die, roll it every hit.";
const protOptions = (cur = "") => {
  const list = cur && !PROTECTION.includes(cur) ? [cur, ...PROTECTION] : PROTECTION;
  return `<option value="">None</option>` + list.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
};
const ENEMY_COLOR = "#c0201b";
const ALLY_COLOR = "#8d877c";

export const zoneOf = (x) => Math.min(ZONES, Math.max(1, Math.floor(x * ZONES) + 1));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (label) => {
  const m = String(label).match(/^(.*?)\s*(\d+)$/); // "Goblin 3" -> "G3"
  if (m) return (m[1][0] || "").toUpperCase() + m[2];
  return String(label).split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
};

/**
 * @param api {{
 *   save(id, token), update(id, patch), remove(id), log(text, color),
 *   onBusyEnd(): void
 * }}
 */
export function createBoard(api) {
  const el = document.createElement("section");
  el.className = "board-wrap";
  el.innerHTML = `
    <div class="board-head">
      <button class="board-toggle" data-b="toggle" aria-expanded="true"><span class="chev">▾</span> Battlefield</button>
      <span class="board-hint faint small">Drag tokens between zones. Tap one to edit it.</span>
      <span class="spacer"></span>
      <button class="btn sm" data-b="add-enemy">+ Enemies</button>
      <button class="btn sm" data-b="add-ally">+ Ally / NPC</button>
      <button class="btn sm ghost" data-b="clear-dead" title="Remove enemies at 0 Health">Clear defeated</button>
    </div>
    <div class="board-body">
      <form class="add-form hidden" data-b="form">
        <input name="label" placeholder="Name (e.g. Goblin)" maxlength="30" required aria-label="Name">
        <label>×<input name="count" type="number" min="1" max="12" value="1" aria-label="How many"></label>
        <label>Health<input name="hp" type="number" min="0" max="999" placeholder="—"></label>
        <label title="${PROT_TIP}">Protection<select name="prot">${protOptions()}</select></label>
        <label>Parry<input name="parry" type="number" min="0" max="100" placeholder="0" aria-label="Parry"></label>
        <label>Evasion<input name="evasion" type="number" min="0" max="100" placeholder="0" aria-label="Evasion"></label>
        <button class="btn primary sm">Add</button>
        <button type="button" class="btn ghost sm" data-b="cancel">Cancel</button>
      </form>
      <div class="field" data-b="field">
        ${Array.from({ length: ZONES }, (_, i) => `
          <div class="zone z${i + 1}">
            <div class="zone-label"><b><span class="zw">Zone </span>${ROMAN[i]}</b><span class="zone-sub">${i === 0 ? "party start" : i === ZONES - 1 ? "enemy start" : ""}</span><span class="zone-range"></span></div>
          </div>`).join("")}
      </div>
      <div class="inspector hidden" data-b="inspector"></div>
    </div>`;

  const field = el.querySelector("[data-b=field]");
  const inspector = el.querySelector("[data-b=inspector]");
  const form = el.querySelector("[data-b=form]");
  const nodes = new Map(); // token id -> element
  let tokens = new Map();
  let selected = null;
  let formKind = "enemy";
  let drag = null;

  try { if (localStorage.getItem("rbc:boardCollapsed") === "1") el.classList.add("collapsed"); } catch {}

  /* ---------- rendering ---------- */
  function update(list) {
    tokens = new Map(list.map((t) => [t.id, t]));
    for (const [id, node] of nodes) {
      if (!tokens.has(id)) { node.remove(); nodes.delete(id); }
    }
    for (const t of tokens.values()) {
      let node = nodes.get(t.id);
      if (!node) {
        node = document.createElement("button");
        node.className = "token";
        node.dataset.id = t.id;
        node.addEventListener("pointerdown", onPointerDown);
        field.appendChild(node);
        nodes.set(t.id, node);
      }
      paintToken(node, t);
    }
    if (selected && !tokens.has(selected)) selected = null;
    paintRanges();
    paintInspector();
  }

  function paintToken(node, t) {
    const dragging = drag && drag.id === t.id;
    if (!dragging) {
      node.style.left = `${t.x * 100}%`;
      node.style.top = `${t.y * 100}%`;
    }
    const hasHp = Number.isFinite(t.hpMax) && t.hpMax > 0;
    const hp = Number.isFinite(t.hp) ? t.hp : t.hpMax;
    const pct = hasHp ? clamp(hp / t.hpMax, 0, 1) : 1;
    const down = hasHp && hp <= 0;
    node.style.setProperty("--c", t.color || "#94a3b8");
    node.style.setProperty("--ink", inkFor(t.color)); // readable initials on any color
    node.classList.toggle("enemy", t.kind === "enemy");
    node.classList.toggle("pc", t.kind === "pc");
    node.classList.toggle("down", down);
    node.classList.toggle("selected", selected === t.id);
    node.setAttribute("aria-label", `${t.label}, Zone ${zoneOf(t.x)}${hasHp ? `, ${hp} of ${t.hpMax} Health` : ""}`);
    const html = `
      <span class="disc">${down ? "☠" : esc(initials(t.label))}</span>
      <span class="tlabel">${esc(t.label)}</span>
      ${hasHp ? `<span class="hpbar"><span style="width:${pct * 100}%;background:${pct > .5 ? "#e9e4d8" : pct > .25 ? "#8d877c" : "#c0201b"}"></span></span>` : ""}
      ${t.conds?.length ? `<span class="cdots" title="${esc(t.conds.join(", "))}">${t.conds.slice(0, 4).map(() => "<i></i>").join("")}</span>` : ""}`;
    if (node._html !== html) { node.innerHTML = html; node._html = html; }
  }

  function paintRanges() {
    const t = selected && tokens.get(selected);
    const from = t ? zoneOf(drag?.id === t.id ? drag.x : t.x) : null;
    field.querySelectorAll(".zone").forEach((z, i) => {
      const r = z.querySelector(".zone-range");
      r.innerHTML = from ? `<span class="zw">range </span>${Math.abs(i + 1 - from)}` : "";
      z.classList.toggle("here", from === i + 1);
    });
  }

  function paintInspector() {
    const t = selected && tokens.get(selected);
    if (!t) { inspector.classList.add("hidden"); inspector.innerHTML = ""; return; }
    // Never rebuild while the user is typing in it.
    if (inspector.contains(document.activeElement) && document.activeElement.matches("input, textarea")) return;
    inspector.classList.remove("hidden");
    const hasHp = Number.isFinite(t.hpMax) && t.hpMax > 0;
    const hp = Number.isFinite(t.hp) ? t.hp : t.hpMax;
    inspector.innerHTML = `
      <div class="insp-head">
        <span class="dot" style="background:${esc(t.color)}"></span>
        <input class="insp-name" value="${esc(t.label)}" data-f="label" maxlength="30" aria-label="Token name">
        <span class="chip">${t.kind === "pc" ? "Player" : t.kind === "enemy" ? "Enemy" : "Ally"}</span>
        <span class="chip">Zone ${ROMAN[zoneOf(t.x) - 1]}</span>
        <span class="spacer"></span>
        <button class="btn sm ghost" data-b="close" aria-label="Close">✕</button>
      </div>
      <div class="insp-grid">
        <div class="insp-hp">
          <div class="hp-big">${hasHp ? `${hp}<small> / ${t.hpMax}</small>` : `<small>no Health set</small>`}</div>
          <div class="row-flex">
            <input type="number" min="0" max="999" value="" placeholder="amt" data-f="amt" aria-label="Amount" style="width:70px">
            <button class="btn sm danger" data-b="dmg">Damage</button>
            <button class="btn sm" data-b="heal">Heal</button>
          </div>
          <label class="small muted">Max Health <input type="number" min="0" max="999" value="${hasHp ? t.hpMax : ""}" data-f="hpMax" style="width:70px"></label>
        </div>
        <div class="insp-stats">
          <label title="${PROT_TIP}">Protection<select data-f="prot">${protOptions(t.prot || "")}</select></label>
          <label>Parry<input type="number" value="${esc(t.parry ?? "")}" data-f="parry"></label>
          <label>Evasion<input type="number" value="${esc(t.evasion ?? "")}" data-f="evasion"></label>
        </div>
      </div>
      <div class="conds">${CONDITIONS.map((c) => `<button class="cond ${t.conds?.includes(c) ? "on" : ""}" data-b="cond" data-c="${c}">${c}</button>`).join("")}</div>
      <textarea data-f="note" placeholder="Notes: rounds left on effects, actions table, etc." maxlength="400">${esc(t.note || "")}</textarea>
      <div class="row-flex">
        <span class="small muted">Move to:</span>
        ${Array.from({ length: ZONES }, (_, i) => `<button class="btn sm ${zoneOf(t.x) === i + 1 ? "primary" : ""}" data-b="to-zone" data-z="${i + 1}">${i + 1}</button>`).join("")}
        <span class="spacer"></span>
        ${t.kind !== "pc" ? `<button class="btn sm" data-b="dup">Duplicate</button><button class="btn sm danger" data-b="del">Remove</button>` : ""}
      </div>`;
  }

  /* ---------- dragging ---------- */
  function fieldPoint(e) {
    const r = field.getBoundingClientRect();
    return { x: clamp((e.clientX - r.left) / r.width, 0.02, 0.98), y: clamp((e.clientY - r.top) / r.height, 0.08, 0.94) };
  }

  function onPointerDown(e) {
    if (e.button !== 0) return;
    const node = e.currentTarget;
    const t = tokens.get(node.dataset.id);
    if (!t) return;
    node.setPointerCapture(e.pointerId);
    const p = fieldPoint(e);
    drag = { id: t.id, node, startX: e.clientX, startY: e.clientY, dx: t.x - p.x, dy: t.y - p.y, x: t.x, y: t.y, fromZone: zoneOf(t.x), moved: false, lastSent: 0 };
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("pointercancel", onPointerUp);
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return;
    drag.moved = true;
    drag.node.classList.add("dragging");
    const p = fieldPoint(e);
    drag.x = clamp(p.x + drag.dx, 0.02, 0.98);
    drag.y = clamp(p.y + drag.dy, 0.08, 0.94);
    drag.node.style.left = `${drag.x * 100}%`;
    drag.node.style.top = `${drag.y * 100}%`;
    paintRanges();
    const now = performance.now();
    if (now - drag.lastSent > 180) { // stream a few positions so others see it slide
      drag.lastSent = now;
      api.update(drag.id, { x: drag.x, y: drag.y });
    }
  }

  async function onPointerUp() {
    const d = drag;
    if (!d) return;
    d.node.removeEventListener("pointermove", onPointerMove);
    d.node.removeEventListener("pointerup", onPointerUp);
    d.node.removeEventListener("pointercancel", onPointerUp);
    d.node.classList.remove("dragging");
    drag = null;
    if (!d.moved) {
      selected = selected === d.id ? null : d.id;
      update([...tokens.values()]);
      api.onBusyEnd();
      return;
    }
    const t = tokens.get(d.id);
    if (t) tokens.set(d.id, { ...t, x: d.x, y: d.y });
    await api.update(d.id, { x: d.x, y: d.y });
    const toZone = zoneOf(d.x);
    if (t && toZone !== d.fromZone) api.log(`${t.label} moves to Zone ${toZone}.`, t.color);
    paintRanges();
    api.onBusyEnd();
  }

  /* ---------- controls ---------- */
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-b]");
    if (!b || b.classList.contains("token")) return;
    const t = selected && tokens.get(selected);
    switch (b.dataset.b) {
      case "toggle": {
        const c = el.classList.toggle("collapsed");
        b.setAttribute("aria-expanded", String(!c));
        try { localStorage.setItem("rbc:boardCollapsed", c ? "1" : "0"); } catch {}
        return;
      }
      case "add-enemy": case "add-ally":
        formKind = b.dataset.b === "add-enemy" ? "enemy" : "ally";
        form.classList.remove("hidden");
        form.label.placeholder = formKind === "enemy" ? "Name (e.g. Goblin)" : "Name (e.g. Town Guard)";
        form.label.focus();
        return;
      case "cancel": closeForm(); return;
      case "clear-dead": {
        const dead = [...tokens.values()].filter((x) => x.kind === "enemy" && Number.isFinite(x.hp) && x.hp <= 0 && x.hpMax > 0);
        if (!dead.length) return;
        await Promise.all(dead.map((x) => api.remove(x.id)));
        api.log(`Cleared ${dead.length} defeated ${dead.length > 1 ? "enemies" : "enemy"}.`, ENEMY_COLOR);
        return;
      }
      case "close": selected = null; update([...tokens.values()]); return;
    }
    if (!t) return;
    switch (b.dataset.b) {
      case "dmg": case "heal": {
        const amtEl = inspector.querySelector("[data-f=amt]");
        const amt = parseInt(amtEl.value, 10);
        if (!Number.isFinite(amt) || amt <= 0) { amtEl.focus(); return; }
        if (!(t.hpMax > 0)) return api.log(`Set ${t.label}'s max Health first.`, t.color);
        const cur = Number.isFinite(t.hp) ? t.hp : t.hpMax;
        const next = b.dataset.b === "dmg" ? cur - amt : Math.min(t.hpMax, cur + amt);
        amtEl.value = "";
        amtEl.blur();
        await api.update(t.id, { hp: next });
        const verb = b.dataset.b === "dmg" ? `takes ${amt} damage` : `heals ${next - cur}`;
        api.log(`${t.label} ${verb} (${Math.max(next, 0)}/${t.hpMax})${next <= 0 ? (t.kind === "pc" ? ". Down! D4+1 rounds to be revived." : ". Defeated!") : "."}`, t.color);
        return;
      }
      case "cond": {
        const c = b.dataset.c;
        const has = t.conds?.includes(c);
        await api.update(t.id, { conds: has ? t.conds.filter((x) => x !== c) : [...(t.conds || []), c] });
        api.log(`${t.label} ${has ? "is no longer" : "is"} ${c}.`, t.color);
        return;
      }
      case "to-zone": {
        const z = Number(b.dataset.z);
        if (z === zoneOf(t.x)) return;
        await api.update(t.id, { x: (z - 0.5) / ZONES });
        api.log(`${t.label} moves to Zone ${z}.`, t.color);
        return;
      }
      case "dup": {
        const copy = { ...t, label: nextLabel(t.label), x: clamp(t.x + 0.03, 0.02, 0.98), y: clamp(t.y + 0.1, 0.08, 0.94), createdAt: Date.now() };
        delete copy.id;
        await api.save(newId(), copy);
        return;
      }
      case "del":
        await api.remove(t.id);
        selected = null;
        return;
    }
  });

  // Inspector field edits commit on change (blur / enter).
  inspector.addEventListener("change", async (e) => {
    const f = e.target.dataset.f;
    const t = selected && tokens.get(selected);
    if (!f || f === "amt" || !t) return;
    const v = e.target.value;
    const num = (x) => (x === "" ? null : clamp(parseInt(x, 10) || 0, 0, 999));
    const patch = {
      label: { label: v.trim().slice(0, 30) || t.label },
      hpMax: { hpMax: num(v), hp: Number.isFinite(t.hp) ? Math.min(t.hp, num(v) ?? t.hp) : num(v) },
      prot: { prot: v.trim().slice(0, 8) },
      parry: { parry: num(v) },
      evasion: { evasion: num(v) },
      note: { note: v.slice(0, 400) },
    }[f];
    if (patch) await api.update(t.id, patch);
  });
  inspector.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.dataset.f === "amt") {
      e.preventDefault();
      inspector.querySelector("[data-b=dmg]").click();
    }
  });
  inspector.addEventListener("focusout", () => setTimeout(() => {
    if (!inspector.contains(document.activeElement)) { paintInspector(); api.onBusyEnd(); }
  }, 0));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const label = form.label.value.trim().slice(0, 30);
    if (!label) return;
    const count = clamp(parseInt(form.count.value, 10) || 1, 1, 12);
    const hpMax = form.hp.value === "" ? null : clamp(parseInt(form.hp.value, 10) || 0, 0, 999);
    const base = {
      kind: formKind, color: formKind === "enemy" ? ENEMY_COLOR : ALLY_COLOR,
      hpMax, hp: hpMax, prot: form.prot.value.trim().slice(0, 8),
      parry: form.parry.value === "" ? null : parseInt(form.parry.value, 10),
      evasion: form.evasion.value === "" ? null : parseInt(form.evasion.value, 10),
      conds: [], note: "",
    };
    const zoneX = formKind === "enemy" ? (ZONES - 0.5) / ZONES : 0.5 / ZONES;
    const existing = [...tokens.values()].filter((t) => Math.abs(t.x - zoneX) < 0.15).length;
    const writes = [];
    for (let i = 0; i < count; i++) {
      const n = existing + i;
      writes.push(api.save(newId(), {
        ...base,
        label: count > 1 ? `${label} ${i + 1}` : label,
        x: clamp(zoneX + ((n % 2) ? 0.05 : -0.05), 0.02, 0.98),
        y: 0.2 + ((n * 0.17) % 0.72),
        createdAt: Date.now() + i,
      }));
    }
    await Promise.all(writes);
    api.log(`${count > 1 ? `${count}× ${label}` : label} ${count > 1 ? "enter" : "enters"} the fight in Zone ${formKind === "enemy" ? ZONES : 1}.`, base.color);
    closeForm();
  });

  // Hiding a focused input leaves focus on it, which would hold off app
  // re-renders (they wait for editing to end), so release focus explicitly.
  function closeForm() {
    if (form.contains(document.activeElement)) document.activeElement.blur();
    form.reset();
    form.classList.add("hidden");
    api.onBusyEnd();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selected && !e.target.matches("input, textarea")) { selected = null; update([...tokens.values()]); }
  });

  return {
    el,
    update,
    // True while a drag or an inspector/form edit is in progress; the app
    // waits to re-render until it ends so the board isn't detached mid-drag.
    isBusy: () => !!drag || el.contains(document.activeElement) && document.activeElement.matches("input, textarea, select"),
  };
}

// Black initials on light colors, bone on dark ones (WCAG relative luminance).
function inkFor(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#000";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? "#000" : "#f4f1ea";
}

function newId() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function nextLabel(label) {
  const m = String(label).match(/^(.*?)\s*(\d+)$/);
  return m ? `${m[1]} ${Number(m[2]) + 1}` : `${label} 2`;
}
