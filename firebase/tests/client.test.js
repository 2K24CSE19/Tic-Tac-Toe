/*
 * End-to-end tests of MultiplayerClient.js: two fake browsers talk to a fake Firebase server that enforces the REAL
 * security rules. Run:  cd firebase && npm run test:client
 */
const { FakeServer, tick } = require("./fake-firebase");
const Core = require("../../MultiplayerCore.js");
global.MultiplayerCore = Core;
const Online = require("../../MultiplayerClient.js");
const Bot = require("../../Bot.js");
const E = Bot.ultimate._engine;

const CONFIG = { apiKey: "test-key", databaseURL: "https://example.firebaseio.com", projectId: "t" };
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) { if (cond) pass++; else { fail++; failures.push(name + (extra ? "  -> " + extra : "")); } }
async function rejects(name, fn, code) {
    try { await fn(); fail++; failures.push(name + ": expected an error, but it succeeded"); }
    catch (e) { ok(name + " (error code " + code + ")", e.code === code, "got " + e.code + ": " + e.message); }
}
const settle = async () => { for (let i = 0; i < 8; i++) await tick(0); };
function memStorage() { const m = {}; return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } }; }

// A "person at a browser": fake browser + client + the last things the room told them
function person(server, uid, bopts, copts, storage) {
    const b = server.browser(uid, bopts);
    const st = storage || memStorage();
    const c = Online.createClient(b.firebase, CONFIG, Object.assign({ storage: st, now: () => server.now() }, copts));
    const p = { b, c, storage: st, room: null, info: null, connected: [], gone: 0, errors: [] };
    p.attach = (code, _unused, aopts) => c.attach(code, {
        onRoom: (room, info) => { p.room = room; p.info = info; },
        onConnection: v => p.connected.push(v),
        onGone: () => { p.gone++; },
        onError: e => p.errors.push(e)
    }, aopts);
    return p;
}
const phase = (p, server) => Core.roomPhase(p.c.currentRoom(), server.now());

