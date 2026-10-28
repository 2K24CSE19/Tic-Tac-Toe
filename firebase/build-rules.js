/*
 * Generates database.rules.json (the Firebase Realtime Database security rules).
 *
 *   node build-rules.js
 *
 * Why a generator? The rules have no loops, so "does this move complete a line?" must be written out
 * explicitly for each of the 9 cells. Generating them avoids typos.
 *
 * DATA MODEL  (rooms/<CODE>)
 *   game        "basic" | "ultimate"                      fixed at creation
 *   host        uid of the room creator (plays X)
 *   createdAt   server time
 *   players     { X: uid, O: uid }                        O is claimed once by the guest who joins
 *   presence    { X: {online, at}, O: {online, at} }      "at" = server time of the last change
 *   state       { turn, moves, next, lb, lc, xb, ob, winner, reason }
 *                 next   "any" or "0".."8"  (board the player to move must use; "any" = free turn)
 *                 lb/lc  board / cell of the last move
 *                 xb/ob  how many small boards X / O have won so far (used for the full-grid tie-break)
 *                 winner "X" | "O" | "draw"  (absent while playing)
 *                 reason "forfeit" when the host claimed a win after the guest stayed away
 *   spectators  { s1, s2, s3 }: each { uid, online, at } = one of the 3 watcher slots (race-safe: a slot is claimed by writing to it)
 *   rematch     code of a NEW room, written once by a player after the game is over ("let's play again")
 *   cells       { <board>: { <cell>: "X" | "O" } }        Basic uses board "0" only
 *   boards      { <board>: "X" | "O" | "draw" }           result of each small board (Basic: the game)
 *
 * A move is ONE atomic multi-path update:  cells/b/c, boards/b (only if the move closed the board), state.
 * Every piece is checked against the others, so a client cannot fake any part of a move.
 */
const fs = require("fs");
const path = require("path");

const GRACE_MS = 120000;
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/* ---------- building blocks (strings of rule expressions) ---------- */

// Data as it is BEFORE the write (rules' `root` is always the old data)
const OLD = p => `root.child('rooms').child($room).child('${p}')`;

const NOT_OVER = `!${OLD('state/winner')}.exists()`;
const BOTH_ONLINE = `${OLD('presence/X/online')}.val() === true && ${OLD('presence/O/online')}.val() === true`;
const PLAYER_ON_TURN = `${OLD('players')}.child(${OLD('state/turn')}.val()).val()`;
const IS_BASIC = `${OLD('game')}.val() === 'basic'`;

// "You are the player whose turn it is, the game is not over, and both players are connected."
const MOVE_AUTH_CORE = `${NOT_OVER} && ${BOTH_ONLINE} && auth.uid === ${PLAYER_ON_TURN}`;

const STALE_MS = 30000;                       // an OFFLINE spectator slot can be taken over after this long

// Abandonment: seat S wins when the other seat T has been offline for the whole grace period.
//  - `now` is the server clock, so a client cannot shorten the wait.
//  - S must have been connected the whole time: online now AND came online no later than T dropped. So if BOTH
//    players dropped, nobody can claim (the game just stays paused). S can only claim for itself.
// `winnerRef` (optional) is an expression for the winner being written; it must be S.
function forfeitFor(S, T, winnerRef) {
    return `auth.uid === ${OLD('players/' + S)}.val() && ${OLD('players/' + T)}.exists() && ` +
        `${OLD('presence/' + T + '/online')}.val() === false && ` +
        `now >= ${OLD('presence/' + T + '/at')}.val() + ${GRACE_MS} && ` +
        `${OLD('presence/' + S + '/online')}.val() === true && ` +
        `${OLD('presence/' + S + '/at')}.val() <= ${OLD('presence/' + T + '/at')}.val() && ${NOT_OVER}` +
        (winnerRef ? ` && ${winnerRef} === '${S}'` : '');
}
const FORFEIT_ANY = `((${forfeitFor('X', 'O')}) || (${forfeitFor('O', 'X')}))`;
const forfeitDirected = ref => `((${forfeitFor('X', 'O', ref)}) || (${forfeitFor('O', 'X', ref)}))`;

// Is this uid sitting in one of the spectator slots? (old data)
const IS_SPECTATOR_NOW = uid => ['s1', 's2', 's3'].map(k => `${OLD('spectators/' + k + '/uid')}.val() === ${uid}`).join(' || ');

