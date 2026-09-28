// Combat flow reference ("Order of Battle"), checked against the core book's
// combat chapter (p.68-78) and the Bestiary's monster rules. Summaries only.

const step = (title, body, cls = "") => `
  <div class="fl-node ${cls}">
    <div class="fl-title">${title}</div>
    ${body ? `<div class="fl-body">${body}</div>` : ""}
  </div>`;

const branch = (items) => `<div class="fl-branch">${items.map(([k, v, cls]) =>
  `<div class="fl-out ${cls || ""}"><b>${k}</b><span>${v}</span></div>`).join("")}</div>`;

export function rulesHTML() {
  return `
  <div class="rules-overlay" data-act="close-rules">
    <article class="rules-sheet" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="rules-title">
      <header class="rules-head">
        <h2 id="rules-title">The Order of Battle</h2>
        <span class="faint small">Riftbreakers 2e combat, step by step</span>
        <span class="spacer"></span>
        <button class="btn sm" data-act="close-rules" aria-label="Close rules">✕</button>
      </header>

      <section class="fl-section">
        <h3><span class="fl-num">I</span> Before the first blow</h3>
        <div class="fl-chain">
          ${step("Surprise <em>(optional)</em>",
            `Opposed check: the party's <b>lowest Stealth</b> against the enemies' <b>highest Perception</b>.
             A lone PC with followers takes <b>−10 Stealth per follower</b>. Not possible if the enemy surprised you.`)}
          ${branch([
            ["Success", "You win initiative <i>and</i> take a <b>free turn</b> before combat begins."],
            ["Failure", "Roll initiative normally, but your Perception has <b>Disadvantage</b>.", "bad"],
          ])}
          ${step("Initiative",
            `Opposed <b>Perception</b> check. The winner's side acts first for the whole fight.
             A <b>critical failure</b> lets the other side attack as if it had surprise.`)}
        </div>
      </section>

      <section class="fl-section">
        <h3><span class="fl-num">II</span> Each round</h3>
        <div class="fl-banner">Every PC's Aether refills to <b>10</b> (<b>+2</b> when dual wielding two Agile weapons). Turns follow initiative order.
          <span class="faint">In this app: press <b>Next round</b>.</span></div>

        <div class="fl-cols">
          <div class="fl-col">
            <h4>Your turn</h4>
            <div class="fl-chain">
              ${step("<span class='ln'>1</span> · Draw", `Roll D12 on your Loadout until you hold <b>5</b> Abilities. A slot already in hand takes the <b>next</b> slot (12 → 1).`)}
              ${step("<span class='ln'>2</span> · Act, in any order", `
                <ul class="fl-list">
                  <li><b>Move</b>: one adjacent Zone per round. If <b>Engaged</b>, you must Disengage first.</li>
                  <li><b>Use an Ability</b>: pay its Aether. It returns to your Loadout right after use. <i>Standard Actions: as many as your Aether allows.</i></li>
                  <li><b>Consumable</b>: 5 Aether, or free from a belt quickslot.</li>
                  <li><b>Swap weapon</b>: 5 Aether. Your Weapon Strikes change to the new weapon.</li>
                  <li><b>Stand up</b> from Prone: 5 Aether.</li>
                  <li><b>Disengage</b>: opposed Agility against everyone Engaged with you. Free, once per round.</li>
                  <li><b>Flee</b>: opposed Agility against <i>every</i> enemy on the field. Free, once per round.</li>
                </ul>`)}
              <div class="fl-decide">
                <div class="fl-q">Does the Ability call for an attack check?</div>
                <div class="fl-cols tight">
                  <div class="fl-col">
                    <div class="fl-tag">No</div>
                    ${step("It simply happens", `If it lists a <b>Defense</b>, the target rolls that check to resist.
                      Otherwise, apply the effect or <a class="fl-link" data-act="rules-jump" data-to="fl-damage">damage</a>.`, "sm")}
                  </div>
                  <div class="fl-col">
                    <div class="fl-tag">Yes <span class="faint">(e.g. Weapon Strike)</span></div>
                    ${step("Roll D<span class='ln'>100</span>", `Against your weapon skill <b>− target's Parry</b> (melee) or <b>− Evasion</b> (ranged). Equal or under hits.`, "sm")}
                    ${branch([
                      ["Doubles, hit", "Critical Strike: <b>double damage</b>."],
                      ["Hit", "Apply <a class=\"fl-link\" data-act=\"rules-jump\" data-to=\"fl-damage\">damage</a>."],
                      ["Doubles, miss", "Fumble: lose <b>all Aether</b> and do nothing else this turn.", "bad"],
                    ])}
                  </div>
                </div>
              </div>
              ${step("<span class='ln'>3</span> · End of turn", `Discard any Abilities you don't want. They go back into your Loadout.`)}
            </div>
            <div class="fl-aside">
              <b>Reactions</b>: played on a trigger, even on others' turns. The first each round costs its normal Aether. Each one after adds <b>+1</b>, cumulative.
            </div>
            <div class="fl-aside">
              <b>Prime Abilities</b>: once per combat. After use, every copy becomes Weapon Strike. If the target resists it, only the copy played is lost.
            </div>
          </div>

          <div class="fl-col enemy">
            <h4>Monster's turn</h4>
            <div class="fl-chain">
              ${step("<span class='ln'>1</span> · Pick targets", `Monsters <b>spread evenly</b> across the party, <b>PCs before Companions</b>.
                Extra monsters go for the PC with the <b>lowest Health</b> (ties: random).
                A monster sticks to its target until that target is down, it can't reach them, or an Action makes it switch.`)}
              ${step("<span class='ln'>2</span> · Move", `
                <ul class="fl-list">
                  <li><b>Melee</b> monsters rush in to stay at range 0.</li>
                  <li><b>Ranged</b> monsters keep at least one Zone between themselves and the PCs.
                    If Engaged, they try to Disengage. If that fails, they attack instead (Combat Skill check, <b>2D6 Force</b>).</li>
                </ul>`)}
              ${step("<span class='ln'>3</span> · Roll the Action table", `Roll <b>D6</b> (Riftlords: <b>D8</b>) once per <b>Action</b> in their stat block and do what it says.
                Attacks roll <b>Combat Skill − PC's Parry</b>.
                A "Basic Attack" is the first entry on the table. If it can't be used: <b>D8 Bludgeoning</b>.`)}
              ${branch([
                ["Doubles, hit", "Critical Strike: double damage."],
                ["Doubles, miss", "Fumble: the monster is <b>Stunned</b> until its next turn.", "bad"],
              ])}
            </div>
            <div class="fl-aside">
              <b>Traits</b> such as Savage (can't be Parried), Pack, Anti-Magic (−2 Aether for PCs) and Suppression Aura (−10 to checks) change the math.
            </div>
          </div>
        </div>
      </section>

      <section class="fl-section" id="fl-damage">
        <h3><span class="fl-num">III</span> Resolving damage</h3>
        <ol class="fl-steps">
          <li><b>Roll</b> the damage listed by the Ability, weapon or Action.</li>
          <li><b>Critical Strike?</b> Double it.</li>
          <li><b>Target's affinity</b>: Vulnerable ×2 · Resistant ×½ · Immune 0 · Restored heals instead.</li>
          <li><b>Protection</b>: subtract it (roll it if it's a die), unless the damage type ignores it.</li>
          <li><b>Health</b>: what's left comes off Health. Round up.</li>
        </ol>
        <div class="fl-types">
          <div><b>Ignore Protection</b><span>Arcane, Cold, Fire, Force, Lightning, Necrotic, Psychic, Radiant, Void. Also Bleeding and Poisoned damage.</span></div>
          <div><b>Bludgeoning</b><span>Ignores 1 Protection.</span></div>
          <div><b>Slashing</b><span>+1 against targets with no Protection.</span></div>
          <div><b>Piercing</b><span>+3 on a Critical Strike.</span></div>
          <div><b>Acid</b><span>Armor loses one Integrity step. Monsters: −1 Protection, the first time each round.</span></div>
        </div>
      </section>

      <section class="fl-section">
        <h3><span class="fl-num">IV</span> When the dust settles</h3>
        <div class="fl-cols">
          <div class="fl-col">
            ${step("A PC falls to <span class='ln'>0</span> Health", `They have <b>D4+1 rounds</b> to be brought back to at least 1 Health, or they die.`, "bad")}
            ${step("Death", `Wake in <b>Kar Helos</b> without your possessions (they stay with your corpse).
              Lose <b>one Ability</b> of your choice and <b>D4 max Health</b>.
              The Quest Board provides basic gear: an armor, a weapon (plus a UD8 quiver if ranged) and 2 Minor Healing potions.`, "bad")}
          </div>
          <div class="fl-col">
            ${step("Survivors", `Roll the <b>Integrity</b> die of any armor or shield that saw use (Usage Die: a 1–2 drops it one step; a 1–2 on a D4 breaks it).`)}
            ${step("Conditions end", `All conditions end with combat unless stated otherwise (e.g. Asleep, Bleeding).`)}
          </div>
        </div>
      </section>

      <p class="fl-foot faint small">Summarized from the Riftbreakers 2e core rules (Combat, p.68–78; Bestiary).
        Your GM has the final word.</p>
    </article>
  </div>`;
}
