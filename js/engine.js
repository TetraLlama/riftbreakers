// Riftbreakers 2e combat rules, as pure functions over a character object.
// Every function returns { char, log } where `log` is a list of strings to
// post to the room log. The input character is never mutated.
//
// Rules implemented (core book, "The Combat Procedure", p.68-75):
//  - Loadout is a D12 table of 12 slots; max 3 copies of an Ability, 1 Companion.
//  - At the start of your turn, roll D12 until your hand holds 5 Abilities.
//    A roll that lands on a slot already in hand takes the next slot instead,
//    looping 12 -> 1.
//  - Using an Ability costs its Aether and discards it back into the Loadout.
//  - You may discard any number of Abilities at the end of your turn.
//  - Aether refills to max (10, +2 dual wielding) at the start of each round.
//  - Each Reaction after the first in a round costs +1 cumulative Aether.
//  - Prime Abilities: once per combat. After use, every copy in Loadout and
//    hand becomes Weapon Strike. If a Prime is resisted, only that copy is
//    lost and the rest stay available.
//  - Companion: takes a slot; when summoned, the slot becomes the Companion's
//    Loadout Ability for the rest of combat.
//  - Fumble: lose all Aether for the round.

export const SLOTS = 12;
export const DEFAULT_HAND = 5;
export const MAX_COPIES = 3;

export const WEAPON_STRIKES = {
  "Weapon Strike (One-Handed)": { cost: 3, range: "As weapon", defense: "Parry", text: "Weapon skill check. On hit, D6+2 damage." },
  "Weapon Strike (Two-Handed)": { cost: 3, range: "As weapon", defense: "Parry", text: "Weapon skill check. On hit, 2D6 damage." },
  "Weapon Strike (Ranged)": { cost: 3, range: "As weapon", defense: "Evasion", text: "Weapon skill check. On hit, D6+2 damage." },
  "Unarmed Strike (One-Handed)": { cost: 3, range: "0", defense: "Parry", text: "Unarmed Combat check. On hit, D6 Bludgeoning damage." },
};

const clone = (o) => JSON.parse(JSON.stringify(o));
const d12 = () => 1 + Math.floor(Math.random() * 12);

export function newCharacter(owner, name) {
  return {
    owner,
    name,
    color: ["#7dd3fc", "#f0abfc", "#fcd34d", "#86efac", "#fca5a5", "#c4b5fd"][Math.floor(Math.random() * 6)],
    aetherMax: 10,
    dualWield: false,
    handSize: DEFAULT_HAND,
    weaponStrike: "Weapon Strike (One-Handed)",
    loadout: Array(SLOTS).fill(null),
    combat: emptyCombat(),
  };
}

export function emptyCombat() {
  return {
    combatId: null,
    roundSeen: 0,
    hand: [],
    aether: 0,
    tempAether: 0,
    nextRoundBonus: 0,
    reactions: 0,
    spentPrimes: [],   // names of Primes used successfully this combat
    lostSlots: [],     // slot indexes turned into Weapon Strike (resisted Primes)
    companionOut: false,
    lastRolls: [],     // [{roll, slot}] from the most recent draw
    pendingPrime: null // {slot, name} awaiting "landed / resisted"
  };
}

export function roundMax(c) {
  return (c.aetherMax || 10) + (c.dualWield ? 2 : 0);
}

// What a slot actually is right now, after Prime/Companion transformations.
export function effectiveSlot(c, i) {
  const s = c.loadout[i];
  if (!s) return null;
  const cb = c.combat;
  if (s.prime && (cb.spentPrimes.includes(s.name) || cb.lostSlots.includes(i))) {
    return { ...weaponStrikeSlot(c), transformedFrom: s.name };
  }
  if (s.isCompanion && cb.companionOut) {
    if (!s.companionAbility) return { name: "Companion (in play)", cost: 0, action: "Standard", range: "", defense: "", transformedFrom: s.name, spent: true };
    return { ...s.companionAbility, transformedFrom: s.name };
  }
  return s;
}

export function weaponStrikeSlot(c) {
  const name = c.weaponStrike || "Weapon Strike (One-Handed)";
  return { name, action: "Standard", source: "Weapon", prime: false, ...WEAPON_STRIKES[name] };
}

export function copiesOf(loadout, name) {
  return loadout.filter((s) => s && s.name === name).length;
}

export function loadoutProblems(c) {
  const problems = [];
  const counts = {};
  c.loadout.forEach((s) => { if (s) counts[s.name] = (counts[s.name] || 0) + 1; });
  for (const [n, k] of Object.entries(counts)) {
    if (k > MAX_COPIES) problems.push(`${n} has ${k} copies (max ${MAX_COPIES}).`);
  }
  if (c.loadout.filter((s) => s && s.isCompanion).length > 1) problems.push("Only one Companion can be in a Loadout.");
  const empty = c.loadout.filter((s) => !s).length;
  if (empty) problems.push(`${empty} empty slot${empty > 1 ? "s" : ""}. Rolls that land there skip to the next filled slot.`);
  return problems;
}