/* ---------- cells/<board>/<k> ---------- */

function cellRule(k) {
    const others = LINES.filter(l => l.includes(k)).map(l => l.filter(x => x !== k));
    const sib = j => `newData.parent().child('${j}')`;
    const win = others.map(([a, b]) => `(${sib(a)}.val() === newData.val() && ${sib(b)}.val() === newData.val())`).join(' || ');
    const full = DIGITS.filter(j => j !== k).map(j => `${sib(j)}.exists()`).join(' && ');
    const room = 'newData.parent().parent().parent()';
    const board = `${room}.child('boards').child($b)`;

    // The small board's result must be recorded correctly: won / tied / still open.
    const boardOK = `((${win}) ? ${board}.val() === newData.val() : ((${full}) ? ${board}.val() === 'draw' : !${board}.exists()))`;

    return {
        ".write": `auth != null && newData.exists() && ${MOVE_AUTH_CORE}`,
        ".validate": [
            `$b.matches(/^[0-8]$/)`,
            `!data.exists()`,
            `newData.val() === ${OLD('state/turn')}.val()`,
            `(${OLD('game')}.val() === 'ultimate' || $b === '0')`,
            `(${OLD('state/next')}.val() === 'any' || ${OLD('state/next')}.val() === $b)`,
            `!${OLD('boards')}.child($b).exists()`,
            `${room}.child('state/lb').val() === $b`,
            `${room}.child('state/lc').val() === '${k}'`,
            boardOK
        ].join(' && ')
    };
}

/* ---------- boards/<k> ---------- */

function boardRule(k) {
    const room = 'newData.parent().parent()';
    const P = 'newData.parent()';
    const W = `${room}.child('state/winner')`;
    const m = 'newData.val()';

    const metaLines = LINES.filter(l => l.includes(k)).map(l => l.filter(x => x !== k));
    const metaWin = `((${m} === 'X' || ${m} === 'O') && (` +
        metaLines.map(([a, b]) => `(${P}.child('${a}').val() === ${m} && ${P}.child('${b}').val() === ${m})`).join(' || ') + `))`;
    const allClosed = `${P}.hasChildren([${DIGITS.map(j => "'" + j + "'").join(", ")}])`;   // all 9 boards closed
    const xb = `${room}.child('state/xb').val()`;
    const ob = `${room}.child('state/ob').val()`;

    // Ultimate: a line on the big grid wins; else when all 9 boards are closed the player with more boards wins
    // (equal = draw); else the game goes on (no winner yet).
    const ultimateWinnerOK =
        `(${metaWin} ? ${W}.val() === ${m} : (${allClosed} ? ` +
        `(${xb} > ${ob} ? ${W}.val() === 'X' : (${xb} === ${ob} ? ${W}.val() === 'draw' : ${W}.val() === 'O')) : !${W}.exists()))`;

    return {
        ".write": `auth != null && newData.exists() && ${MOVE_AUTH_CORE}`,
        ".validate": [
            `!data.exists()`,
            `(${m} === 'X' || ${m} === 'O' || ${m} === 'draw')`,
            `${room}.child('state/lb').val() === '${k}'`,
            `${room}.child('state/moves').val() === ${OLD('state/moves')}.val() + 1`,
            `(${IS_BASIC} ? ${W}.val() === ${m} : ${ultimateWinnerOK})`
        ].join(' && ')
    };
}

/* ---------- state ---------- */

