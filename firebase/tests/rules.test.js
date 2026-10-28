/*
 * Tests for firebase/database.rules.json, run with the "targaryen" rules simulator:
 *
 *     cd firebase && npm install && npm test
 *
 * 1. Honest play: complete random games are replayed through the rules. Every legal move must be ACCEPTED and
 *    the winner the rules accept must match the independent game engine in Bot.js.
 * 2. Cheating: wrong player, wrong cell, wrong board, faked results, early forfeit, spoofed presence... must all
 *    be REJECTED.
 *
 * (targaryen is a simulator of Firebase rules, not Firebase itself. Before launch, also try the rules in the
 *  Firebase console "Rules Playground", see SETUP.md.)
 */
const targaryen = require("targaryen");
const rules = require("../database.rules.json");
const Core = require("../../MultiplayerCore.js");
const Bot = require("../../Bot.js");
const E = Bot.ultimate._engine;

const T0 = 1700000000000;
const SV = { ".sv": "timestamp" };
const CODE = "ABCD23";
const ROOM = "/rooms/" + CODE;
const USERS = { host: { uid: "host-uid" }, guest: { uid: "guest-uid" }, eve: { uid: "eve-uid" }, none: null,
    sp1: { uid: "sp1-uid" }, sp2: { uid: "sp2-uid" }, sp3: { uid: "sp3-uid" }, sp4: { uid: "sp4-uid" } };

let db;
let pass = 0, fail = 0;
const failures = [];

function reset(data) { db = targaryen.database(rules, data || {}, T0); }
function who(u) {
    // (the simulator keeps the previous user's login on .as(null), so signed-out users start from a fresh copy of the data)
    if (USERS[u] === null) return targaryen.database(rules, db.snapshot("/").val() || {}, T0).as(null);
    return db.as(USERS[u]);
}
function update(u, path, patch, now) { return who(u).update(path, patch, { now: now || T0 }); }
function write(u, path, value, now) { return who(u).write(path, value, { now: now || T0 }); }
function commit(res) { if (res.allowed) db = res.newDatabase; return res; }
function room() { return db.snapshot(ROOM).val(); }

function expect(name, res, allowed) {
    if (res.allowed === allowed) { pass++; return; }
    fail++;
    failures.push(`${name}: expected ${allowed ? "ALLOWED" : "DENIED"} but was ${res.allowed ? "ALLOWED" : "DENIED"}\n      ${String(res.info || "").split("\n").slice(0, 2).join(" | ")}`);
}
const allowed = (name, res) => expect(name, res, true);
const denied = (name, res) => expect(name, res, false);

function newGame(game) {
    reset();
    allowed("create room", commit(write("host", ROOM, Core.newRoom(game, "host-uid", SV))));
    allowed("join room", commit(update("guest", ROOM, Core.joinUpdate("guest-uid", SV))));
}
const seatUser = seat => seat === "X" ? "host" : "guest";

function play(b, c, now) {         // the honest client move for whoever's turn it is
    const r = room();
    const seat = r.state.turn;
    return update(seatUser(seat), ROOM, Core.buildMoveUpdate(r, b, c), now);
}

// Load a hand-made position (used to reach end-of-game situations quickly)
function loadRoom(obj) {
    reset({ rooms: { [CODE]: obj } });
}
function baseRoom(game, state, cells, boards) {
    const r = {
        game, host: "host-uid", createdAt: T0,
        players: { X: "host-uid", O: "guest-uid" },
        presence: { X: { online: true, at: T0 }, O: { online: true, at: T0 } },
        state: Object.assign({ turn: "X", moves: 10, next: "any", xb: 0, ob: 0 }, state)
    };
    if (cells) r.cells = cells;
    if (boards) r.boards = boards;
    return r;
}

/* =====================================================================
 *  1. HONEST PLAY
 * =================================================================== */

function randomUltimateGame() {
    newGame("ultimate");
    const empty = { cells: Array.from({ length: 9 }, () => Array(9).fill("")), meta: Array(9).fill(""), next: null, player: "X" };
    const s = E.fromSnapshot(empty);
    let n = 0;
    while (!s.over) {
        const legal = E.legalMoves(s);
        const idx = legal[Math.floor(Math.random() * legal.length)];
        const b = (idx / 9) | 0, c = idx % 9;
        const seat = s.player === 1 ? "X" : "O";
        const r = room();

        // the client-side pre-check must agree with the engine about which moves are legal
        if (n % 7 === 0) {
            const mine = [];
            for (let i = 0; i < 81; i++) if (Core.moveError(r, (i / 9) | 0, i % 9, seat) === null) mine.push(i);
            if (JSON.stringify(mine) !== JSON.stringify([...legal].sort((a, b) => a - b))) {
                fail++; failures.push("moveError disagrees with the engine about legal moves"); return null;
            }
        }
        const res = update(seatUser(seat), ROOM, Core.buildMoveUpdate(r, b, c));
        if (!res.allowed) {
            fail++; failures.push(`honest ultimate move rejected (move ${n + 1}, board ${b}, cell ${c}): ${String(res.info).split("\n")[0]}`);
            return null;
        }
        commit(res);
        E.makeMove(s, idx);
        n++;
        const st = room().state;
        const expectNext = s.over ? null : (s.next < 0 ? "any" : String(s.next));
        if (!s.over && st.next !== expectNext) { fail++; failures.push("next board differs from the engine"); return null; }
    }
    const want = s.winner === 3 ? "draw" : (s.winner === 1 ? "X" : "O");
    const got = room().state.winner;
    if (got === want) pass++; else { fail++; failures.push(`winner ${got} but engine says ${want}`); }

    // game over: nothing more can be played
    const r = room();
    for (let i = 0; i < 81; i++) {
        if (!r.cells || !(r.cells[(i / 9) | 0] && r.cells[(i / 9) | 0][i % 9])) {
            denied("move after game over", update(seatUser(r.state.turn), ROOM, Core.buildMoveUpdate(Object.assign({}, r, { state: Object.assign({}, r.state, { winner: undefined }) }), (i / 9) | 0, i % 9)));
            break;
        }
    }
    return { moves: n, winner: got };
}

