# Rift Table

A shared combat tracker for **Riftbreakers 2e**. Everyone in a room builds
a 12-slot Ability Loadout, then each round the app rolls your D12 hand,
tracks your Aether, and handles Primes, Reactions and Companions. It keeps
a live combat log the whole party can see.

It's a plain static site (HTML + JS, no build step), made to deploy from
GitHub to Netlify. Shared online rooms use a free Firebase project. Without
one, the app runs in **local mode** (saved in your browser, synced across
tabs), which works fine for solo play.

## How it plays

1. **Enter a room.** Type any code (or tap *Make me a code*) and share the
   link. The same code puts everyone in the same room.
2. **Add a character** and fill the 12 Loadout slots from the **Library**
   tab. Costs, Prime and Reaction flags fill in automatically, or you can
   type a custom Ability. The editor warns about more than 3 copies or more
   than one Companion.
3. **Start combat.** Every character refills Aether and rolls a hand of 5.
4. On your turn, tap **Use** on cards to pay their Aether. Tap **✕** to
   discard at the end of your turn.
5. Anyone taps **Next round ⟳**. Everyone refills to max Aether and draws
   back up to 5.
6. **End combat** resets hands, Primes and Companions for everyone.

### Rules the app handles (core book p.14–15, 68–78)

| Rule | What the app does |
|---|---|
| Loadout is a D12 table, max 3 copies, 1 Companion | 12 slots, with warnings |
| Roll D12 until the hand holds 5. A slot already in hand takes the next one, looping 12→1 | Automatic. The log shows e.g. `3, 3→4` |
| Used Abilities are discarded back into the Loadout | Automatic |
| Discard any number at the end of your turn | ✕ on each card |
| Aether is 10, refilled at the start of each round. Dual wielding gives +2 | Max Aether and a dual-wield toggle per character |
| Each Reaction after the first in a round costs +1 cumulative | Shown on the card and charged |
| Prime: once per combat, then all copies become Weapon Strike | Automatic. Pick your Weapon Strike type in Loadout |
| A resisted Prime loses only the copy played | "Resisted" button on the banner |
| Companion (cost 8) becomes its Loadout Ability once summoned | Pick the Companion's ability in its slot |
| Temporary Aether (spent after regular Aether) | +1 Temp button |
| Fumble: lose all Aether for the round | Fumble button |
| Stand up from Prone / potion / swap weapon: 5 Aether | Quick buttons |
| Losing access to an Ability mid-combat: discard and draw | ✕ then **Draw 1** |
| Aether that carries to next round (Aether Boost, etc.) | +2 next round |
| Free Ability (Tactician) | **Free** on any card |

## Ability library & rules text

`js/abilities.js` holds the names, sources, costs, ranges, defenses and
Prime/Reaction flags of the 173 combat Abilities in the core book, **stats
only**. The book's rules text isn't included, so the public repo doesn't
redistribute it.

To see full effect text on your cards, extract it from your own PDF:

```bash
python tools/extract_abilities.py path/to/Riftbreakers_2e.pdf
```

That writes `private/abilities-full.json` (gitignored). In the app, open
**Library → Import rules text…** and pick that file. It's stored in that
room only, so everyone in the room sees the text.

It needs `pdftotext` (included with Git for Windows) or `pip install pypdf`.

## Deploy to Netlify

1. Push this folder to a GitHub repo.
2. On Netlify: **Add new site → Import an existing project → GitHub**, then
   pick the repo. Leave the build command empty and set the publish directory
   to `.` (`netlify.toml` already says this).
3. Deploy. You now have a working site in local mode.

## Set up Firebase (for shared online rooms, about 5 minutes, free)

1. Go to <https://console.firebase.google.com> → **Add project** (Analytics
   isn't needed).
2. **Build → Authentication → Get started → Sign-in method → Anonymous →
   Enable.**
3. **Build → Firestore Database → Create database** → production mode → any
   location.
4. In Firestore, open the **Rules** tab, paste the contents of
   `firestore.rules`, and **Publish**.
5. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register
   an app (no hosting) and copy the `firebaseConfig` object.
6. Paste it into `js/config.js`:

   ```js
   export const FIREBASE_CONFIG = {
     apiKey: "…",
     authDomain: "your-project.firebaseapp.com",
     projectId: "your-project",
     appId: "…",
   };
   ```

7. Commit and push. Netlify redeploys, and the badge in the app switches to
   **● online**.

The Firebase web config isn't a secret (it's meant to ship in client code).
Access is controlled by the Firestore rules. Anyone with a room code can
join that room, so use a code that's hard to guess.

Nobody makes an account: the app signs each browser in anonymously. If a
friend switches devices, they can tap **Take** next to their character in
the Party panel to control it from the new device.

## Run locally

Any static server works:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

## Files

```
index.html              page shell
css/style.css           styles
js/app.js               UI, events, round processing
js/engine.js            the combat rules (pure functions)
js/store.js             storage: Firebase (online) or localStorage (local)
js/config.js            your Firebase config goes here
js/abilities.js         ability stats (generated)
tools/extract_abilities.py   builds abilities.js + private rules-text JSON
firestore.rules         paste into Firebase console
```
