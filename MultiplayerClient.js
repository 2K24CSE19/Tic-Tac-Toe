/*
 * Online multiplayer: the Firebase connection.
 *
 *   const client = TTTOnline.createClient(firebase, config);
 *   await client.ready();                       // anonymous sign-in (no account needed)
 *   const code = await client.createRoom("ultimate");
 *   const info = await client.joinRoom("ABC123", { expectGame: "ultimate" });
 *   await client.attach(code, { onRoom, onConnection, onGone, onError });   // live updates + presence
 *   await client.sendMove(board, cell);   await client.claimForfeit();   await client.leave();
 *
 * The Firebase SDK is loaded only when the player opens Online mode (TTTOnline.loadSdk), so the offline modes
 * never depend on it. All game rules are in MultiplayerCore.js and are enforced again by the server rules.
 */
(function (root) {
    "use strict";

    const Core = root.MultiplayerCore || (typeof require !== "undefined" ? require("./MultiplayerCore.js") : null);

    const SDK_VERSION = "10.12.2";
    const SDK_FILES = ["firebase-app-compat.js", "firebase-auth-compat.js", "firebase-database-compat.js"];
    const SAVED_KEY = "ttt-online-room";

    class OnlineError extends Error {
        constructor(code, message) {
            super(message);
            this.name = "OnlineError";
            this.code = code;
        }
    }

    /* ---------------- loading the Firebase SDK on demand ---------------- */

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            const s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = function () { reject(new OnlineError("sdk-load", "Couldn't load the online service. Check your internet connection.")); };
            document.head.appendChild(s);
        });
    }

    async function loadSdk() {
        if (root.firebase && root.firebase.database && root.firebase.auth) return root.firebase;
        for (const file of SDK_FILES) {                                  // in order: app first
            await loadScript("https://www.gstatic.com/firebasejs/" + SDK_VERSION + "/" + file);
        }
        return root.firebase;
    }

    /* ---------------- helpers ---------------- */

    function safeStorage() {
        try {
            const s = root.localStorage;
            s.getItem("x");
            return s;
        } catch (e) {
            return null;
        }
    }

    function isPermissionDenied(e) {
        return !!e && (e.code === "PERMISSION_DENIED" || /permission[_ ]denied/i.test(String(e.message || "")));
    }

    function friendly(e) {
        if (e instanceof OnlineError) return e;
        const code = e && e.code ? String(e.code) : "";
        if (code === "auth/operation-not-allowed" || code === "auth/admin-restricted-operation") {
            return new OnlineError("auth-disabled", "Guest sign-in is switched off in Firebase. Enable Authentication > Anonymous.");
        }
        if (code === "auth/network-request-failed") return new OnlineError("offline", "No internet connection.");
        if (isPermissionDenied(e)) return new OnlineError("denied", "The server refused that. Check that the database rules are published.");
        return new OnlineError("unknown", (e && e.message) ? e.message : "Something went wrong.");
    }

    /* ---------------- the client ---------------- */

    function createClient(firebase, config, opts) {
        opts = opts || {};
        const storage = opts.storage !== undefined ? opts.storage : safeStorage();
        const clock = opts.now || function () { return Date.now(); };
        const randomBytes = opts.randomBytes;                           // for tests; default = crypto

        let db = null;
        let uid = null;
        let offset = 0;
        let readyPromise = null;
        let current = null;                                             // the room we are attached to

        const SV = function () { return firebase.database.ServerValue.TIMESTAMP; };

        /* ---- sign in ---- */

        function ready() {
            if (readyPromise) return readyPromise;
            readyPromise = (async function () {
                if (!config || !config.apiKey || /YOUR/i.test(config.apiKey) || !config.databaseURL) {
                    throw new OnlineError("no-config", "Online play isn't set up yet (firebase-config.js is missing your settings).");
                }
                if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(config);
                const auth = firebase.auth();
                db = firebase.database();

                // Wait for Firebase to restore the saved guest identity; if there is none, sign in as a new guest.
                const user = await new Promise(function (resolve, reject) {
                    let done = false;
                    const unsub = auth.onAuthStateChanged(async function (u) {
                        if (done) return;
                        if (u) { done = true; if (unsub) unsub(); resolve(u); return; }
                        try {
                            const cred = await auth.signInAnonymously();
                            done = true;
                            if (unsub) unsub();
                            resolve(cred.user);
                        } catch (e) { done = true; reject(e); }
                    }, function (e) { if (!done) { done = true; reject(e); } });
                });
                uid = user.uid;
                db.ref(".info/serverTimeOffset").on("value", function (s) { offset = s.val() || 0; });
                return uid;
            })().catch(function (e) {
                readyPromise = null;                                    // allow a retry
                throw friendly(e);
            });
            return readyPromise;
        }

        function serverNow() { return clock() + offset; }

        /* ---- remembering the room (so a refresh brings you back) ---- */

        function remember(code, game, role) {
            if (!storage) return;
            try { storage.setItem(SAVED_KEY, JSON.stringify({ code: code, game: game, role: role === "spectator" ? "spectator" : "player" })); } catch (e) { /* ignore */ }
        }
        function forget() {
            if (!storage) return;
            try { storage.removeItem(SAVED_KEY); } catch (e) { /* ignore */ }
        }
        function getSavedRoom() {
            if (!storage) return null;
            try {
                const v = JSON.parse(storage.getItem(SAVED_KEY));
                return (v && Core.isValidRoomCode(v.code)) ? v : null;
            } catch (e) { return null; }
        }

        /* ---- create / join ---- */

        async function createRoom(game) {
            await ready();
            if (game !== "basic" && game !== "ultimate") throw new OnlineError("bad-game", "Unknown game type.");
            for (let attempt = 0; attempt < 5; attempt++) {
                const code = Core.generateRoomCode(randomBytes);
                try {
                    await db.ref("rooms/" + code).set(Core.newRoom(game, uid, SV()));
                    remember(code, game);
                    return code;
                } catch (e) {
                    if (!isPermissionDenied(e)) throw friendly(e);      // a taken code is refused: try another
                }
            }
            throw new OnlineError("denied", "Couldn't create a room. Check that the database rules are published.");
        }

        async function joinRoom(rawCode, jopts) {
            jopts = jopts || {};
            const code = Core.normalizeRoomCode(rawCode);
            if (!Core.isValidRoomCode(code)) throw new OnlineError("bad-code", "Room codes have 6 letters or numbers.");
            await ready();

            let room;
            try { room = (await db.ref("rooms/" + code).once("value")).val(); } catch (e) { throw friendly(e); }
            if (!room) throw new OnlineError("not-found", "No room with that code. Check it and try again.");

            if (jopts.expectGame && room.game !== jopts.expectGame) {
                const err = new OnlineError("wrong-game", "That room is a " + (room.game === "ultimate" ? "Ultimate" : "Basic") + " game.");
                err.game = room.game;
                throw err;
            }

            const seat = Core.seatOf(room, uid);
            if (seat) { remember(code, room.game); return { code: code, seat: seat, game: room.game, rejoined: true }; }

            if ((room.players && room.players.O) || (room.state && (room.state.moves > 0 || room.state.winner))) {
                const full = new OnlineError("full", "That room is already full.");
                full.canSpectate = true;                               // the screen can offer "Spectate" instead
                throw full;
            }
            try {
                await db.ref("rooms/" + code).update(Core.joinUpdate(uid, SV()));
            } catch (e) {
                if (isPermissionDenied(e)) {                           // someone else may have just taken the seat
                    const again = (await db.ref("rooms/" + code).once("value")).val();
                    if (again && again.players && again.players.O && again.players.O !== uid) throw new OnlineError("full", "That room is already full.");
                }
                throw friendly(e);
            }
            remember(code, room.game);
            return { code: code, seat: "O", game: room.game, rejoined: false };
        }

        /* ---- spectators ---- */

        // Claim one of the 3 watcher slots. Each slot is claimed by writing to it and the server rules refuse a write to
        // an occupied slot, so two people racing for the last slot can't both get it.
        async function acquireSpectatorSlot(code, room) {
            let view = room;
            for (let attempt = 0; attempt < 3; attempt++) {
                const candidates = Core.spectatorSlotCandidates(view, uid, serverNow());
                for (const k of candidates) {
                    try {
                        await db.ref("rooms/" + code + "/spectators/" + k).set({ uid: uid, online: true, at: SV() });
                        return k;
                    } catch (e) {
                        if (!isPermissionDenied(e)) throw friendly(e);       // taken by someone else a moment ago: try the next
                    }
                }
                try { view = (await db.ref("rooms/" + code).once("value")).val() || {}; } catch (e) { throw friendly(e); }
                if (!Core.spectatorSlotCandidates(view, uid, serverNow()).length) break;
            }
            throw new OnlineError("spectators-full", "This match already has 3 spectators.");
        }

        async function spectateRoom(rawCode, sopts) {
            sopts = sopts || {};
            const code = Core.normalizeRoomCode(rawCode);
            if (!Core.isValidRoomCode(code)) throw new OnlineError("bad-code", "Room codes have 6 letters or numbers.");
            await ready();

            let room;
            try { room = (await db.ref("rooms/" + code).once("value")).val(); } catch (e) { throw friendly(e); }
            if (!room) throw new OnlineError("not-found", "No room with that code. Check it and try again.");
            if (sopts.expectGame && room.game !== sopts.expectGame) {
                const err = new OnlineError("wrong-game", "That room is a " + (room.game === "ultimate" ? "Ultimate" : "Basic") + " game.");
                err.game = room.game;
                throw err;
            }
            const seat = Core.seatOf(room, uid);
            if (seat) { remember(code, room.game, "player"); return { code: code, role: "player", seat: seat, game: room.game }; }

            const slot = await acquireSpectatorSlot(code, room);
            remember(code, room.game, "spectator");
            return { code: code, role: "spectator", slot: slot, game: room.game };
        }

        /* ---- live room ---- */

        function detach() {
            if (!current) return;
            current.refs.forEach(function (r) { try { r.ref.off("value", r.cb); } catch (e) { /* ignore */ } });
            current = null;
        }

        // Stop listening to the room we are in and mark our seat offline (used when moving to another room).
        async function releaseCurrent() {
            const cur = current;
            detach();
            if (cur && !cur.seat && cur.slot && db) {
                const sRef = db.ref("rooms/" + cur.code + "/spectators/" + cur.slot);
                try { await sRef.onDisconnect().cancel(); await sRef.remove(); } catch (e) { /* best effort */ }
                return;
            }
            if (!cur || !cur.seat || !db) return;
            const pRef = db.ref("rooms/" + cur.code + "/presence/" + cur.seat);
            try {
                await pRef.onDisconnect().cancel();
                await pRef.set({ online: false, at: SV() });
            } catch (e) { /* best effort */ }
        }

        async function attach(code, handlers, aopts) {
            await ready();
            if (current && current.code !== code) await releaseCurrent(); else detach();
            handlers = handlers || {};
            const cur = { code: code, seat: null, slot: null, wantSpectator: !!(aopts && aopts.role === "spectator"),
                room: null, refs: [], announcedFor: null, connected: true, acquiring: false };
            current = cur;

            function announcePresence() {
                if (current !== cur || !cur.connected) return;
                let ref, offline, online;
                if (cur.seat) {
                    ref = db.ref("rooms/" + code + "/presence/" + cur.seat);
                    offline = { online: false, at: SV() };
                    online = { online: true, at: SV() };
                    cur.announcedFor = "seat:" + cur.seat;
                } else if (cur.slot) {
                    ref = db.ref("rooms/" + code + "/spectators/" + cur.slot);
                    offline = { uid: uid, online: false, at: SV() };
                    online = { uid: uid, online: true, at: SV() };
                    cur.announcedFor = "slot:" + cur.slot;
                } else return;
                // Register "mark me offline if I drop" BEFORE announcing "I'm online".
                ref.onDisconnect().set(offline)
                    .then(function () { return ref.set(online); })
                    .catch(function (e) { if (handlers.onError) handlers.onError(friendly(e)); });
            }

            const roomRef = db.ref("rooms/" + code);
            const roomCb = function (snap) {
                if (current !== cur) return;
                const room = snap.val();
                cur.room = room;
                if (!room) { if (handlers.onGone) handlers.onGone(); return; }
                cur.seat = Core.seatOf(room, uid);
                if (!cur.seat && cur.wantSpectator) {
                    cur.slot = Core.spectatorSlotOf(room, uid);
                    if (!cur.slot && !cur.acquiring) {                 // our slot was taken over while we were away: get a new one
                        cur.acquiring = true;
                        acquireSpectatorSlot(code, room).then(function (k) { cur.slot = k; cur.acquiring = false; announcePresence(); })
                            .catch(function (e) { cur.acquiring = false; if (handlers.onError) handlers.onError(friendly(e)); });
                    }
                }
                const key = cur.seat ? "seat:" + cur.seat : (cur.slot ? "slot:" + cur.slot : null);
                if (key && cur.announcedFor !== key) announcePresence();
                if (handlers.onRoom) {
                    handlers.onRoom(room, {
                        seat: cur.seat, role: cur.seat || (cur.wantSpectator ? "spectator" : null), slot: cur.slot,
                        phase: Core.roomPhase(room, serverNow()), serverNow: serverNow()
                    });
                }
            };
            roomRef.on("value", roomCb, function (e) { if (handlers.onError) handlers.onError(friendly(e)); });
            cur.refs.push({ ref: roomRef, cb: roomCb });

            const connRef = db.ref(".info/connected");
            const connCb = function (snap) {
                if (current !== cur) return;
                cur.connected = snap.val() === true;
                if (handlers.onConnection) handlers.onConnection(cur.connected);
                if (cur.connected) announcePresence();                 // every (re)connection: say "I'm here" again
            };
            connRef.on("value", connCb);
            cur.refs.push({ ref: connRef, cb: connCb });
        }

        /* ---- playing ---- */

        async function sendMove(b, c) {
            if (!current || !current.room) throw new OnlineError("no-room", "You're not in a room.");
            const reason = Core.moveError(current.room, b, c, current.seat);
            if (reason) throw new OnlineError("illegal", reason);
            try {
                await db.ref("rooms/" + current.code).update(Core.buildMoveUpdate(current.room, b, c));
            } catch (e) {
                throw friendly(e);
            }
        }

        async function claimForfeit() {
            if (!current || !current.room) throw new OnlineError("no-room", "You're not in a room.");
            if (!current.seat) throw new OnlineError("illegal", "Spectators can't claim a win.");
            if (!Core.canClaimForfeit(current.room, current.seat, serverNow())) throw new OnlineError("too-early", "The 120 seconds aren't up yet.");
            try {
                await db.ref("rooms/" + current.code).update(Core.buildForfeitUpdate(current.room, current.seat));
            } catch (e) {
                if (isPermissionDenied(e)) throw new OnlineError("too-early", "The 120 seconds aren't up yet.");
                throw friendly(e);
            }
        }

        // After a game: make a fresh room and point the finished one at it. Returns { code, created }.
        // created === false means the opponent had already asked for a rematch, so join THEIR room instead.
        async function startRematch() {
            const cur = current;
            if (!cur || !cur.room) throw new OnlineError("no-room", "You're not in a room.");
            if (!cur.seat) throw new OnlineError("illegal", "Spectators can't start a rematch.");
            if (!cur.room.state || !cur.room.state.winner) throw new OnlineError("illegal", "The game isn't over yet.");
            if (cur.room.rematch) return { code: cur.room.rematch, created: false };

            const game = cur.room.game;
            const oldCode = cur.code;
            const newCode = await createRoom(game);                    // (this also remembers the new room)
            try {
                await db.ref("rooms/" + oldCode + "/rematch").set(newCode);
            } catch (e) {
                try { await db.ref("rooms/" + newCode).remove(); } catch (e2) { /* ignore */ }
                remember(oldCode, game);
                if (!isPermissionDenied(e)) throw friendly(e);
                let again = null;                                       // we lost the race: the opponent asked first
                try { again = (await db.ref("rooms/" + oldCode + "/rematch").once("value")).val(); } catch (e3) { /* ignore */ }
                if (again) return { code: again, created: false };
                throw new OnlineError("denied", "Couldn't start a rematch.");
            }
            return { code: newCode, created: true };
        }

        async function leave(lopts) {
            lopts = lopts || {};
            const cur = current;
            detach();
            forget();
            if (cur && !cur.seat && cur.slot && db) {                  // a watcher leaves: free the slot straight away
                const sRef = db.ref("rooms/" + cur.code + "/spectators/" + cur.slot);
                try { await sRef.onDisconnect().cancel(); await sRef.remove(); } catch (e) { /* best effort */ }
                return;
            }
            if (!cur || !cur.seat || !db) return;
            const pRef = db.ref("rooms/" + cur.code + "/presence/" + cur.seat);
            try {
                if (lopts.deleteRoom && cur.seat === "X") {
                    await db.ref("rooms/" + cur.code).remove();
                } else {
                    await pRef.set({ online: false, at: SV() });
                }
            } catch (e) { /* best effort */ }
        }

        // "I'm leaving this page" (Home button): mark my seat offline RIGHT NOW so the opponent's countdown starts at once,
        // but keep the saved room so coming back resumes the match. (Closing a tab does the same thing, a few seconds later.)
        async function markAway() {
            const cur = current;
            if (!cur || !db) return;
            if (!cur.seat && cur.slot) { await leave(); return; }       // watchers just free their slot
            if (!cur.seat) return;
            try {
                await Promise.race([
                    db.ref("rooms/" + cur.code + "/presence/" + cur.seat).set({ online: false, at: SV() }),
                    new Promise(function (resolve) { setTimeout(resolve, 1500); })
                ]);
            } catch (e) { /* best effort: onDisconnect will still fire when the page closes */ }
        }

        return {
            ready: ready,
            uid: function () { return uid; },
            serverNow: serverNow,
            createRoom: createRoom,
            joinRoom: joinRoom,
            spectateRoom: spectateRoom,
            attach: attach,
            detach: detach,
            sendMove: sendMove,
            claimForfeit: claimForfeit,
            startRematch: startRematch,
            leave: leave,
            markAway: markAway,
            getSavedRoom: getSavedRoom,
            forget: forget,
            currentRoom: function () { return current ? current.room : null; },
            currentCode: function () { return current ? current.code : null; },
            currentSeat: function () { return current ? current.seat : null; },
            currentRole: function () { return current ? (current.seat || (current.wantSpectator ? "spectator" : null)) : null; }
        };
    }

    const api = { createClient: createClient, loadSdk: loadSdk, OnlineError: OnlineError, SDK_VERSION: SDK_VERSION };
    root.TTTOnline = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