// Roll D12 until the hand is full. Duplicate or empty results take the next slot.
export function drawToFull(char, max = null) {
  const c = clone(char);
  const cb = c.combat;
  const filled = c.loadout.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
  const target = Math.min(max ?? c.handSize ?? DEFAULT_HAND, filled.length);
  const rolls = [];
  while (cb.hand.length < target) {
    const roll = d12();
    let slot = roll - 1;
    for (let step = 0; step < SLOTS && (cb.hand.includes(slot) || !c.loadout[slot]); step++) {
      slot = (slot + 1) % SLOTS;
    }
    cb.hand.push(slot);
    rolls.push({ roll, slot });
  }
  cb.lastRolls = rolls;
  const log = rolls.length
    ? [`${c.name} rolled ${rolls.map((r) => r.roll === r.slot + 1 ? `${r.roll}` : `${r.roll}→${r.slot + 1}`).join(", ")}: drew ${rolls.map((r) => effectiveSlot(c, r.slot).name).join(", ")}.`]
    : [];
  return { char: c, log };
}

export function drawOne(char) {
  return drawToFull(char, char.combat.hand.length + 1);
}

// Start of a new round: refill Aether, reset Reaction surcharge, draw to full.
export function startRound(char, round) {
  let c = clone(char);
  const cb = c.combat;
  cb.aether = roundMax(c) + (cb.nextRoundBonus || 0);
  cb.nextRoundBonus = 0;
  cb.reactions = 0;
  cb.roundSeen = round;
  const bonus = cb.aether - roundMax(c);
  const log = [`— Round ${round} — ${c.name} refills to ${cb.aether} Aether${bonus > 0 ? ` (+${bonus} carried over)` : ""}.`];
  const drawn = drawToFull(c);
  return { char: drawn.char, log: log.concat(drawn.log) };
}

export function startCombat(char, combatId, round) {
  const c = clone(char);
  const temp = c.combat?.tempAether || 0; // Temporary Aether lasts until spent or sleep.
  c.combat = { ...emptyCombat(), combatId, tempAether: temp };
  return startRound(c, round);
}

export function endCombat(char) {
  const c = clone(char);
  c.combat = { ...emptyCombat(), tempAether: c.combat?.tempAether || 0 };
  return { char: c, log: [] };
}

export function playCost(c, slotIdx) {
  const s = effectiveSlot(c, slotIdx);
  if (!s) return 0;
  const surcharge = s.action === "Reaction" ? c.combat.reactions : 0;
  return (s.cost || 0) + surcharge;
}

export function available(c) {
  return c.combat.aether + c.combat.tempAether;
}

function spend(cb, amount) {
  const fromMain = Math.min(cb.aether, amount);
  cb.aether -= fromMain;
  cb.tempAether -= amount - fromMain;
}

// Use an Ability from hand. `free` skips the Aether cost (e.g. Tactician).
export function play(char, handPos, { free = false } = {}) {
  const c = clone(char);
  const cb = c.combat;
  const slotIdx = cb.hand[handPos];
  const s = effectiveSlot(c, slotIdx);
  if (!s || s.spent) return { char, log: [] };
  const cost = free ? 0 : playCost(c, slotIdx);
  if (cost > available(c)) return { char, log: [], error: `Not enough Aether (${cost} needed).` };

  spend(cb, cost);
  cb.hand.splice(handPos, 1);
  if (s.action === "Reaction") cb.reactions += 1;

  const raw = c.loadout[slotIdx];
  let note = "";
  if (raw.isCompanion && !cb.companionOut) {
    cb.companionOut = true;
    note = raw.companionAbility ? ` Slot ${slotIdx + 1} becomes ${raw.companionAbility.name}.` : "";
  } else if (s.prime && !s.transformedFrom) {
    cb.spentPrimes.push(s.name);
    cb.pendingPrime = { slot: slotIdx, name: s.name };
    note = ` Prime: all copies become ${weaponStrikeSlot(c).name}.`;
  }
  const verb = s.action === "Reaction" ? "reacts with" : "uses";
  return { char: c, log: [`${c.name} ${verb} ${s.name} (−${cost} Aether, ${available(c)} left).${note}`] };
}

// A Prime that was resisted only loses the copy that was played.
export function primeResisted(char) {
  const c = clone(char);
  const cb = c.combat;
  const p = cb.pendingPrime;
  if (!p) return { char, log: [] };
  cb.spentPrimes = cb.spentPrimes.filter((n) => n !== p.name);
  cb.lostSlots.push(p.slot);
  cb.pendingPrime = null;
  const left = c.loadout.filter((s, i) => s && s.name === p.name && !cb.lostSlots.includes(i)).length;
  return { char: c, log: [`${p.name} was resisted. ${left ? `${left} cop${left > 1 ? "ies" : "y"} left in ${c.name}'s Loadout.` : "No copies left."}`] };
}

export function primeLanded(char) {
  const c = clone(char);
  c.combat.pendingPrime = null;
  return { char: c, log: [] };
}

export function discard(char, handPos) {
  const c = clone(char);
  const [slotIdx] = c.combat.hand.splice(handPos, 1);
  return { char: c, log: [`${c.name} discards ${effectiveSlot(c, slotIdx)?.name}.`] };
}

export function adjustAether(char, delta, reason) {
  const c = clone(char);
  const cb = c.combat;
  if (delta < 0) {
    const cost = Math.min(-delta, available(c));
    spend(cb, cost);
    return { char: c, log: [`${c.name}: ${reason} (−${cost} Aether, ${available(c)} left).`] };
  }
  cb.aether += delta;
  return { char: c, log: [`${c.name}: ${reason} (+${delta} Aether).`] };
}

export function fumble(char) {
  const c = clone(char);
  c.combat.aether = 0;
  return { char: c, log: [`${c.name} fumbles! All Aether lost for the round.`] };
}