function randomBasicGame() {
    newGame("basic");
    const cells = Array(9).fill("");
    let n = 0;
    for (;;) {
        const free = cells.map((v, i) => v === "" ? i : -1).filter(i => i >= 0);
        const c = free[Math.floor(Math.random() * free.length)];
        const r = room();
        const seat = r.state.turn;
        const res = update(seatUser(seat), ROOM, Core.buildMoveUpdate(r, 0, c));
        if (!res.allowed) { fail++; failures.push(`honest basic move rejected: ${String(res.info).split("\n")[0]}`); return null; }
        commit(res);
        cells[c] = seat; n++;
        const w = Bot.basic.winner(cells);
        if (w || !cells.includes("")) {
            const want = w || "draw";
            const got = room().state.winner;
            if (got === want) pass++; else { fail++; failures.push(`basic winner ${got}, expected ${want}`); }
            return { moves: n, winner: got };
        }
        if (room().state.winner) { fail++; failures.push("basic winner announced too early"); return null; }
    }
}

const t0 = Date.now();
const outcomes = { ultimate: { X: 0, O: 0, draw: 0 }, basic: { X: 0, O: 0, draw: 0 } };
let moveCount = 0;
const ULT_GAMES = Number(process.env.ULT_GAMES || 40), BASIC_GAMES = Number(process.env.BASIC_GAMES || 40);
for (let i = 0; i < ULT_GAMES; i++) { const r = randomUltimateGame(); if (r) { outcomes.ultimate[r.winner]++; moveCount += r.moves; } }
for (let i = 0; i < BASIC_GAMES; i++) { const r = randomBasicGame(); if (r) { outcomes.basic[r.winner]++; moveCount += r.moves; } }
console.log(`Honest play: ${ULT_GAMES} Ultimate + ${BASIC_GAMES} Basic random games, ${moveCount} moves accepted (${Math.round((Date.now() - t0) / 1000)}s)`);
console.log("  results  Ultimate:", JSON.stringify(outcomes.ultimate), " Basic:", JSON.stringify(outcomes.basic));

/* =====================================================================
 *  2. ROOMS: create / join / read
 * =================================================================== */

reset();
denied("create room while signed out", write("none", ROOM, Core.newRoom("ultimate", "host-uid", SV)));
denied("create room with a bad code", write("host", "/rooms/abc", Core.newRoom("ultimate", "host-uid", SV)));
denied("create room with an I/O/0/1 code", write("host", "/rooms/ABCDO1", Core.newRoom("ultimate", "host-uid", SV)));
denied("create room naming someone else as host", write("host", ROOM, Core.newRoom("ultimate", "eve-uid", SV)));
denied("create room with unknown game", write("host", ROOM, Core.newRoom("chess", "host-uid", SV)));
denied("create room with a made-up creation time", write("host", ROOM, Object.assign(Core.newRoom("ultimate", "host-uid", SV), { createdAt: 5 })));
denied("create room already holding moves", write("host", ROOM, Object.assign(Core.newRoom("ultimate", "host-uid", SV), { cells: { 0: { 0: "X" } } })));
denied("create room with the guest seat pre-filled", write("host", ROOM, Object.assign(Core.newRoom("ultimate", "host-uid", SV), { players: { X: "host-uid", O: "eve-uid" } })));
denied("create room with the first move not X's", write("host", ROOM, (() => { const r = Core.newRoom("ultimate", "host-uid", SV); r.state.turn = "O"; return r; })()));
denied("create room with a head start on score", write("host", ROOM, (() => { const r = Core.newRoom("ultimate", "host-uid", SV); r.state.xb = 2; return r; })()));
denied("create room with extra junk field", write("host", ROOM, Object.assign(Core.newRoom("ultimate", "host-uid", SV), { cheat: true })));
allowed("create room (honest)", commit(write("host", ROOM, Core.newRoom("ultimate", "host-uid", SV))));
denied("overwrite an existing room", write("eve", ROOM, Core.newRoom("ultimate", "eve-uid", SV)));
denied("overwrite an existing room (as its host)", write("host", ROOM, Core.newRoom("basic", "host-uid", SV)));

allowed("host can read own room", who("host").read(ROOM));
allowed("anyone signed in can read a room if they know the code", who("eve").read(ROOM));
denied("signed-out user cannot read a room", who("none").read(ROOM));
denied("nobody can list all rooms", who("eve").read("/rooms"));
denied("nobody can read the whole database", who("host").read("/"));

denied("host joins own room as guest", update("host", ROOM, Core.joinUpdate("host-uid", SV)));
denied("join claiming another person's uid", update("eve", ROOM, Core.joinUpdate("guest-uid", SV)));
denied("signed-out join", update("none", ROOM, Core.joinUpdate("guest-uid", SV)));
denied("write someone else's presence while joining", update("guest", ROOM, { "players/O": "guest-uid", "presence/X": { online: false, at: SV } }));
allowed("guest joins", commit(update("guest", ROOM, Core.joinUpdate("guest-uid", SV))));
denied("a third person takes the guest seat", update("eve", ROOM, Core.joinUpdate("eve-uid", SV)));
denied("guest seat can't be re-claimed", update("eve", ROOM, { "players/O": "eve-uid" }));
denied("guest edits host seat", update("guest", ROOM, { "players/X": "guest-uid" }));
denied("change the game type", update("host", ROOM, { game: "basic" }));
denied("change the host", update("host", ROOM, { host: "guest-uid" }));
denied("guest deletes the room", write("guest", ROOM, null));
denied("stranger deletes the room", write("eve", ROOM, null));

