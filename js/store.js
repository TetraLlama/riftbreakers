// Storage adapters. Both expose the same interface:
//
//   await store.init()                  -> { uid, mode }
//   store.watchRoom(code, cb)           -> unsubscribe   cb(room | null)
//   store.watchCharacters(code, cb)     -> unsubscribe   cb([{id, ...char}])
//   store.watchLog(code, cb)            -> unsubscribe   cb([{id, t, text, color}]) newest first
//   store.watchLibrary(code, cb)        -> unsubscribe   cb({abilities} | null)
//   await store.ensureRoom(code)
//   await store.updateRoom(code, fn)     fn(room) -> patch | null (transactional)
//   await store.saveCharacter(code, id, char)
//   await store.addCharacter(code, char) -> id
//   await store.deleteCharacter(code, id)
//   await store.addLog(code, entries)    entries: [{text, color}]
//   await store.saveLibrary(code, lib)
//   store.watchTokens(code, cb)          -> unsubscribe   cb([{id, ...token}])
//   await store.saveToken(code, id, token)   full write (create or replace)
//   await store.updateToken(code, id, patch) merge into an existing token
//   await store.deleteToken(code, id)
import { FIREBASE_CONFIG } from "./config.js";

const LOG_LIMIT = 60;

export async function createStore() {
  const store = FIREBASE_CONFIG ? new FirebaseStore(FIREBASE_CONFIG) : new LocalStore();
  const info = await store.init();
  return { store, ...info };
}

/* ------------------------------------------------------------------ */
/* Local mode: localStorage + BroadcastChannel to sync tabs.          */
/* ------------------------------------------------------------------ */
class LocalStore {
  constructor() {
    this.listeners = new Set();
    this.channel = "BroadcastChannel" in window ? new BroadcastChannel("rbc") : null;
    if (this.channel) this.channel.onmessage = () => this.emit();
    window.addEventListener("storage", () => this.emit());
  }

  async init() {
    let uid = localStorage.getItem("rbc:uid");
    if (!uid) {
      uid = "local-" + Math.random().toString(36).slice(2, 10);
      localStorage.setItem("rbc:uid", uid);
    }
    return { uid, mode: "local" };
  }

  key(code) { return "rbc:room:" + code; }
  read(code) {
    try { return JSON.parse(localStorage.getItem(this.key(code))) || null; } catch { return null; }
  }
  write(code, data) {
    localStorage.setItem(this.key(code), JSON.stringify(data));
    this.channel?.postMessage(code);
    this.emit();
  }
  emit() { for (const l of this.listeners) l(); }
  watch(fn) {
    const l = () => fn();
    this.listeners.add(l);
    queueMicrotask(l);
    return () => this.listeners.delete(l);
  }