(async () => {
    /* ---- sign-in and set-up errors ---- */
    {
        const s = new FakeServer();
        const bad = person(s, "u1", { failSignIn: "auth/operation-not-allowed" });
        await rejects("guest sign-in switched off", () => bad.c.ready(), "auth-disabled");
        bad.b.failSignIn = null;
        ok("sign-in works on retry", (await bad.c.ready()) === "u1");

        const noCfg = Online.createClient(s.browser("u2").firebase, {}, { storage: memStorage() });
        await rejects("missing config", () => noCfg.ready(), "no-config");
    }

    /* ---- create, join, errors ---- */
    const server = new FakeServer();
    const host = person(server, "host-uid");
    const guest = person(server, "guest-uid");

    const code = await host.c.createRoom("ultimate");
    ok("room code is valid", Core.isValidRoomCode(code), code);
    ok("room exists on the server", server.value("rooms/" + code).host === "host-uid");
    ok("host remembers the room", host.c.getSavedRoom().code === code && host.c.getSavedRoom().game === "ultimate");
    await host.attach(code); await settle();
    ok("host is seat X", host.c.currentSeat() === "X");
    ok("host presence is online", server.value("rooms/" + code + "/presence/X").online === true);
    ok("phase is 'waiting' before the guest joins", phase(host, server) === "waiting");

    await rejects("join with a malformed code", () => guest.c.joinRoom("12"), "bad-code");
    await rejects("join a room that doesn't exist", () => guest.c.joinRoom("AAAAAA"), "not-found");
    await rejects("join with the wrong game page", () => guest.c.joinRoom(code, { expectGame: "basic" }), "wrong-game");
    const j = await guest.c.joinRoom(" " + code.toLowerCase().slice(0, 3) + "-" + code.slice(3) + " ", { expectGame: "ultimate" });   // typed sloppily
    ok("guest joins (sloppy typing accepted)", j.seat === "O" && j.code === code && !j.rejoined);
    await guest.attach(code); await settle();
    ok("both players see 'playing'", phase(host, server) === "playing" && phase(guest, server) === "playing");

    const eve = person(server, "eve-uid");
    await rejects("third person cannot take a seat", () => eve.c.joinRoom(code), "full");
    await eve.attach(code); await settle();
    ok("a third browser can only watch (no seat)", eve.c.currentSeat() === null && eve.room.state.moves === 0);
    await rejects("a watcher cannot move", () => eve.c.sendMove(4, 4), "illegal");
    eve.c.detach();

    const hostAgain = person(server, "host-uid", { restored: true });
    ok("host reopening the room is recognised as host", (await hostAgain.c.joinRoom(code)).rejoined === true);

    /* ---- a whole Ultimate game through the clients ---- */
    const empty = { cells: Array.from({ length: 9 }, () => Array(9).fill("")), meta: Array(9).fill(""), next: null, player: "X" };
    const eng = E.fromSnapshot(empty);
    const people = { X: host, O: guest };
    await rejects("moving out of turn is refused", () => guest.c.sendMove(4, 4), "illegal");
    let n = 0, midGame = null;
    while (!eng.over) {
        const legal = E.legalMoves(eng);
        const idx = legal[Math.floor(Math.random() * legal.length)];
        const b = (idx / 9) | 0, c = idx % 9;
        const seat = eng.player === 1 ? "X" : "O";
        if (n === 0) {
            await rejects("wrong board is refused", async () => { await people[seat].c.sendMove(0, 0); await people[seat].c.sendMove(5, 5); }, "illegal");
            // (the first call above succeeded as a legit first move only if it was legal; reset by replaying below)
        }
        if (n === 0 && server.value("rooms/" + code).state.moves === 1) {
            // the harmless first call actually played (0,0): mirror it in the engine and continue
            E.makeMove(eng, 0); n++; await settle(); continue;
        }
        await people[seat].c.sendMove(b, c);
        E.makeMove(eng, idx); n++;
        await settle();
        if (n === 6) midGame = JSON.stringify(server.value("rooms/" + code));
    }
    await settle();
    const want = eng.winner === 3 ? "draw" : (eng.winner === 1 ? "X" : "O");
    ok("game finished with the engine's winner (" + want + ", " + n + " moves)", host.room.state.winner === want && guest.room.state.winner === want, host.room.state.winner);
    ok("both screens agree", JSON.stringify(host.room) === JSON.stringify(guest.room));
    await rejects("no moves after the game", () => people[host.room.state.turn].c.sendMove(0, 0), "illegal");

    /* ---- refresh recovery + the pause ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("ultimate");
        await h.attach(cd);
        await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await h.c.sendMove(4, 4); await settle();
        await g.c.sendMove(4, 0); await settle();
        await h.c.sendMove(0, 0); await settle();
        const before = JSON.stringify(s.value("rooms/" + cd).cells);

        s.advance(5000);
        g.b.disconnect(); await settle();                          // the guest's tab closes
        ok("guest's seat is marked offline by the server", s.value("rooms/" + cd + "/presence/O").online === false && s.value("rooms/" + cd + "/presence/O").at === s.now());
        ok("host sees the guest is away", Core.roomPhase(h.room, s.now()) === "guest-away");
        await rejects("host can't move while the guest is away (client check)", () => h.c.sendMove(0, 4), "illegal");
        let serverRefused = false;
        try { await h.b.firebase.database().ref("rooms/" + cd).update(Core.buildMoveUpdate(Object.assign({}, h.room, { presence: { X: { online: true }, O: { online: true } } }), 0, 4)); }
        catch (e) { serverRefused = e.code === "PERMISSION_DENIED"; }
        ok("...and the server refuses it too", serverRefused);

        // the page is refreshed: same browser identity, nothing in memory but the saved room code
        s.advance(20000);
        const g2 = person(s, "guest-uid", { restored: true }, null, g.storage);
        const saved = g2.c.getSavedRoom();
        ok("the saved room survives the refresh", saved && saved.code === cd);
        const back = await g2.c.joinRoom(saved.code);
        ok("refresh gives the same seat back", back.rejoined === true && back.seat === "O");
        await g2.attach(saved.code); await settle();
        ok("progress was kept", JSON.stringify(s.value("rooms/" + cd).cells) === before && g2.room.state.moves === 3);
        ok("guest is online again and the host sees the game resume", s.value("rooms/" + cd + "/presence/O").online === true && Core.roomPhase(h.room, s.now()) === "playing");
        await g2.c.sendMove(0, 4); await settle();
        ok("play continues after the refresh", s.value("rooms/" + cd).state.moves === 4);

        /* ---- the 120 second grace period ---- */
        const t0 = s.now();
        g2.b.disconnect(); await settle();
        await rejects("forfeit claim right away", () => h.c.claimForfeit(), "too-early");
        s.advance(119999);
        await rejects("forfeit claim 1 ms early", () => h.c.claimForfeit(), "too-early");
        ok("countdown shows the time left", Core.seatStatus(h.room, "O", s.now()).graceLeftMs === 1);
        s.advance(1);
        ok("host may claim at exactly 120 s", Core.canClaimForfeit(h.room, "X", s.now()));
        await h.c.claimForfeit(); await settle();
        ok("forfeit recorded: host wins", h.room.state.winner === "X" && h.room.state.reason === "forfeit" && Core.roomToGame(h.room).reason === "forfeit");
        await rejects("no moves after a forfeit", () => h.c.sendMove(0, 0), "illegal");
    }

    /* ---- guest returns just before the deadline ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("basic");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        g.b.disconnect(); await settle();
        s.advance(119000);
        g.b.reconnect(); await settle();                          // same page, the network came back
        ok("reconnecting re-announces presence automatically", s.value("rooms/" + cd + "/presence/O").online === true);
        s.advance(10000);
        await rejects("no forfeit once the guest is back", () => h.c.claimForfeit(), "too-early");
    }

    /* ---- the host drops briefly: the game waits, then resumes ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("ultimate");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await h.c.sendMove(4, 4); await settle();
        h.b.disconnect(); await settle();
        ok("guest sees the host is away", Core.roomPhase(g.room, s.now()) === "host-away");
        await rejects("guest can't move while host is away", () => g.c.sendMove(4, 0), "illegal");
        s.advance(60000);
        await rejects("guest can't claim a win before the 120 s are up", () => g.c.claimForfeit(), "too-early");
        h.b.reconnect(); await settle();
        ok("host coming back resumes the game", Core.roomPhase(g.room, s.now()) === "playing");
        await g.c.sendMove(4, 0); await settle();
        ok("guest can move again", s.value("rooms/" + cd).state.moves === 2);
    }

    /* ---- Basic game through the clients ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("basic");
        await h.attach(cd); await g.c.joinRoom(cd, { expectGame: "basic" }); await g.attach(cd); await settle();
        await rejects("Basic: board 1 does not exist", () => h.c.sendMove(1, 0), "illegal");
        for (const [who, cell] of [[h, 0], [g, 3], [h, 1], [g, 4], [h, 2]]) { await who.c.sendMove(0, cell); await settle(); }
        ok("Basic: X wins with the top row", h.room.state.winner === "X" && g.room.state.winner === "X");
    }

    /* ---- rematch ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("basic");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await rejects("no rematch while the game is on", () => h.c.startRematch(), "illegal");
        for (const [who, cell] of [[h, 0], [g, 3], [h, 1], [g, 4], [h, 2]]) { await who.c.sendMove(0, cell); await settle(); }
        ok("game over (X won)", h.room.state.winner === "X");

        const r = await g.c.startRematch(); await settle();                    // the LOSER asks
        ok("rematch: a new room is created and the old one points at it", r.created === true && r.code !== cd && s.value("rooms/" + cd).rematch === r.code);
        ok("rematch: opponent sees the pointer", h.room.rematch === r.code && Core.roomToGame(h.room).rematch === r.code);
        ok("rematch: new room belongs to whoever asked", s.value("rooms/" + r.code).host === "guest-uid");
        await g.attach(r.code); await settle();
        ok("rematch: asker is X in the new room and the old seat was released", g.c.currentSeat() === "X" && s.value("rooms/" + cd + "/presence/O").online === false);
        const again = await h.c.startRematch();
        ok("rematch: the other player is pointed at the same room", again.created === false && again.code === r.code);
        const jr = await h.c.joinRoom(again.code, { expectGame: "basic" });
        await h.attach(again.code); await settle();
        ok("rematch: opponent joins as O (sides swapped)", jr.seat === "O" && Core.roomPhase(g.room, s.now()) === "playing");
        await g.c.sendMove(0, 4); await settle(); await h.c.sendMove(0, 0); await settle();
        ok("rematch: fresh game plays on", s.value("rooms/" + r.code).state.moves === 2);
        ok("rematch: refresh would return to the NEW room", h.c.getSavedRoom().code === r.code && g.c.getSavedRoom().code === r.code);

        // both press Rematch at the same moment: one pointer wins, the other player joins it
        const s2 = new FakeServer();
        const h2 = person(s2, "host-uid"), g2 = person(s2, "guest-uid");
        const c2 = await h2.c.createRoom("basic");
        await h2.attach(c2); await g2.c.joinRoom(c2); await g2.attach(c2); await settle();
        for (const [who, cell] of [[h2, 0], [g2, 3], [h2, 1], [g2, 4], [h2, 2]]) { await who.c.sendMove(0, cell); await settle(); }
        const [ra, rb] = await Promise.all([h2.c.startRematch(), g2.c.startRematch()]);
        const created = [ra, rb].filter(x => x.created);
        ok("rematch race: exactly one new room wins", created.length === 1 && ra.code === rb.code, JSON.stringify([ra, rb]));
        const roomsAlive = Object.keys(s2.value("rooms") || {}).length;
        ok("rematch race: the loser's spare room was cleaned up (2 rooms left)", roomsAlive === 2, roomsAlive);
    }

    /* ---- the GUEST wins when the HOST abandons ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("ultimate");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await h.c.sendMove(4, 4); await settle(); await g.c.sendMove(4, 0); await settle();      // it is the HOST's turn now
        h.b.disconnect(); await settle();
        ok("host dropped on their own turn: guest sees host-away", Core.roomPhase(g.room, s.now()) === "host-away");
        s.advance(119999);
        await rejects("guest can't claim 1 ms early", () => g.c.claimForfeit(), "too-early");
        s.advance(1);
        ok("guest may claim at 120 s", Core.canClaimForfeit(g.room, "O", s.now()) && !Core.canClaimForfeit(g.room, "X", s.now()));
        await g.c.claimForfeit(); await settle();
        ok("guest wins by abandonment", g.room.state.winner === "O" && g.room.state.reason === "forfeit");
        h.b.reconnect(); await settle();
        ok("the returning host sees the result unchanged", h.room.state.winner === "O");
        await rejects("no second result", () => g.c.claimForfeit(), "too-early");
    }

    /* ---- both drop: nobody is awarded the win ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("basic");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        h.b.disconnect(); s.advance(3000); g.b.disconnect(); await settle();
        ok("both away is recognised", Core.roomPhase(h.room, s.now()) === "both-away" || Core.roomPhase(g.room, s.now()) === "both-away");
        s.advance(400000);
        g.b.reconnect(); await settle();                          // the guest comes back, the host does not
        ok("the returning player is NOT offered a win (they were away too)", !Core.canClaimForfeit(g.room, "O", s.now()));
        await rejects("...and the server would refuse it anyway", () => g.c.claimForfeit(), "too-early");
        ok("no result was recorded", !s.value("rooms/" + cd).state.winner);
        h.b.reconnect(); await settle();
        ok("when both are back the game just resumes", Core.roomPhase(g.room, s.now()) === "playing");
    }

    /* ---- spectators ---- */
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("ultimate");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await h.c.sendMove(4, 4); await settle();

        const w1 = person(s, "w1-uid"), w2 = person(s, "w2-uid"), w3 = person(s, "w3-uid"), w4 = person(s, "w4-uid");
        const r1 = await w1.c.spectateRoom(cd, { expectGame: "ultimate" });
        ok("a watcher gets a slot and no seat", r1.role === "spectator" && r1.slot === "s1" && Core.seatOf(s.value("rooms/" + cd), "w1-uid") === null);
        await w1.attach(cd, {}, { role: "spectator" }); await settle();
        ok("the watcher sees the live board", w1.room.cells[4][4] === "X" && w1.c.currentRole() === "spectator" && w1.c.currentSeat() === null);
        ok("watcher is online in their slot", s.value("rooms/" + cd + "/spectators/s1").online === true);
        await rejects("watcher can't move", () => w1.c.sendMove(4, 0), "illegal");
        await rejects("watcher can't claim a win", () => w1.c.claimForfeit(), "illegal");
        await rejects("watcher can't start a rematch", () => w1.c.startRematch(), "illegal");
        let moveDenied = false;
        try { await w1.b.firebase.database().ref("rooms/" + cd).update(Core.buildMoveUpdate(Object.assign({}, w1.room, { state: Object.assign({}, w1.room.state, { turn: "O" }) }), 4, 0)); } catch (e) { moveDenied = e.code === "PERMISSION_DENIED"; }
        ok("...and the server refuses a forced move from a watcher", moveDenied);

        await w2.c.spectateRoom(cd); await w2.attach(cd, {}, { role: "spectator" });
        await w3.c.spectateRoom(cd); await w3.attach(cd, {}, { role: "spectator" }); await settle();
        ok("three watchers connected: players see Spectators 3/3", Core.spectatorCount(h.room) === 3 && Core.spectatorCount(w2.room) === 3);
        await rejects("a 4th watcher is refused", () => w4.c.spectateRoom(cd), "spectators-full");
        ok("a watcher didn't pause the game or start any timer", Core.roomPhase(h.room, s.now()) === "playing");

        // simultaneous joins for the last slots
        const s2 = new FakeServer();
        const h2 = person(s2, "host-uid"); const c2 = await h2.c.createRoom("basic"); await h2.attach(c2);
        const racers = ["a", "b", "c", "d", "e", "f"].map(n => person(s2, n + "-uid"));
        const results = await Promise.all(racers.map(r => r.c.spectateRoom(c2).then(() => "in", e => e.code)));
        ok("6 simultaneous watchers: exactly 3 get in, 3 are refused", results.filter(x => x === "in").length === 3 && results.filter(x => x === "spectators-full").length === 3, JSON.stringify(results));
        const slots = ["s1", "s2", "s3"].map(k => s2.value("rooms/" + c2 + "/spectators/" + k).uid);
        ok("each of the 3 slots has a different owner", new Set(slots).size === 3);

        // a watcher refreshes: same slot, no duplicate
        const saved = w2.storage;
        ok("the saved room remembers the watcher role", w2.c.getSavedRoom().role === "spectator");
        w2.b.disconnect(); await settle();
        ok("a dropped watcher is marked offline (count goes down)", s.value("rooms/" + cd + "/spectators/s2").online === false && Core.spectatorCount(h.room) === 2);
        const w2b = person(s, "w2-uid", { restored: true }, null, saved);
        const again = await w2b.c.spectateRoom(w2b.c.getSavedRoom().code);
        ok("refreshing returns the SAME slot", again.slot === r1.slot.replace("s1", "s2"), again.slot);
        await w2b.attach(cd, {}, { role: "spectator" }); await settle();
        ok("...and doesn't use up a 4th slot", Core.spectatorCount(h.room) === 3 && Object.keys(s.value("rooms/" + cd).spectators).length === 3);

        // leaving frees the slot at once
        await w1.c.leave(); await settle();
        ok("leaving frees the slot", !s.value("rooms/" + cd).spectators.s1 && Core.spectatorCount(h.room) === 2);
        const r4 = await w4.c.spectateRoom(cd);
        ok("another watcher can take the freed slot", r4.slot === "s1");

        // an abandoned (offline, stale) slot is recycled
        w3.b.disconnect(); await settle();
        const w5 = person(s, "w5-uid");
        await rejects("an offline watcher's slot is still reserved for 30 s", () => w5.c.spectateRoom(cd), "spectators-full");
        s.advance(31000);
        const r5 = await w5.c.spectateRoom(cd);
        ok("after 30 s it is recycled", r5.slot === "s3", r5.slot);

        // players follow their own rules even if they open the watch link
        const p = await h.c.spectateRoom(cd);
        ok("a player who 'spectates' their own room just rejoins as a player", p.role === "player" && p.seat === "X");
        // a full room's error points at spectating
        const late = person(s, "late-uid");
        try { await late.c.joinRoom(cd); ok("joining a full room is refused", false); } catch (e) { ok("joining a full room is refused and offers spectating", e.code === "full" && e.canSpectate === true); }
    }

    /* ---- code collisions, leaving, deleting ---- */
    {
        const s = new FakeServer();
        const a = person(s, "a-uid", {}, { randomBytes: () => [0, 0, 0, 0, 0, 0] });
        const first = await a.c.createRoom("basic");
        ok("first room gets the code AAAAAA", first === "AAAAAA");
        let calls = 0;
        const b = person(s, "b-uid", {}, { randomBytes: () => (calls++ === 0 ? [0, 0, 0, 0, 0, 0] : [1, 1, 1, 1, 1, 1]) });
        const second = await b.c.createRoom("basic");
        ok("a taken code is skipped and another one used", second === "BBBBBB" && calls === 2, second);
        ok("the first room was not overwritten", s.value("rooms/AAAAAA").host === "a-uid");

        const g = person(s, "g-uid");
        await b.attach(second); await g.c.joinRoom(second); await g.attach(second); await settle();
        await g.c.leave(); await settle();
        ok("leaving forgets the room", g.c.getSavedRoom() === null);
        ok("leaving marks the seat offline", s.value("rooms/" + second + "/presence/O").online === false);
        await b.c.leave({ deleteRoom: true }); await settle();
        ok("host can delete the room", s.value("rooms/" + second) === null);
    }
    {
        const s = new FakeServer();
        const h = person(s, "host-uid"), g = person(s, "guest-uid");
        const cd = await h.c.createRoom("basic");
        await h.attach(cd); await g.c.joinRoom(cd); await g.attach(cd); await settle();
        await h.c.leave({ deleteRoom: true }); await settle();
        ok("the other player is told the room is gone", g.gone === 1);
    }

    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