/* =====================================================================
 *  3. CHEATING DURING PLAY (Ultimate)
 * =================================================================== */

newGame("ultimate");
const first = Core.buildMoveUpdate(room(), 4, 4);
denied("guest moves on the host's turn", update("guest", ROOM, first));
denied("stranger moves", update("eve", ROOM, first));
denied("signed-out move", update("none", ROOM, first));
denied("two cells in one move", update("host", ROOM, Object.assign({}, first, { "cells/0/0": "X" })));
denied("move with state not advanced", update("host", ROOM, { "cells/4/4": "X" }));
denied("state advanced but no cell written", update("host", ROOM, { state: first.state }));
denied("moves counter jumps by 2", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { moves: 2 }) })));
denied("turn not handed over", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { turn: "X" }) })));
denied("next board points the wrong way", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { next: "5" }) })));
denied("free turn claimed illegally", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { next: "any" }) })));
denied("last-move pointer lies", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { lb: "3" }) })));
denied("winner declared on move 1", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { winner: "X" }) })));
denied("score counter inflated", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { xb: 1 }) })));
denied("board claimed without a line", update("host", ROOM, Object.assign({}, first, { "boards/4": "X" })));
denied("host writes an O mark", update("host", ROOM, { "cells/4/4": "O", state: first.state }));
denied("cell outside the grid", update("host", ROOM, { "cells/9/0": "X", state: Object.assign({}, first.state, { lb: "9", lc: "0" }) }));
denied("junk field in state", update("host", ROOM, Object.assign({}, first, { state: Object.assign({}, first.state, { cheat: 1 }) })));
allowed("honest first move (host, centre of centre)", commit(update("host", ROOM, first)));

const s1 = room();
denied("host moves twice in a row", update("host", ROOM, Core.buildMoveUpdate(s1, 4, 0)));
denied("guest plays in the wrong board", update("guest", ROOM, Core.buildMoveUpdate(s1, 1, 1)));
denied("guest plays on an occupied cell", update("guest", ROOM, Core.buildMoveUpdate(s1, 4, 4)));
denied("guest overwrites the host's mark", update("guest", ROOM, { "cells/4/4": "O", state: Core.buildMoveUpdate(s1, 4, 0).state }));
denied("delete a mark", update("guest", ROOM, { "cells/4/4": null }));
denied("delete a mark while moving", update("guest", ROOM, Object.assign({}, Core.buildMoveUpdate(s1, 4, 0), { "cells/4/4": null })));
allowed("honest reply (guest, in the board the host pointed to)", commit(update("guest", ROOM, Core.buildMoveUpdate(s1, 4, 0))));
denied("host may not play in the board O's cell pointed away from", update("host", ROOM, Core.buildMoveUpdate(room(), 4, 1)));
allowed("honest move into the pointed board", commit(update("host", ROOM, Core.buildMoveUpdate(room(), 0, 0))));

/* ---- closed boards, free turns, small-board results ---- */

// Board 0 is won by X, next = "any", O to move
loadRoom(baseRoom("ultimate", { turn: "O", next: "any", xb: 1 },
    { 0: { 0: "X", 1: "X", 2: "X", 3: "O", 4: "O" }, 5: { 5: "X" } }, { 0: "X" }));
denied("play inside a board that was already won", update("guest", ROOM, Core.buildMoveUpdate(room(), 0, 5)));
allowed("free turn: play in any open board", commit(update("guest", ROOM, Core.buildMoveUpdate(room(), 1, 1))));

// X is sent to board 0 (closed) by O's move: the free-turn state must be recorded as "any"
loadRoom(baseRoom("ultimate", { turn: "O", next: "6", xb: 1, lb: "4", lc: "6" },
    { 0: { 0: "X", 1: "X", 2: "X" }, 6: { 1: "X" } }, { 0: "X" }));
const toClosed = Core.buildMoveUpdate(room(), 6, 0);          // O plays cell 0 -> points at board 0, which is closed
if (toClosed.state.next !== "any") { fail++; failures.push("builder should give a free turn when sent to a closed board"); } else pass++;
denied("pointing at a closed board without granting the free turn", update("guest", ROOM, Object.assign({}, toClosed, { state: Object.assign({}, toClosed.state, { next: "0" }) })));
allowed("sent to a closed board: free turn recorded", commit(update("guest", ROOM, toClosed)));
allowed("...and the other player may use it", commit(update("host", ROOM, Core.buildMoveUpdate(room(), 3, 3))));

// Win a small board: board 3 has X at 0 and 1; X plays cell 2
loadRoom(baseRoom("ultimate", { turn: "X", next: "3" }, { 3: { 0: "X", 1: "X", 3: "O", 4: "O" } }));
const winSmall = Core.buildMoveUpdate(room(), 3, 2);
if (winSmall["boards/3"] !== "X" || winSmall.state.xb !== 1) { fail++; failures.push("builder should claim the small board"); } else pass++;
(function () {
    const { ["boards/3"]: _drop, ...noBoard } = winSmall;
    denied("small board won but not recorded", update("host", ROOM, noBoard));
})();
denied("small board recorded as O's", update("host", ROOM, Object.assign({}, winSmall, { "boards/3": "O" })));
denied("small board recorded as a tie", update("host", ROOM, Object.assign({}, winSmall, { "boards/3": "draw" })));
denied("score not updated for the won board", update("host", ROOM, Object.assign({}, winSmall, { state: Object.assign({}, winSmall.state, { xb: 0 }) })));
allowed("small board won and recorded", commit(update("host", ROOM, winSmall)));
denied("play in the board that was just won", update("guest", ROOM, Core.buildMoveUpdate(room(), 3, 5)));

