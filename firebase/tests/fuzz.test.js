/*
 * Mutation fuzzer for the security rules:  cd firebase && npm run fuzz
 *
 * Plays random games. At random positions it takes the honest update for a legal move, corrupts ONE thing
 * (a state field, a board result, a mark, a cell location, an extra/missing key...) and submits it as the player
 * whose turn it is. The rules must reject it unless the corrupted update happens to be identical to a different
 * honest move. Any "allowed" result that is not an honest move is a hole in the rules.
 */
const targaryen = require("targaryen");
const rules = require("../database.rules.json");
const Core = require("../../MultiplayerCore.js");
const Bot = require("../../Bot.js");
const E = Bot.ultimate._engine;

const T0 = 1700000000000, SV = { ".sv": "timestamp" }, CODE = "ABCD23", ROOM = "/rooms/" + CODE;
const GAMES = Number(process.env.FUZZ_GAMES || 60), PER_POSITION = Number(process.env.FUZZ_PER || 12);
const U = { X: { uid: "host-uid" }, O: { uid: "guest-uid" } };
const rnd = n => Math.floor(Math.random() * n);
const pick = a => a[rnd(a.length)];
const canon = o => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v)) ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const clone = o => JSON.parse(JSON.stringify(o));

function mutate(u, room) {
    const m = clone(u);
    const st = m.state;
    const kind = rnd(14);
    switch (kind) {
        case 0: st.turn = st.turn === "X" ? "O" : "X"; break;
        case 1: st.moves += pick([-2, -1, 1, 2, 10]); break;
        case 2: st.next = pick(["any", "0", "1", "2", "3", "4", "5", "6", "7", "8"]); break;
        case 3: st.lb = String(rnd(9)); break;
        case 4: st.lc = String(rnd(9)); break;
        case 5: st.xb += pick([-1, 1, 2]); break;
        case 6: st.ob += pick([-1, 1, 2]); break;
        case 7: if (st.winner) delete st.winner; else st.winner = pick(["X", "O", "draw"]); break;
        case 8: { const k = "boards/" + rnd(9); if (m[k]) m[k] = pick(["X", "O", "draw", null].filter(v => v !== m[k])); else m[k] = pick(["X", "O", "draw"]); break; }
        case 9: { const key = Object.keys(m).find(k => k.startsWith("cells/")); m[key] = m[key] === "X" ? "O" : "X"; break; }
        case 10: { m["cells/" + rnd(9) + "/" + rnd(9)] = pick(["X", "O"]); break; }                 // a second cell
        case 11: { const key = Object.keys(m).find(k => k.startsWith("cells/")); const v = m[key]; delete m[key]; m["cells/" + rnd(9) + "/" + rnd(9)] = v; break; }   // cell moved elsewhere
        case 12: delete m.state; break;
        case 13: { const key = Object.keys(m).find(k => k.startsWith("cells/")); delete m[key]; break; }
    }
    return m;
}

let attempts = 0, honestSkipped = 0, holes = 0;
const holeReports = [];
const t0 = Date.now();

