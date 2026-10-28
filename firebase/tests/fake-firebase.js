/*
 * A fake Firebase for tests: an in-memory "server" that runs the REAL security rules (through the targaryen
 * simulator), and fake browser SDKs that talk to it. Used to test MultiplayerClient.js and the lobby screen
 * with two "browsers" (two different guest ids) playing each other.
 */
const targaryen = require("targaryen");
const rules = require("../database.rules.json");

// Firebase shows objects whose keys are 0,1,2... as arrays when more than half of the slots are filled.
function toFirebase(v) {
    if (v === null || v === undefined || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(toFirebase);
    const keys = Object.keys(v);
    const out = {};
    keys.forEach(k => { out[k] = toFirebase(v[k]); });
    if (keys.length && keys.every(k => /^(0|[1-9]\d*)$/.test(k))) {
        const max = Math.max(...keys.map(Number));
        if (keys.length > (max + 1) / 2) {
            const arr = [];
            for (let i = 0; i <= max; i++) arr.push(out[i] === undefined ? null : out[i]);
            return arr;
        }
    }
    return out;
}

class FakeServer {
    constructor(startTime) {
        this.t = startTime || 1700000000000;
        this.db = targaryen.database(rules, {}, this.t);
        this.listeners = [];
        this.clients = [];
    }
    now() { return this.t; }
    advance(ms) { this.t += ms; }
    value(path) { return toFirebase(this.db.snapshot("/" + path).val()); }
    snap(path) {
        const v = this.value(path);
        return { val: () => (v === undefined ? null : v), exists: () => v !== null && v !== undefined, key: path.split("/").pop() };
    }
    permissionError() {
        const e = new Error("PERMISSION_DENIED: Permission denied");
        e.code = "PERMISSION_DENIED";
        return e;
    }
    write(auth, kind, path, value) {
        value = JSON.parse(JSON.stringify(value === undefined ? null : value));   // plain copy (values from another jsdom window are a different "realm")
        const abs = "/" + path;
        const res = kind === "set" ? this.db.as(auth).write(abs, value, { now: this.t }) : this.db.as(auth).update(abs, value, { now: this.t });
        if (!res.allowed) throw this.permissionError();
        this.db = res.newDatabase;
        this.notify();
    }
    canRead(auth, path) { return this.db.as(auth).read("/" + path, { now: this.t }).allowed; }
    notify() {
        this.listeners.slice().forEach(l => {
            if (l.removed || l.path.startsWith(".info")) return;
            const json = JSON.stringify(this.value(l.path));
            if (json !== l.last) { l.last = json; const s = this.snap(l.path); Promise.resolve().then(() => { if (!l.removed) l.cb(s); }); }
        });
    }
    // Put a ready-made room into the database (to reach end-of-game situations quickly in tests).
    seed(code, room) {
        const data = this.db.snapshot("/").val() || {};
        data.rooms = Object.assign(data.rooms || {}, { [code]: JSON.parse(JSON.stringify(room)) });
        this.db = targaryen.database(rules, data, this.t);
    }
    // A fake browser. `uid` is its guest id; `restored` = already signed in (like a page refresh).
    browser(uid, opts) {
        return new FakeBrowser(this, uid, opts || {});
    }
}

class FakeBrowser {
    constructor(server, uid, opts) {
        this.server = server;
        this.uid = uid;
        this.auth = { uid: uid };
        this.connected = true;
        this.disconnectOps = [];
        this.failSignIn = opts.failSignIn || null;       // error code to throw on sign-in
        this.user = opts.restored ? { uid: uid } : null;
        server.clients.push(this);
        this.connListeners = [];
        const self = this;
        const ServerValue = { TIMESTAMP: { ".sv": "timestamp" } };

        const dbApi = {
            ref(path) {
                path = String(path).replace(/^\/+/, "");
                const wrap = fn => new Promise((resolve, reject) => { try { resolve(fn()); } catch (e) { reject(e); } });
                return {
                    set: v => wrap(() => server.write(self.auth, "set", path, v)),
                    update: v => wrap(() => server.write(self.auth, "update", path, v)),
                    remove: () => wrap(() => server.write(self.auth, "set", path, null)),
                    once: () => wrap(() => {
                        if (!server.canRead(self.auth, path)) throw server.permissionError();
                        return server.snap(path);
                    }),
                    on(ev, cb, errCb) {
                        if (path === ".info/connected") {
                            const l = { cb, removed: false };
                            self.connListeners.push(l);
                            Promise.resolve().then(() => { if (!l.removed) cb({ val: () => self.connected }); });
                            this._l = l; this._cb = cb;
                            return cb;
                        }
                        if (path === ".info/serverTimeOffset") { Promise.resolve().then(() => cb({ val: () => 0 })); return cb; }
                        if (!server.canRead(self.auth, path)) { if (errCb) Promise.resolve().then(() => errCb(server.permissionError())); return cb; }
                        const l = { path, cb, removed: false, last: JSON.stringify(server.value(path)), client: self };
                        server.listeners.push(l);
                        Promise.resolve().then(() => { if (!l.removed) cb(server.snap(path)); });
                        return cb;
                    },
                    off(ev, cb) {
                        server.listeners.forEach(l => { if (l.cb === cb && l.client === self) l.removed = true; });
                        self.connListeners.forEach(l => { if (l.cb === cb) l.removed = true; });
                    },
                    onDisconnect() {
                        return {
                            set: v => { self.disconnectOps.push({ path, value: v }); return Promise.resolve(); },
                            cancel: () => { self.disconnectOps = self.disconnectOps.filter(o => o.path !== path); return Promise.resolve(); }
                        };
                    }
                };
            }
        };
        const database = () => dbApi;
        database.ServerValue = ServerValue;

        const authApi = {
            get currentUser() { return self.user; },
            onAuthStateChanged(cb) {
                Promise.resolve().then(() => cb(self.user));
                return () => {};
            },
            signInAnonymously() {
                if (self.failSignIn) { const e = new Error("sign-in failed"); e.code = self.failSignIn; return Promise.reject(e); }
                self.user = { uid: self.uid };
                return Promise.resolve({ user: self.user });
            }
        };

        this.firebase = {
            apps: [],
            initializeApp() { this.apps.push({}); },
            auth: () => authApi,
            database
        };
    }

    // The tab is gone for good (no more events are delivered to it). Unlike disconnect(), this runs nothing on the server.
    dispose() {
        this.server.listeners.forEach(l => { if (l.client === this) l.removed = true; });
        this.connListeners.forEach(l => { l.removed = true; });
    }

    // The network drops (or the tab closes): the server runs the "on disconnect" writes it was given.
    disconnect() {
        if (!this.connected) return;
        this.connected = false;
        const ops = this.disconnectOps; this.disconnectOps = [];
        ops.forEach(o => { try { this.server.write(this.auth, "set", o.path, o.value); } catch (e) { /* ignored, like Firebase */ } });
        this.connListeners.forEach(l => { Promise.resolve().then(() => { if (!l.removed) l.cb({ val: () => false }); }); });
    }
    reconnect() {
        if (this.connected) return;
        this.connected = true;
        this.connListeners.forEach(l => { Promise.resolve().then(() => { if (!l.removed) l.cb({ val: () => true }); }); });
    }
}

const tick = (ms) => new Promise(r => setTimeout(r, ms || 0));
module.exports = { FakeServer, FakeBrowser, toFirebase, tick };