// Tied small board: board 8 nearly full, no line possible
loadRoom(baseRoom("ultimate", { turn: "O", next: "8" },
    { 8: { 0: "X", 1: "O", 2: "X", 3: "X", 4: "O", 5: "O", 6: "O", 7: "X" } }));
const tieSmall = Core.buildMoveUpdate(room(), 8, 8);
if (tieSmall["boards/8"] !== "draw") { fail++; failures.push("builder should mark the board tied"); } else pass++;
(function () {
    const { ["boards/8"]: _drop, ...noBoard } = tieSmall;
    denied("full board not recorded as tied", update("guest", ROOM, noBoard));
})();
denied("full board recorded as won", update("guest", ROOM, Object.assign({}, tieSmall, { "boards/8": "O" })));
allowed("tied board recorded", commit(update("guest", ROOM, tieSmall)));
if (room().state.next !== "8" && room().state.next !== "any") { fail++; failures.push("unexpected next after tie"); } else pass++;

// A move that does NOT finish a board must not write a board result
loadRoom(baseRoom("ultimate", { turn: "X", next: "any" }, { 2: { 0: "X", 1: "O" } }));
denied("board result written on a move that did not finish the board", update("host", ROOM, Object.assign({}, Core.buildMoveUpdate(room(), 2, 4), { "boards/2": "X" })));

/* ---- winning the game ---- */

// X owns boards 0 and 1 and plays the winning cell in board 2
function lineRoom(extra) {
    return baseRoom("ultimate", Object.assign({ turn: "X", next: "2", xb: 2 }, extra || {}),
        { 0: { 0: "X", 1: "X", 2: "X" }, 1: { 3: "X", 4: "X", 5: "X" }, 2: { 0: "X", 1: "X", 6: "O", 7: "O" } },
        { 0: "X", 1: "X" });
}
loadRoom(lineRoom());
const winGame = Core.buildMoveUpdate(room(), 2, 2);
if (winGame.state.winner !== "X") { fail++; failures.push("builder should declare X the winner"); } else pass++;
(function () {
    const st = Object.assign({}, winGame.state); delete st.winner;
    denied("game won but no winner recorded", update("host", ROOM, Object.assign({}, winGame, { state: st })));
})();
denied("wrong player named winner", update("host", ROOM, Object.assign({}, winGame, { state: Object.assign({}, winGame.state, { winner: "O" }) })));
denied("game called a draw despite a line", update("host", ROOM, Object.assign({}, winGame, { state: Object.assign({}, winGame.state, { winner: "draw" }) })));
allowed("winning move accepted", commit(update("host", ROOM, winGame)));
denied("move after the game is won", update("guest", ROOM, Core.buildMoveUpdate(Object.assign({}, room(), { state: Object.assign({}, room().state, { winner: undefined }) }), 5, 5)));
denied("edit the winner afterwards", update("guest", ROOM, { "state/winner": "O" }));
denied("host claims forfeit on a finished game", update("host", ROOM, { state: Object.assign({}, room().state, { reason: "forfeit" }) }));

// Three DRAWN boards in a row are not a win
loadRoom(baseRoom("ultimate", { turn: "O", next: "2", xb: 0, ob: 0 },
    { 2: { 0: "O", 1: "O", 3: "X", 4: "X" }, 0: { 0: "X" }, 1: { 0: "X" } }, { 0: "draw", 1: "draw" }));
(function () {
    // O plays cell 2 of board 2 and wins that board: O has 1 board, two draws: no line, grid not full
    const u = Core.buildMoveUpdate(room(), 2, 2);
    if (u.state.winner) { fail++; failures.push("three boards, two drawn: should not be a win"); } else pass++;
    allowed("O wins a board next to two drawn boards: no game result yet", commit(update("guest", ROOM, u)));
})();
loadRoom(baseRoom("ultimate", { turn: "O", next: "2", xb: 0, ob: 0 },
    { 2: { 0: "X", 1: "O", 2: "X", 3: "X", 4: "O", 5: "O", 6: "O", 7: "X" }, 0: { 0: "X" }, 1: { 0: "X" } }, { 0: "draw", 1: "draw" }));
(function () {
    const u = Core.buildMoveUpdate(room(), 2, 8);       // board 2 ends tied: three drawn boards in a row
    if (u.state.winner) { fail++; failures.push("three drawn boards in a row must not win"); } else pass++;
    allowed("three drawn boards in a row do not end the game", commit(update("guest", ROOM, u)));
    denied("...declaring a winner for them is rejected", update("guest", ROOM, Object.assign({}, u, { state: Object.assign({}, u.state, { winner: "O" }) })) );
})();

// Full grid, no line: most boards wins
function fullGridRoom(lastCells) {
    return baseRoom("ultimate", { turn: "O", next: "8", xb: 4, ob: 4, lb: "5", lc: "8" },
        { 8: lastCells },
        { 0: "X", 1: "O", 2: "X", 3: "O", 4: "X", 5: "O", 6: "O", 7: "X" });
}
loadRoom(fullGridRoom({ 0: "O", 1: "O", 3: "X", 4: "X" }));
const tbWin = Core.buildMoveUpdate(room(), 8, 2);
if (tbWin.state.winner !== "O") { fail++; failures.push("tie-break: builder should name O"); } else pass++;
denied("tie-break: wrong winner named", update("guest", ROOM, Object.assign({}, tbWin, { state: Object.assign({}, tbWin.state, { winner: "X" }) })));
denied("tie-break: called a draw although O has more boards", update("guest", ROOM, Object.assign({}, tbWin, { state: Object.assign({}, tbWin.state, { winner: "draw" }) })));
(function () {
    const st = Object.assign({}, tbWin.state); delete st.winner;
    denied("tie-break: game left running on a full grid", update("guest", ROOM, Object.assign({}, tbWin, { state: st })));
})();
allowed("tie-break: most boards wins", commit(update("guest", ROOM, tbWin)));