for (let g = 0; g < GAMES; g++) {
    const game = g % 5 === 4 ? "basic" : "ultimate";
    let db = targaryen.database(rules, {}, T0);
    const step = (seat, path, patch, now) => db.as(U[seat]).update(path, patch, { now: now || T0 });
    let r = db.as(U.X).write(ROOM, Core.newRoom(game, "host-uid", SV), { now: T0 }); db = r.newDatabase;
    r = db.as(U.O).update(ROOM, Core.joinUpdate("guest-uid", SV), { now: T0 }); db = r.newDatabase;

    for (let n = 0; n < 90; n++) {
        const room = db.snapshot(ROOM).val();
        if (room.state.winner) break;
        const seat = room.state.turn;
        const legal = [];
        for (let i = 0; i < 81; i++) { const b = (i / 9) | 0, c = i % 9; if (Core.moveError(room, b, c, seat) === null) legal.push([b, c]); }
        if (!legal.length) break;
        const honest = new Set(legal.map(([b, c]) => canon(Core.buildMoveUpdate(room, b, c))));

        if (Math.random() < 0.35) {
            for (let k = 0; k < PER_POSITION; k++) {
                const [b, c] = pick(legal);
                const bad = mutate(Core.buildMoveUpdate(room, b, c), room);
                if (honest.has(canon(bad))) { honestSkipped++; continue; }
                attempts++;
                const res = db.as(U[seat]).update(ROOM, bad, { now: T0 });
                if (res.allowed) { holes++; if (holeReports.length < 5) holeReports.push(`${game}: ${canon(bad)}\n      on position moves=${room.state.moves} next=${room.state.next} turn=${room.state.turn}`); }
                // and the same corrupted update from the OTHER player must also fail
                const other = db.as(U[seat === "X" ? "O" : "X"]).update(ROOM, bad, { now: T0 });
                attempts++;
                if (other.allowed) { holes++; if (holeReports.length < 5) holeReports.push(`(wrong player) ${game}: ${canon(bad)}`); }
            }
        }
        // continue the game with an honest move
        const [b, c] = pick(legal);
        const ok = db.as(U[seat]).update(ROOM, Core.buildMoveUpdate(room, b, c), { now: T0 });
        if (!ok.allowed) { console.log("honest move rejected during fuzz!", game, b, c, String(ok.info).split("\n")[0]); process.exit(1); }
        db = ok.newDatabase;
    }
}
/* ---- abandonment oracle: random presence situations, any actor, any claim, any time ---- */
// Expected rule: seat S wins iff the OTHER seat is offline for >= 120 s (server clock), S is online and has been since
// before the other dropped (S.at <= other.at), the game isn't over, and S claims for itself (winner = S, reason = forfeit).
let forfeitChecks = 0;
for (let i = 0; i < Number(process.env.FORFEIT_CASES || 600); i++) {
    const now = T0 + 5000000;
    const ats = [now - 600000, now - 130000, now - 120000, now - 119999, now - 60000, now - 1, T0 + 10];
    const turn = pick(["X", "O"]);
    const xOnline = Math.random() < 0.5, oOnline = Math.random() < 0.5;
    const xAt = pick(ats), oAt = pick(ats);
    const over = Math.random() < 0.1;
    const room = {
        game: "ultimate", host: "host-uid", createdAt: T0, players: { X: "host-uid", O: "guest-uid" },
        presence: { X: { online: xOnline, at: xAt }, O: { online: oOnline, at: oAt } },
        state: Object.assign({ turn, moves: 4, next: "any", xb: 0, ob: 0, lb: "4", lc: "4" }, over ? { winner: "O" } : {})
    };
    const db = targaryen.database(rules, { rooms: { [CODE]: room } }, now);
    const actor = pick(["X", "O", "eve"]);
    const who = actor === "eve" ? { uid: "eve-uid" } : U[actor];
    const variants = [
        { winner: "X", patch: Core.buildForfeitUpdate(room, "X") },
        { winner: "O", patch: Core.buildForfeitUpdate(room, "O") },
        { winner: "X", patch: { state: Object.assign({}, room.state, { winner: "X" }) } },                          // no reason
        { winner: "O", patch: { state: Object.assign({}, room.state, { winner: "O" }) } }
    ];
    const v = pick(variants);
    const hasReason = !!v.patch.state.reason;
    const res = db.as(who).update(ROOM, v.patch, { now });

    const me = actor === "X" ? { on: xOnline, at: xAt } : { on: oOnline, at: oAt };
    const them = actor === "X" ? { on: oOnline, at: oAt } : { on: xOnline, at: xAt };
    const expected = (actor === "X" || actor === "O") && hasReason && v.winner === actor && !over &&
        !them.on && now >= them.at + 120000 && me.on && me.at <= them.at;
    forfeitChecks++;
    if (res.allowed !== expected) {
        holes++;
        if (holeReports.length < 5) holeReports.push(`abandonment oracle: actor=${actor} winner=${v.winner} reason=${hasReason} turn=${turn} X=${xOnline}@${now - xAt} O=${oOnline}@${now - oAt} over=${over} -> ${res.allowed ? "ALLOWED" : "DENIED"} but expected ${expected ? "ALLOWED" : "DENIED"}`);
    }
}
console.log(`Abandonment oracle: ${forfeitChecks} random presence situations checked`);

console.log(`Fuzz: ${GAMES} games, ${attempts} corrupted updates submitted, ${honestSkipped} skipped (equal to another honest move), ${Math.round((Date.now() - t0) / 1000)}s`);
if (holes) { console.log(`HOLES FOUND: ${holes} corrupted updates were accepted:\n - ` + holeReports.join("\n - ")); process.exit(1); }
console.log("No corrupted update was accepted.");