function stateRule() {
    // the small board just played in, and the small board the played cell points to (the opponent's next board)
    const board = `newData.parent().child('boards').child(newData.child('lb').val())`;
    const target = `newData.parent().child('boards').child(newData.child('lc').val())`;

    const creation = [
        `!data.exists()`,
        `newData.child('moves').val() === 0`,
        `newData.child('turn').val() === 'X'`,
        `newData.child('next').val() === 'any'`,
        `newData.child('xb').val() === 0`, `newData.child('ob').val() === 0`,
        `!newData.child('lb').exists()`, `!newData.child('lc').exists()`,
        `!newData.child('winner').exists()`, `!newData.child('reason').exists()`
    ].join(' && ');

    const move = [
        `data.exists()`,
        `newData.child('moves').val() === data.child('moves').val() + 1`,
        `newData.child('turn').val() === (data.child('turn').val() === 'X' ? 'O' : 'X')`,
        `newData.child('lb').exists() && newData.child('lc').exists()`,
        `!newData.child('reason').exists()`,
        // the cell named by lb/lc must really be a NEW cell holding the mover's mark (so a move can't be faked
        // by changing only the state, e.g. to "pass" or to steer the opponent to a board of your choice)
        `newData.parent().child('cells').child(newData.child('lb').val()).child(newData.child('lc').val()).val() === data.child('turn').val()`,
        `!${OLD('cells')}.child(newData.child('lb').val()).child(newData.child('lc').val()).exists()`,
        // board counters go up by one when this move closed a board with a win
        `newData.child('xb').val() === data.child('xb').val() + (${board}.val() === 'X' ? 1 : 0)`,
        `newData.child('ob').val() === data.child('ob').val() + (${board}.val() === 'O' ? 1 : 0)`,
        // next board: where the last move's cell points, unless that board is closed (then a free turn)
        `newData.child('next').val() === (${IS_BASIC} ? 'any' : (${target}.exists() ? 'any' : newData.child('lc').val()))`,
        // a winner can only appear on a move that closed a board
        `(!newData.child('winner').exists() || ${board}.exists())`
    ].join(' && ');

    const forfeit = [
        `data.exists()`,
        `newData.child('moves').val() === data.child('moves').val()`,
        `newData.child('turn').val() === data.child('turn').val()`,
        `newData.child('next').val() === data.child('next').val()`,
        `newData.child('xb').val() === data.child('xb').val()`, `newData.child('ob').val() === data.child('ob').val()`,
        `newData.child('lb').val() === data.child('lb').val()`,
        `newData.child('lc').val() === data.child('lc').val()`,
        `!data.child('winner').exists()`,
        `(newData.child('winner').val() === 'X' || newData.child('winner').val() === 'O')`,
        `newData.child('reason').val() === 'forfeit'`
    ].join(' && ');

    return {
        ".write": `auth != null && newData.exists() && ((${MOVE_AUTH_CORE}) || ${FORFEIT_ANY})`,
        ".validate": `newData.hasChildren(['turn', 'moves', 'next', 'xb', 'ob']) && ((${creation}) || (${move}) || (${forfeit}))`,
        "turn": { ".validate": "newData.val() === 'X' || newData.val() === 'O'" },
        "moves": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 81" },
        "next": { ".validate": "newData.isString() && newData.val().matches(/^(any|[0-8])$/)" },
        "xb": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 9" },
        "ob": { ".validate": "newData.isNumber() && newData.val() >= 0 && newData.val() <= 9" },
        "lb": { ".validate": "newData.isString() && newData.val().matches(/^[0-8]$/)" },
        "lc": { ".validate": "newData.isString() && newData.val().matches(/^[0-8]$/)" },
        "winner": { ".validate": "newData.val() === 'X' || newData.val() === 'O' || newData.val() === 'draw'" },
        // "forfeit" (= abandonment) is only valid when the claimant really is entitled to it (see forfeitFor), and the
        // winner written must be the claimant. Checked here so it can't be combined with merely having the turn.
        "reason": { ".validate": `newData.val() === 'forfeit' && ${forfeitDirected("newData.parent().child('winner').val()")}` },
        "$other": { ".validate": false }
    };
}

/* ---------- spectators/<s1|s2|s3> ---------- */

const SLOTS = ['s1', 's2', 's3'];

// A slot can be written when it is empty, when it is yours, or when its owner has been offline for STALE_MS.
// Because a slot is claimed by writing to it, two people racing for the same slot can't both win (the second write
// sees an occupied slot). Max 3 watchers = 3 slots. Watchers can never write anything else in the room.
function spectatorSlotRule(k) {
    const P = 'newData.parent()';
    const R = 'newData.parent().parent()';
    const others = SLOTS.filter(x => x !== k).map(o => `${P}.child('${o}/uid').val() !== auth.uid`).join(' && ');
    return {
        ".write": "auth != null && ((newData.exists() && (!data.exists() || data.child('uid').val() === auth.uid || " +
            `(data.child('online').val() === false && now - data.child('at').val() > ${STALE_MS}))) || ` +
            "(!newData.exists() && data.child('uid').val() === auth.uid))",
        ".validate": "newData.hasChildren(['uid', 'online', 'at']) && newData.child('uid').val() === auth.uid && " +
            "newData.child('online').isBoolean() && newData.child('at').isNumber() && newData.child('at').val() <= now && " +
            `auth.uid !== ${R}.child('players/X').val() && auth.uid !== ${R}.child('players/O').val() && ${others}`,
        "uid": { ".validate": "newData.isString()" },
        "online": { ".validate": "newData.isBoolean()" },
        "at": { ".validate": "newData.isNumber()" },
        "$other": { ".validate": false }
    };
}
const spectators = { "$other": { ".validate": false } };
SLOTS.forEach(k => { spectators[k] = spectatorSlotRule(k); });