loadRoom(fullGridRoom({ 0: "X", 1: "O", 2: "X", 3: "X", 4: "O", 5: "O", 6: "O", 7: "X" }));
const tbDraw = Core.buildMoveUpdate(room(), 8, 8);
if (tbDraw.state.winner !== "draw") { fail++; failures.push("tie-break: builder should call a draw"); } else pass++;
denied("tie-break: equal boards, X named winner", update("guest", ROOM, Object.assign({}, tbDraw, { state: Object.assign({}, tbDraw.state, { winner: "X" }) })));
allowed("tie-break: equal boards is a draw", commit(update("guest", ROOM, tbDraw)));

/* =====================================================================
 *  4. BASIC-specific cheats
 * =================================================================== */

newGame("basic");
denied("basic: play on board 1", update("host", ROOM, Object.assign(Core.buildMoveUpdate(room(), 1, 0))));
denied("basic: next board restriction", update("host", ROOM, Object.assign({}, Core.buildMoveUpdate(room(), 0, 4), { state: Object.assign({}, Core.buildMoveUpdate(room(), 0, 4).state, { next: "4" }) })));
allowed("basic: X plays 0", commit(play(0, 0)));
allowed("basic: O plays 3", commit(play(0, 3)));
allowed("basic: X plays 1", commit(play(0, 1)));
allowed("basic: O plays 4", commit(play(0, 4)));
(function () {
    const u = Core.buildMoveUpdate(room(), 0, 2);
    const st = Object.assign({}, u.state); delete st.winner;
    denied("basic: three in a row not recorded", update("host", ROOM, Object.assign({}, u, { state: st })));
    denied("basic: wrong winner", update("host", ROOM, Object.assign({}, u, { state: Object.assign({}, u.state, { winner: "O" }) })));
    allowed("basic: X completes the row and wins", commit(update("host", ROOM, u)));
    denied("basic: no moves after the win", update("guest", ROOM, { "cells/0/5": "O" }));
})();

/* =====================================================================
 *  5. PRESENCE, RECONNECT, GRACE PERIOD
 * =================================================================== */

function goOffline(user, seat, atTime) {
    return update(user, ROOM, { ["presence/" + seat]: { online: false, at: SV } }, atTime);
}
function goOnline(user, seat, atTime) {
    return update(user, ROOM, { ["presence/" + seat]: { online: true, at: SV } }, atTime);
}

newGame("ultimate");
allowed("host plays", commit(play(4, 4, T0 + 1000)));

// Guest drops: game pauses, comes back: game resumes
allowed("guest goes offline", commit(goOffline("guest", "O", T0 + 2000)));
denied("host cannot move while guest is offline", play(4, 0, T0 + 3000));
denied("guest cannot move while offline", update("guest", ROOM, Core.buildMoveUpdate(room(), 4, 0), T0 + 3000));
allowed("guest returns within the grace period", commit(goOnline("guest", "O", T0 + 60000)));
allowed("game resumes: guest moves", commit(play(4, 0, T0 + 61000)));

// Host drops: game pauses; guest cannot move or claim anything
allowed("host goes offline", commit(goOffline("host", "X", T0 + 70000)));
denied("guest cannot move while host is offline", play(0, 4, T0 + 71000));
denied("guest cannot claim a win 60 s after the host dropped", update("guest", ROOM, Core.buildForfeitUpdate(room(), "O"), T0 + 70000 + 60000));
denied("guest cannot claim the win in the host's name", update("guest", ROOM, Core.buildForfeitUpdate(room(), "X"), T0 + 70000 + 130000));
allowed("host comes back", commit(goOnline("host", "X", T0 + 70000 + 5 * 3600 * 1000)));
allowed("game resumes after the host returns", commit(play(0, 4, T0 + 70000 + 5 * 3600 * 1000 + 1000)));

// Presence spoofing
denied("guest writes the host's presence", update("guest", ROOM, { "presence/X": { online: false, at: SV } }, T0 + 80000));
denied("stranger writes presence", update("eve", ROOM, { "presence/O": { online: false, at: SV } }, T0 + 80000));
denied("presence time in the future", update("guest", ROOM, { "presence/O": { online: false, at: T0 + 80000 + 999999 } }, T0 + 80000));
denied("presence with extra fields", update("guest", ROOM, { "presence/O": { online: true, at: SV, god: true } }, T0 + 80000));
denied("presence for a third seat", update("guest", ROOM, { "presence/Z": { online: true, at: SV } }, T0 + 80000));
denied("delete presence", update("guest", ROOM, { "presence/O": null }, T0 + 80000));

