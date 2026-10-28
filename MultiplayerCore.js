/*
 * Online multiplayer: the game-room logic. Pure functions only, with no Firebase and no page code in here,
 * so it can be tested on its own. The Firebase security rules (firebase/database.rules.json) check the same
 * rules on the server, which is what stops a modified client from cheating.
 *
 * A room (see firebase/build-rules.js for the full data model) looks like:
 *   { game, host, createdAt, players: {X, O}, presence: {X: {online, at}, O: {...}},
 *     state: {turn, moves, next, lb, lc, xb, ob, winner?, reason?}, cells: {...}, boards: {...}, rematch? }
 */
(function (root) {
    "use strict";

    const GRACE_MS = 120000;                                  // how long a player has to come back
    const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 characters: no I, O, 0 or 1 (easy to confuse)
    const CODE_LENGTH = 6;
    const SPECTATOR_SLOTS = ["s1", "s2", "s3"];                  // at most 3 watchers
    const SPECTATOR_STALE_MS = 30000;                         // an offline watcher's slot can be taken over after this
    const CODE_REGEX = /^[A-HJ-NP-Z2-9]{6}$/;

    const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

    /* ---------------- room codes ---------------- */

    function defaultRandomBytes(n) {
        const a = new Uint8Array(n);
        if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(a);
        else for (let i = 0; i < n; i++) a[i] = Math.floor(Math.random() * 256);
        return a;
    }

    // 32 letters/digits ^ 6 = about a billion codes, so a code can't be guessed by trying.
    function generateRoomCode(randomBytes) {
        const bytes = (randomBytes || defaultRandomBytes)(CODE_LENGTH);
        let code = "";
        for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
        return code;
    }

    // Accepts what people type: lower case, spaces, dashes ("abc-d23" -> "ABCD23")
    function normalizeRoomCode(input) {
        return String(input === undefined || input === null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
    }

    function isValidRoomCode(code) {
        return CODE_REGEX.test(code);
    }

    /* ---------------- creating / joining ---------------- */

    // `ts` is the server-timestamp placeholder (firebase.database.ServerValue.TIMESTAMP)
    function newRoom(game, uid, ts) {
        return {
            game: game,
            host: uid,
            createdAt: ts,
            players: { X: uid },
            presence: { X: { online: true, at: ts } },
            state: { turn: "X", moves: 0, next: "any", xb: 0, ob: 0 }
        };
    }

    function joinUpdate(uid, ts) {
        return { "players/O": uid, "presence/O": { online: true, at: ts } };
    }

    function presenceValue(online, ts) {
        return { online: online, at: ts };
    }

    function seatOf(room, uid) {
        if (!room || !room.players || !uid) return null;
        if (room.players.X === uid) return "X";
        if (room.players.O === uid) return "O";
        return null;
    }

    /* ---------------- reading a room ---------------- */

    // Firebase hands back arrays for keys like 0,1,2... and objects otherwise, so read both the same way.
    function get(obj) {
        let o = obj;
        for (let i = 1; i < arguments.length; i++) {
            if (o === undefined || o === null) return undefined;
            o = o[arguments[i]];
        }
        return o;
    }

    // Turns a room into the same shape the game pages already use (boardStates, overallBoardState, ...)
    function roomToGame(room) {
        const st = room.state || {};
        const boardStates = [];
        const overall = [];
        for (let b = 0; b < 9; b++) {
            const row = [];
            for (let c = 0; c < 9; c++) row.push(get(room.cells, b, c) || "");
            boardStates.push(row);
            overall.push(get(room.boards, b) || "");
        }
        return {
            game: room.game,
            boardStates: boardStates,
            overallBoardState: overall,
            currentPlayer: st.turn,
            nextBoardIndex: (st.next === undefined || st.next === "any") ? null : Number(st.next),
            moves: st.moves || 0,
            winner: st.winner || null,            // "X" | "O" | "draw" | null
            reason: st.reason || null,            // "forfeit" | null
            over: !!st.winner,
            last: (st.lb === undefined || st.lc === undefined) ? null : { b: Number(st.lb), c: Number(st.lc) },
            xBoards: st.xb || 0,
            oBoards: st.ob || 0,
            rematch: room.rematch || null
        };
    }

    /* ---------------- presence / reconnecting ---------------- */

    // serverNow = the local clock corrected by Firebase's ".info/serverTimeOffset"
    function seatStatus(room, seat, serverNow) {
        if (!get(room.players, seat)) return { joined: false, online: false, graceLeftMs: null };
        const p = get(room.presence, seat);
        if (!p) return { joined: true, online: false, graceLeftMs: GRACE_MS };
        if (p.online) return { joined: true, online: true, graceLeftMs: null };
        const elapsed = Math.max(0, serverNow - p.at);
        return { joined: true, online: false, graceLeftMs: Math.max(0, GRACE_MS - elapsed) };
    }

    // "waiting" (no guest yet) | "both-away" | "host-away" | "guest-away" | "playing" | "finished"
    function roomPhase(room, serverNow) {
        if (room.state && room.state.winner) return "finished";
        const x = seatStatus(room, "X", serverNow);
        const o = seatStatus(room, "O", serverNow);
        if (!o.joined) return "waiting";
        if (!x.online && !o.online) return "both-away";
        if (!x.online) return "host-away";
        if (!o.online) return "guest-away";
        return "playing";
    }

    // Abandonment: the player who is still here wins once the other has been away for the whole grace period.
    // Valid for EITHER seat, but only if the claimant stayed connected since before the opponent dropped
    // (so when both players dropped, nobody can claim). The server rules check the same thing with the server clock.
    function canClaimForfeit(room, mySeat, serverNow) {
        if ((mySeat !== "X" && mySeat !== "O") || (room.state && room.state.winner)) return false;
        const opp = mySeat === "X" ? "O" : "X";
        const them = seatStatus(room, opp, serverNow);
        if (!them.joined || them.online || them.graceLeftMs !== 0) return false;
        const mine = get(room.presence, mySeat);
        const theirs = get(room.presence, opp);
        return !!(mine && mine.online === true && theirs && mine.at <= theirs.at);
    }

    /* ---------------- spectators ---------------- */

    function spectatorSlotOf(room, uid) {
        if (!uid) return null;
        for (const k of SPECTATOR_SLOTS) if (get(room.spectators, k, "uid") === uid) return k;
        return null;
    }

    // watchers who are connected right now
    function spectatorCount(room) {
        let n = 0;
        for (const k of SPECTATOR_SLOTS) if (get(room.spectators, k, "online") === true) n++;
        return n;
    }

    // Slots this uid could try to claim, best first: its own, then empty ones, then stale offline ones.
    function spectatorSlotCandidates(room, uid, serverNow) {
        const own = spectatorSlotOf(room, uid);
        if (own) return [own];
        const empty = [], stale = [];
        for (const k of SPECTATOR_SLOTS) {
            const sl = get(room.spectators, k);
            if (!sl) empty.push(k);
            else if (sl.online === false && serverNow - sl.at > SPECTATOR_STALE_MS) stale.push(k);
        }
        return empty.concat(stale);
    }

    /* ---------------- moves ---------------- */

    function lineWinner(a) {
        for (const l of LINES) {
            const v = a[l[0]];
            if ((v === "X" || v === "O") && v === a[l[1]] && v === a[l[2]]) return v;
        }
        return null;
    }

    // Returns null if the move is allowed, otherwise a short reason code.
    function moveError(room, b, c, seat, opts) {
        const st = room.state || {};
        if (!get(room.players, "O")) return "waiting";
        if (st.winner) return "over";
        if (st.turn !== seat) return "not-your-turn";
        if (!(opts && opts.ignorePresence)) {
            if (!get(room.presence, "X", "online") || !get(room.presence, "O", "online")) return "paused";
        }
        if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || b > 8 || c < 0 || c > 8) return "bad-cell";
        if (room.game === "basic" && b !== 0) return "bad-cell";
        if (get(room.cells, b, c)) return "occupied";
        if (get(room.boards, b)) return "closed-board";
        if (room.game === "ultimate" && st.next !== "any" && st.next !== String(b)) return "wrong-board";
        return null;
    }

    // The complete update a move needs. Firebase applies it atomically, and the server rules check every part.
    function buildMoveUpdate(room, b, c) {
        const st = room.state;
        const mark = st.turn;

        const cells = [];
        for (let i = 0; i < 9; i++) cells.push(get(room.cells, b, i) || "");
        cells[c] = mark;

        const boards = [];
        for (let i = 0; i < 9; i++) boards.push(get(room.boards, i) || "");

        let result = "";                                              // result of the small board just played in
        if (lineWinner(cells) === mark) result = mark;
        else if (cells.every(x => x !== "")) result = "draw";
        if (result) boards[b] = result;

        let xb = st.xb || 0, ob = st.ob || 0;
        if (result === "X") xb++;
        if (result === "O") ob++;

        let winner = null;
        if (room.game === "basic") {
            if (result) winner = result;                              // the one board IS the game
        } else {
            if (result === mark && lineWinner(boards) === mark) winner = mark;
            else if (boards.every(x => x !== "")) winner = xb > ob ? "X" : (ob > xb ? "O" : "draw");
        }

        const next = (room.game === "ultimate" && boards[c] === "") ? String(c) : "any";   // closed board = free turn

        const state = {
            turn: mark === "X" ? "O" : "X",
            moves: (st.moves || 0) + 1,
            next: next,
            lb: String(b),
            lc: String(c),
            xb: xb,
            ob: ob
        };
        if (winner) state.winner = winner;

        const update = {};
        update["cells/" + b + "/" + c] = mark;
        if (result) update["boards/" + b] = result;
        update.state = state;
        return update;
    }

    function buildForfeitUpdate(room, seat) {
        const state = {};
        Object.keys(room.state).forEach(k => { state[k] = room.state[k]; });
        state.winner = seat || "X";
        state.reason = "forfeit";
        return { state: state };
    }

    const api = {
        GRACE_MS, CODE_ALPHABET, CODE_LENGTH, SPECTATOR_SLOTS, SPECTATOR_STALE_MS,
        generateRoomCode, normalizeRoomCode, isValidRoomCode,
        newRoom, joinUpdate, presenceValue, seatOf,
        roomToGame, seatStatus, roomPhase, canClaimForfeit,
        spectatorSlotOf, spectatorCount, spectatorSlotCandidates,
        moveError, buildMoveUpdate, buildForfeitUpdate, lineWinner
    };
    root.MultiplayerCore = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