/* ---------- assemble ---------- */

const cells = {};
DIGITS.forEach(k => { cells[String(k)] = cellRule(k); });

const boards = {};
DIGITS.forEach(k => { boards[String(k)] = boardRule(k); });

const rules = {
    rules: {
        ".read": false,
        ".write": false,
        "rooms": {
            // No rule on "rooms" itself, so nobody can list rooms. You can only read a room if you know its code.
            "$room": {
                ".read": "auth != null",

                // Whole-room writes: create a brand-new room (you become the host) or delete your own room.
                ".write": "auth != null && $room.matches(/^[A-HJ-NP-Z2-9]{6}$/) && (" +
                    "(!data.exists() && newData.exists() && newData.child('host').val() === auth.uid" +
                    " && !newData.child('players/O').exists() && !newData.child('presence/O').exists()" +
                    " && !newData.child('cells').exists() && !newData.child('boards').exists() && !newData.child('spectators').exists())" +
                    " || (data.exists() && !newData.exists() && data.child('host').val() === auth.uid))",
                ".validate": "newData.hasChildren(['game', 'host', 'createdAt', 'players', 'presence', 'state'])",

                "game": { ".validate": "newData.val() === 'basic' || newData.val() === 'ultimate'" },
                "host": { ".validate": "newData.val() === auth.uid" },
                "createdAt": { ".validate": "newData.val() === now" },

                "players": {
                    "X": { ".validate": "newData.val() === auth.uid" },
                    // The guest claims seat O exactly once, before any move has been played.
                    "O": {
                        ".write": `auth != null && newData.exists() && !data.exists() && newData.val() === auth.uid` +
                            ` && auth.uid !== ${OLD('players/X')}.val() && ${OLD('state/moves')}.val() === 0 && ${NOT_OVER}` +
                            ` && !(${IS_SPECTATOR_NOW('auth.uid')})`,
                        ".validate": "newData.isString()"
                    },
                    "$other": { ".validate": false }
                },

                // Each player writes only their own presence.
                "presence": {
                    "$seat": {
                        ".write": "auth != null && newData.exists() && ($seat === 'X' || $seat === 'O') && " +
                            "newData.parent().parent().child('players').child($seat).val() === auth.uid",
                        ".validate": "($seat === 'X' || $seat === 'O') && newData.hasChildren(['online', 'at']) && " +
                            "newData.child('online').isBoolean() && newData.child('at').isNumber() && newData.child('at').val() <= now",
                        "online": { ".validate": "newData.isBoolean()" },
                        "at": { ".validate": "newData.isNumber()" },
                        "$other": { ".validate": false }
                    }
                },

                "state": stateRule(),
                "spectators": spectators,

                // After the game is over either player can point the room at a fresh room that THEY created
                // (same game type). The other player then joins it. Written once, never changed.
                "rematch": {
                    ".write": `auth != null && newData.exists() && !data.exists() && ` +
                        `(auth.uid === ${OLD('players/X')}.val() || auth.uid === ${OLD('players/O')}.val()) && ${OLD('state/winner')}.exists()`,
                    ".validate": `newData.isString() && newData.val().matches(/^[A-HJ-NP-Z2-9]{6}$/) && newData.val() !== $room && ` +
                        `root.child('rooms').child(newData.val()).child('host').val() === auth.uid && ` +
                        `root.child('rooms').child(newData.val()).child('game').val() === ${OLD('game')}.val()`
                },

                "cells": { "$b": cells },
                "boards": boards,

                "$other": { ".validate": false }
            }
        }
    }
};

const out = path.join(__dirname, "database.rules.json");
fs.writeFileSync(out, JSON.stringify(rules, null, 2) + "\n");
let longest = 0;
(function walk(o) {
    for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string" && k.startsWith(".")) longest = Math.max(longest, v.length);
        else if (v && typeof v === "object") walk(v);
    }
})(rules);
console.log("wrote", out, "(" + fs.statSync(out).size + " bytes, longest rule expression ~" + longest + " chars)");