// Forfeit: the host may claim the win only once the guest has been away for 120 seconds (server clock)
newGame("ultimate");
allowed("host plays", commit(play(4, 4, T0 + 1000)));
const away = T0 + 10000;
allowed("guest goes offline", commit(goOffline("guest", "O", away)));
const claim = () => Core.buildForfeitUpdate(room());
denied("forfeit claim at once", update("host", ROOM, claim(), away + 1));
denied("forfeit claim after 60s", update("host", ROOM, claim(), away + 60000));
denied("forfeit claim 1ms early", update("host", ROOM, claim(), away + 119999));
denied("forfeit claim by a stranger", update("eve", ROOM, claim(), away + 130000));
denied("forfeit claim by the absent guest themselves", update("guest", ROOM, claim(), away + 130000));
denied("forfeit claim naming O the winner", update("host", ROOM, { state: Object.assign({}, room().state, { winner: "O", reason: "forfeit" }) }, away + 130000));
denied("forfeit claim that also changes the score", update("host", ROOM, { state: Object.assign({}, room().state, { winner: "X", reason: "forfeit", xb: 3 }) }, away + 130000));
denied("forfeit claim that also moves", update("host", ROOM, Object.assign({}, claim(), { "cells/0/0": "X" }), away + 130000));
denied("forfeit claim with no reason", update("host", ROOM, { state: Object.assign({}, room().state, { winner: "X" }) }, away + 130000));
allowed("forfeit claim exactly at 120s", commit(update("host", ROOM, claim(), away + 120000)));
if (Core.roomToGame(room()).reason === "forfeit" && Core.roomToGame(room()).winner === "X") pass++; else { fail++; failures.push("roomToGame should show the forfeit"); }
denied("no moves after a forfeit", play(4, 0, away + 130000));

// REGRESSION: being on turn must not let the host claim a forfeit while the guest is connected
newGame("ultimate");
denied("forfeit claim while the guest is online (host's turn)", update("host", ROOM, Core.buildForfeitUpdate(room()), T0 + 99999999));
allowed("host plays", commit(play(4, 4, T0 + 1000)));
allowed("guest plays", commit(play(4, 0, T0 + 2000)));
denied("forfeit claim while the guest is online (host's turn again)", update("host", ROOM, Core.buildForfeitUpdate(room()), T0 + 99999999));
allowed("host goes offline", commit(goOffline("host", "X", T0 + 3000)));
denied("forfeit claim by the host when the HOST is the absent one", update("host", ROOM, Core.buildForfeitUpdate(room()), T0 + 99999999));

// The guest returning exactly in time is not forfeited
newGame("ultimate");
allowed("host plays", commit(play(4, 4, T0 + 1000)));
allowed("guest offline", commit(goOffline("guest", "O", away)));
allowed("guest back at 119s", commit(goOnline("guest", "O", away + 119000)));
denied("forfeit claim after the guest came back", update("host", ROOM, claim(), away + 125000));

// A guest who never came online (joined, then vanished) can be forfeited too
newGame("ultimate");
allowed("guest offline immediately after joining", commit(goOffline("guest", "O", T0 + 500)));
allowed("forfeit possible after the grace period", commit(update("host", ROOM, Core.buildForfeitUpdate(room()), T0 + 500 + 120000)));

// No guest at all: nothing to forfeit
reset();
allowed("create", commit(write("host", ROOM, Core.newRoom("ultimate", "host-uid", SV))));
denied("claim a win in a room nobody joined", update("host", ROOM, Core.buildForfeitUpdate(room()), T0 + 99999999));
denied("move in a room nobody joined", update("host", ROOM, Core.buildMoveUpdate(room(), 4, 4)));
allowed("host deletes own room", commit(write("host", ROOM, null)));

/* =====================================================================
 *  5b. REMATCH pointer
 * =================================================================== */

(function () {
    const NEW = "NEWRM2";
    function finishedRoom(extra) {
        return baseRoom("ultimate", Object.assign({ turn: "O", next: "any", winner: "X", reason: "forfeit" }, extra || {}));
    }
    function withNewRoom(host, game) {
        loadRoom(finishedRoom());
        const r = write(host === "host" ? "host" : "guest", "/rooms/" + NEW, Core.newRoom(game || "ultimate", host === "host" ? "host-uid" : "guest-uid", SV));
        allowed("create the rematch room (" + host + ")", commit(r));
    }
    withNewRoom("host");
    allowed("host points the finished game at their new room", commit(update("host", ROOM, { rematch: NEW })));
    denied("the pointer can't be changed afterwards", update("host", ROOM, { rematch: "NEWRM3" }));
    denied("the other player can't overwrite the pointer", update("guest", ROOM, { rematch: NEW }));

    withNewRoom("guest");
    allowed("guest can start the rematch too (they become the new host)", commit(update("guest", ROOM, { rematch: NEW })));

    withNewRoom("host");
    denied("a stranger can't write the pointer", update("eve", ROOM, { rematch: NEW }));
    denied("signed-out can't write the pointer", update("none", ROOM, { rematch: NEW }));
    denied("pointer to a room that doesn't exist", update("host", ROOM, { rematch: "ZZZZZ2" }));
    denied("pointer to a room someone else created", update("guest", ROOM, { rematch: NEW }));
    denied("pointer to the same room", update("host", ROOM, { rematch: CODE }));
    denied("pointer that isn't a room code", update("host", ROOM, { rematch: "hello" }));
    denied("deleting the pointer", update("host", ROOM, { rematch: null }));

    // different game type
    withNewRoom("host", "basic");
    denied("pointer to a room of a different game", update("host", ROOM, { rematch: NEW }));

    // not over yet
    loadRoom(baseRoom("ultimate", { turn: "X", next: "any" }));
    allowed("create a room while another game is still running", commit(write("host", "/rooms/" + NEW, Core.newRoom("ultimate", "host-uid", SV))));
    denied("no rematch pointer while the game is still on", update("host", ROOM, { rematch: NEW }));
})();

/* =====================================================================
 *  5c. ABANDONMENT works for BOTH players; both-dropped; spectators
 * =================================================================== */