  watchRoom(code, cb) { return this.watch(() => cb(this.read(code)?.room ?? null)); }
  watchCharacters(code, cb) {
    return this.watch(() => {
      const chars = this.read(code)?.characters || {};
      cb(Object.entries(chars).map(([id, c]) => ({ id, ...c })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
    });
  }
  watchLog(code, cb) { return this.watch(() => cb((this.read(code)?.log || []).slice(0, LOG_LIMIT))); }
  watchLibrary(code, cb) { return this.watch(() => cb(this.read(code)?.library ?? null)); }

  async ensureRoom(code) {
    if (!this.read(code)) {
      this.write(code, { room: { round: 0, combatId: null, createdAt: Date.now() }, characters: {}, log: [], library: null });
    }
  }
  async updateRoom(code, fn) {
    const d = this.read(code);
    const patch = fn(d.room);
    if (patch) { d.room = { ...d.room, ...patch }; this.write(code, d); }
    return !!patch;
  }
  async saveCharacter(code, id, char) {
    const d = this.read(code);
    d.characters[id] = char;
    this.write(code, d);
  }
  async addCharacter(code, char) {
    const id = "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await this.saveCharacter(code, id, { ...char, createdAt: Date.now() });
    return id;
  }
  async deleteCharacter(code, id) {
    const d = this.read(code);
    delete d.characters[id];
    this.write(code, d);
  }
  async addLog(code, entries) {
    if (!entries.length) return;
    const d = this.read(code);
    const now = Date.now();
    const rows = entries.map((e, i) => ({ id: `${now}-${i}`, t: now + i, ...e })).reverse();
    d.log = rows.concat(d.log || []).slice(0, LOG_LIMIT);
    this.write(code, d);
  }
  async saveLibrary(code, lib) {
    const d = this.read(code);
    d.library = lib;
    this.write(code, d);
  }

  watchTokens(code, cb) {
    return this.watch(() => cb(Object.entries(this.read(code)?.tokens || {}).map(([id, t]) => ({ id, ...t }))));
  }
  async saveToken(code, id, token) {
    const d = this.read(code);
    d.tokens = { ...(d.tokens || {}), [id]: token };
    this.write(code, d);
  }
  async updateToken(code, id, patch) {
    const d = this.read(code);
    if (!d.tokens?.[id]) return;
    d.tokens[id] = { ...d.tokens[id], ...patch };
    this.write(code, d);
  }
  async deleteToken(code, id) {
    const d = this.read(code);
    if (d.tokens) delete d.tokens[id];
    this.write(code, d);
  }
}

/* ------------------------------------------------------------------ */
/* Online mode: Firebase Auth (anonymous) + Firestore.                */
/* ------------------------------------------------------------------ */
const FB = "https://www.gstatic.com/firebasejs/10.12.2/";

class FirebaseStore {
  constructor(config) { this.config = config; }

  async init() {
    const [{ initializeApp }, auth, fs] = await Promise.all([
      import(FB + "firebase-app.js"),
      import(FB + "firebase-auth.js"),
      import(FB + "firebase-firestore.js"),
    ]);
    this.fs = fs;
    const app = initializeApp(this.config);
    this.db = fs.getFirestore(app);
    const a = auth.getAuth(app);
    const cred = a.currentUser ? { user: a.currentUser } : await new Promise((resolve, reject) => {
      const off = auth.onAuthStateChanged(a, (u) => {
        if (u) { off(); resolve({ user: u }); }
      });
      auth.signInAnonymously(a).catch(reject);
    });
    return { uid: cred.user.uid, mode: "online" };
  }

  roomRef(code) { return this.fs.doc(this.db, "rooms", code); }
  col(code, name) { return this.fs.collection(this.db, "rooms", code, name); }

  watchRoom(code, cb) {
    return this.fs.onSnapshot(this.roomRef(code), (s) => cb(s.exists() ? s.data() : null), (e) => console.error(e));
  }
  watchCharacters(code, cb) {
    return this.fs.onSnapshot(this.col(code, "characters"), (s) => {
      cb(s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)));
    }, (e) => console.error(e));
  }
  watchLog(code, cb) {
    const { query, orderBy, limit, onSnapshot } = this.fs;
    return onSnapshot(query(this.col(code, "log"), orderBy("t", "desc"), limit(LOG_LIMIT)),
      (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.error(e));
  }
  watchLibrary(code, cb) {
    return this.fs.onSnapshot(this.fs.doc(this.db, "rooms", code, "meta", "library"),
      (s) => cb(s.exists() ? s.data() : null), (e) => console.error(e));
  }

  async ensureRoom(code) {
    const { getDoc, setDoc } = this.fs;
    const s = await getDoc(this.roomRef(code));
    if (!s.exists()) await setDoc(this.roomRef(code), { round: 0, combatId: null, createdAt: Date.now() });
  }
  async updateRoom(code, fn) {
    return this.fs.runTransaction(this.db, async (tx) => {
      const s = await tx.get(this.roomRef(code));
      const patch = fn(s.data());
      if (patch) tx.update(this.roomRef(code), patch);
      return !!patch;
    });
  }
  async saveCharacter(code, id, char) {
    const { id: _drop, ...body } = char;
    await this.fs.setDoc(this.fs.doc(this.db, "rooms", code, "characters", id), body);
  }
  async addCharacter(code, char) {
    const ref = await this.fs.addDoc(this.col(code, "characters"), { ...char, createdAt: Date.now() });
    return ref.id;
  }
  async deleteCharacter(code, id) {
    await this.fs.deleteDoc(this.fs.doc(this.db, "rooms", code, "characters", id));
  }
  async addLog(code, entries) {
    if (!entries.length) return;
    const batch = this.fs.writeBatch(this.db);
    const now = Date.now();
    entries.forEach((e, i) => batch.set(this.fs.doc(this.col(code, "log")), { t: now + i, ...e }));
    await batch.commit();
  }
  async saveLibrary(code, lib) {
    await this.fs.setDoc(this.fs.doc(this.db, "rooms", code, "meta", "library"), lib);
  }

  watchTokens(code, cb) {
    return this.fs.onSnapshot(this.col(code, "tokens"),
      (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() }))), (e) => console.error(e));
  }
  async saveToken(code, id, token) {
    const { id: _drop, ...body } = token;
    await this.fs.setDoc(this.fs.doc(this.db, "rooms", code, "tokens", id), body);
  }
  async updateToken(code, id, patch) {
    await this.fs.updateDoc(this.fs.doc(this.db, "rooms", code, "tokens", id), patch);
  }
  async deleteToken(code, id) {
    await this.fs.deleteDoc(this.fs.doc(this.db, "rooms", code, "tokens", id));
  }
}