(function () {
    const away = T0 + 10000;
    const goOff = (user, seat, t) => commit(update(user, ROOM, { ["presence/" + seat]: { online: false, at: SV } }, t));
    const goOn = (user, seat, t) => commit(update(user, ROOM, { ["presence/" + seat]: { online: true, at: SV } }, t));

    // the HOST abandons: the guest wins after 120 s, whoever's turn it is
    for (const hostOnTurn of [false, true]) {
        newGame("ultimate");
        allowed("host plays", commit(play(4, 4, T0 + 1000)));
        if (hostOnTurn) allowed("guest plays", commit(play(4, 0, T0 + 2000)));
        goOff("host", "X", away);
        const claimO = () => Core.buildForfeitUpdate(room(), "O");
        const label = hostOnTurn ? " (host's turn)" : " (guest's turn)";
        denied("guest claim at once" + label, update("guest", ROOM, claimO(), away + 1));
        denied("guest claim 1 ms early" + label, update("guest", ROOM, claimO(), away + 119999));
        denied("guest claim naming the host the winner" + label, update("guest", ROOM, Core.buildForfeitUpdate(room(), "X"), away + 130000));
        denied("stranger claims for the guest" + label, update("eve", ROOM, claimO(), away + 130000));
        denied("absent host claims against the guest" + label, update("host", ROOM, Core.buildForfeitUpdate(room(), "X"), away + 130000));
        allowed("guest wins at exactly 120 s" + label, commit(update("guest", ROOM, claimO(), away + 120000)));
        if (room().state.winner === "O" && room().state.reason === "forfeit") pass++; else { fail++; failures.push("guest should be the winner" + label); }
        denied("second claim is refused (no duplicate result)" + label, update("guest", ROOM, claimO(), away + 130000));
        denied("no moves after abandonment" + label, update("host", ROOM, Core.buildMoveUpdate(Object.assign({}, room(), { state: Object.assign({}, room().state, { winner: undefined }) }), 0, 0), away + 130000));
    }

    // leaving after the match has finished never changes the result
    newGame("basic");
    for (const [who, cell] of [["host", 0], ["guest", 3], ["host", 1], ["guest", 4], ["host", 2]]) allowed("basic move", commit(update(who, ROOM, Core.buildMoveUpdate(room(), 0, cell), T0 + 1000)));
    goOff("guest", "O", T0 + 2000);
    denied("a finished game can't be re-decided by abandonment", update("host", ROOM, Core.buildForfeitUpdate(room(), "X"), T0 + 500000));
    if (room().state.winner === "X" && !room().state.reason) pass++; else { fail++; failures.push("finished result must not change"); }

    // BOTH players drop: nobody can be awarded the win
    newGame("ultimate");
    allowed("host plays", commit(play(4, 4, T0 + 1000)));
    goOff("host", "X", away);
    goOff("guest", "O", away + 5000);
    // the guest comes back after 5 minutes; the host is still gone
    goOn("guest", "O", away + 300000);
    denied("guest returns after BOTH dropped: no win for them (they were away too)", update("guest", ROOM, Core.buildForfeitUpdate(room(), "O"), away + 300000 + 130000));
    denied("...and they can't move while the host is away", play(4, 0, away + 300001));
    goOn("host", "X", away + 400000);
    allowed("both back: the game resumes", commit(play(4, 0, away + 400001)));

    // a short blip by the claimant AFTER the opponent dropped also removes the claim (they were disconnected too)
    newGame("ultimate");
    goOff("guest", "O", away);
    goOff("host", "X", away + 1000); goOn("host", "X", away + 2000);
    denied("host blipped after the guest dropped: no claim", update("host", ROOM, Core.buildForfeitUpdate(room(), "X"), away + 125000));
    // ...but a blip BEFORE the opponent dropped keeps it
    newGame("ultimate");
    goOff("host", "X", T0 + 2000); goOn("host", "X", T0 + 3000);
    goOff("guest", "O", away);
    allowed("host blipped before the guest dropped: claim is fine", commit(update("host", ROOM, Core.buildForfeitUpdate(room(), "X"), away + 120000)));

    /* ---- spectators ---- */
    const slot = (n, u) => ({ uid: u + "-uid", online: true, at: SV });
    newGame("ultimate");
    allowed("spectator 1 takes slot s1", commit(write("sp1", ROOM + "/spectators/s1", slot(1, "sp1"))));
    denied("an occupied slot can't be taken by someone else", write("sp2", ROOM + "/spectators/s1", slot(1, "sp2")));
    denied("writing a slot with someone else's uid", write("sp2", ROOM + "/spectators/s2", slot(2, "sp3")));
    denied("the same person can't hold two slots", write("sp1", ROOM + "/spectators/s2", slot(2, "sp1")));
    allowed("spectator 2 takes slot s2", commit(write("sp2", ROOM + "/spectators/s2", slot(2, "sp2"))));
    allowed("spectator 3 takes slot s3", commit(write("sp3", ROOM + "/spectators/s3", slot(3, "sp3"))));
    for (const k of ["s1", "s2", "s3"]) denied("4th spectator is refused (" + k + " taken)", write("sp4", ROOM + "/spectators/" + k, slot(0, "sp4")));
    denied("there is no 4th slot", write("sp4", ROOM + "/spectators/s4", slot(4, "sp4")));
    denied("a spectator can't be added without a slot name", update("sp4", ROOM, { spectators: { s1: slot(1, "sp4") } }));
    allowed("everyone signed in can still READ the room", who("sp4").read(ROOM));

    denied("host can't also be a spectator", write("host", ROOM + "/spectators/s1", slot(1, "host")));
    // remaining checks use the full room (3 spectators)
    const base = room();
    const moveTry = Core.buildMoveUpdate(base, 4, 4);
    denied("spectator can't play a move", update("sp1", ROOM, moveTry));
    denied("spectator can't play even on the right turn (as host's mark)", update("sp1", ROOM, { "cells/4/4": "X", state: moveTry.state }));
    denied("spectator can't write a player's presence", update("sp1", ROOM, { "presence/X": { online: false, at: SV } }));
    denied("spectator can't change the seats", update("sp1", ROOM, { "players/O": "sp1-uid" }));
    denied("spectator can't touch the state", update("sp1", ROOM, { "state/turn": "O" }));
    denied("spectator can't write a rematch pointer", update("sp1", ROOM, { rematch: "ABCDEF" }));
    denied("spectator can't delete the room", write("sp1", ROOM, null));
    denied("spectator can't kick another spectator (delete their slot)", write("sp1", ROOM + "/spectators/s2", null));
    denied("spectator can't mark another spectator offline", write("sp1", ROOM + "/spectators/s2", { uid: "sp2-uid", online: false, at: SV }));
    denied("slot with a made-up time in the future", write("sp1", ROOM + "/spectators/s1", { uid: "sp1-uid", online: true, at: T0 + 99999999 }));
    denied("slot with extra fields", write("sp1", ROOM + "/spectators/s1", { uid: "sp1-uid", online: true, at: SV, admin: true }));

    // watchers come and go
    allowed("owner can mark their own slot offline", commit(write("sp2", ROOM + "/spectators/s2", { uid: "sp2-uid", online: false, at: SV }, T0 + 100000)));
    denied("an offline slot is still reserved for 30 s (29.9 s)", write("sp4", ROOM + "/spectators/s2", slot(2, "sp4"), T0 + 100000 + 29999));
    denied("...exactly 30 s", write("sp4", ROOM + "/spectators/s2", slot(2, "sp4"), T0 + 100000 + 30000));
    allowed("owner can come back to their reserved slot (refresh)", commit(write("sp2", ROOM + "/spectators/s2", slot(2, "sp2"), T0 + 100000 + 20000)));
    allowed("owner leaves for good (slot removed)", commit(write("sp3", ROOM + "/spectators/s3", null)));
    allowed("a freed slot can be taken at once by someone new", commit(write("sp4", ROOM + "/spectators/s3", slot(3, "sp4"))));
    allowed("owner goes offline again", commit(write("sp4", ROOM + "/spectators/s3", { uid: "sp4-uid", online: false, at: SV }, T0 + 200000)));
    allowed("a STALE offline slot (30 s+) can be taken over", commit(write("sp3", ROOM + "/spectators/s3", slot(3, "sp3"), T0 + 200000 + 30001)));

    // a watcher can't become the guest
    reset();
    allowed("create", commit(write("host", ROOM, Core.newRoom("ultimate", "host-uid", SV))));
    allowed("a watcher joins an empty room", commit(write("sp1", ROOM + "/spectators/s1", slot(1, "sp1"))));
    denied("...but that watcher can't also take the guest seat", update("sp1", ROOM, Core.joinUpdate("sp1-uid", SV)));
    allowed("someone else can take the guest seat", commit(update("guest", ROOM, Core.joinUpdate("guest-uid", SV))));
    denied("a room can't be created with watchers already in it", write("eve", "/rooms/ZZZZZ3", Object.assign(Core.newRoom("ultimate", "eve-uid", SV), { spectators: { s1: slot(1, "sp1") } })));
})();

/* =====================================================================
 *  6. CLIENT HELPERS
 * =================================================================== */

(function () {
    const codes = new Set();
    for (let i = 0; i < 2000; i++) {
        const c = Core.generateRoomCode();
        if (!Core.isValidRoomCode(c)) { fail++; failures.push("generated an invalid code " + c); return; }
        codes.add(c);
    }
    if (codes.size < 1990) { fail++; failures.push("room codes collide too often"); } else pass++;
    if (Core.normalizeRoomCode(" abc-d23 ") === "ABCD23") pass++; else { fail++; failures.push("normalizeRoomCode"); }

    const room0 = Core.newRoom("ultimate", "u1", 1000);
    room0.players.O = "u2"; room0.presence.O = { online: true, at: 1000 };
    if (Core.roomPhase(room0, 5000) === "playing") pass++; else { fail++; failures.push("phase playing"); }
    room0.presence.O = { online: false, at: 2000 };
    const ss = Core.seatStatus(room0, "O", 2000 + 30000);
    if (!ss.online && ss.graceLeftMs === 90000 && Core.roomPhase(room0, 5000) === "guest-away") pass++; else { fail++; failures.push("grace countdown: " + JSON.stringify(ss)); }
    if (!Core.canClaimForfeit(room0, "X", 2000 + 119999) && Core.canClaimForfeit(room0, "X", 2000 + 120000) && !Core.canClaimForfeit(room0, "O", 2000 + 999999)) pass++; else { fail++; failures.push("canClaimForfeit"); }
    room0.presence.O = { online: true, at: 2500 };
    room0.presence.X = { online: false, at: 3000 };
    if (Core.roomPhase(room0, 9000) === "host-away") pass++; else { fail++; failures.push("phase host-away"); }
    room0.presence.O = { online: false, at: 3500 };
    if (Core.roomPhase(room0, 9000) === "both-away") pass++; else { fail++; failures.push("phase both-away"); }
    // arrays from Firebase (keys 0..n come back as arrays)
    const asArrays = { game: "ultimate", players: { X: "a", O: "b" }, state: { turn: "O", moves: 1, next: "4", xb: 0, ob: 0 }, cells: [null, null, null, null, ["X"]], boards: [] };
    const g = Core.roomToGame(asArrays);
    if (g.boardStates[4][0] === "X" && g.nextBoardIndex === 4 && g.currentPlayer === "O") pass++; else { fail++; failures.push("roomToGame with arrays"); }
})();

/* ===================================================================== */

console.log(`\n${pass} checks passed, ${fail} failed`);
if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
