/*
 * UI tests for: Home = leaving the match, spectators, green/yellow board highlights, both-players-dropped.
 *   cd firebase && npm run test:features
 */
const { FakeServer } = require("./fake-firebase");
const { load, sleep, settle } = require("./page-harness");

let pass = 0, fail = 0;
const failures = [];
let lastName = "(start)";
process.on("uncaughtException", e => { console.log("UNCAUGHT after check: " + lastName + "\n" + String(e.stack).split("\n").slice(0, 4).join("\n")); process.exit(1); });
const ok = (name, cond, extra) => { lastName = name; if (cond) pass++; else { fail++; failures.push(name + (extra !== undefined ? "  -> " + extra : "")); } };

const ULT = "UltimateTicTacToe.html", BAS = "BasicTicTacToe.html";
function device(server, uid, page, extra) {
    const browser = server.browser(uid, (extra && extra.restored) ? { restored: true } : {});
    const p = load(page, Object.assign({ prefs: { mode: "online" }, firebase: browser.firebase, now: () => server.now(), onClose: () => browser.dispose() }, extra));
    p.browser = browser;
    p.cell = (b, c) => page === BAS ? p.$("C" + c) : p.$("C" + b + "-" + c);
    p.marks = () => [...p.d.querySelectorAll(".cell")].map(c => c.textContent).join("");
    p.active = () => [...p.d.querySelectorAll(".cellContainer.active")].map(e => e.id);
    p.mine = () => [...p.d.querySelectorAll(".cellContainer.active.mine")].map(e => e.id);
    p.stateFor = () => ({ saved: JSON.parse(p.w.localStorage.getItem("ttt-online-room")), prefs: JSON.parse(p.w.localStorage.getItem("ttt-options")) });
    return p;
}
async function tap(p, b, c) { p.cell(b, c).dispatchEvent(new p.w.Event("click")); await settle(); }
async function pair(server, page) {
    const host = device(server, "host-uid", page), guest = device(server, "guest-uid", page);
    await settle();
    host.click("createRoomBtn"); await settle();
    const code = host.text("roomCodeText");
    guest.type("roomCodeInput", code); guest.click("joinRoomBtn"); await settle();
    return { host, guest, code };
}
async function watcher(server, uid, page, code) {
    const w = device(server, uid, page);
    await settle();
    w.type("roomCodeInput", code); w.click("spectateBtn"); await settle();
    return w;
}
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
function homeClick(p) { return p.$("homeLink").dispatchEvent(new p.w.MouseEvent("click", { bubbles: true, cancelable: true })); }   // false = the page stopped the navigation

(async () => {
    /* =============== green / yellow highlights =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, ULT);
        const w = await watcher(server, "w1-uid", ULT, code);

        ok("first move: every board is playable, host sees GREEN, guest sees YELLOW, watcher sees YELLOW",
            host.active().length === 9 && host.mine().length === 9 && guest.active().length === 9 && guest.mine().length === 0 && w.active().length === 9 && w.mine().length === 0,
            [host.mine().length, guest.mine().length, w.mine().length]);
        await tap(host, 4, 4);
        ok("one required board: only the center board is highlighted for everybody", same(host.active(), ["C4"]) && same(guest.active(), ["C4"]) && same(w.active(), ["C4"]), JSON.stringify([host.active(), guest.active(), w.active()]));
        ok("turn passed: now the GUEST sees green and the HOST sees yellow", same(guest.mine(), ["C4"]) && host.mine().length === 0 && w.mine().length === 0);
        ok("waiting player and watcher can't interact (cells locked), current player can", host.cell(4, 0).classList.contains("disabled") && w.cell(4, 0).classList.contains("disabled") && !guest.cell(4, 0).classList.contains("disabled"));
        ok("the highlight is a border (dashed yellow / solid green) not only a fill: classes drive both", guest.$("C4").classList.contains("mine") && !host.$("C4").classList.contains("mine"));

        for (const [who, b, c] of [[guest, 4, 0], [host, 0, 4], [guest, 4, 1], [host, 1, 4], [guest, 4, 2]]) await tap(who, b, c);
        ok("after a small-board win the next board is the one the cell pointed to", same(host.active(), ["C2"]) && same(host.mine(), ["C2"]) && same(w.active(), ["C2"]) && w.mine().length === 0);
        await tap(host, 2, 4);                                                    // points at board 4, which is won -> free choice
        const open = ["C0", "C1", "C2", "C3", "C5", "C6", "C7", "C8"];
        ok("free choice: EVERY open board is highlighted (not just one), the won board is not", same(guest.active(), open) && same(host.active(), open) && same(w.active(), open), JSON.stringify(guest.active()));
        ok("free choice colours: guest green on all, host yellow, watcher yellow", same(guest.mine(), open) && host.mine().length === 0 && w.mine().length === 0);

        // refresh and late joiners get the right colours straight away
        const w2 = await watcher(server, "w2-uid", ULT, code);
        ok("a spectator joining mid-game sees the same yellow boards", same(w2.active(), open) && w2.mine().length === 0);
        const saved = host.stateFor();
        host.browser.disconnect(); host.close(); await settle();
        ok("host away: the highlights are removed while the game is paused", guest.active().length === 0 && w.active().length === 0 && w2.active().length === 0, JSON.stringify(guest.active()));
        const host2 = device(server, "host-uid", ULT, { restored: true, prefs: saved.prefs, saved: saved.saved }); await settle();
        ok("after a refresh the host sees the right yellow boards again", same(host2.active(), open) && host2.mine().length === 0 && same(guest.mine(), open));

        // game over: highlights gone
        guest.browser.disconnect(); await settle();
        server.advance(120500); await sleep(700);
        ok("match over: no highlights anywhere", host2.active().length === 0 && w.active().length === 0 && w2.active().length === 0);
        host2.close(); guest.close(); w.close(); w2.close();
    }

    /* =============== spectators =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, ULT);
        await tap(host, 4, 4);
        const w1 = await watcher(server, "w1-uid", ULT, code);
        ok("spectator: lands at the board with a 'Spectator Mode' label", w1.d.querySelector(".gameContainer").classList.contains("inGame") && w1.visible("spectatorBadge") && /Spectator Mode/i.test(w1.text("spectatorBadge")));
        ok("spectator: sees the position, both players and the room code", w1.cell(4, 4).textContent === "X" && w1.text("barYou") === "Host (X)" && w1.text("barOpp") === "Guest (O)" && w1.text("barCode") === code);
        ok("spectator: neutral turn text", /^O's turn \(Guest\) - plays in the center board/.test(w1.status()), w1.status());
        ok("spectator: players see the count", /Spectators: 1\/3/.test(host.text("barSpectators")) && /Spectators: 1\/3/.test(guest.text("barSpectators")) && /Spectators: 1\/3/.test(w1.text("barSpectators")), host.text("barSpectators"));
        ok("spectator: only Leave is offered (no Reset / Rematch / Claim)", w1.visible("leaveBtn") && !w1.visible("rematchBtn") && !w1.visible("claimBtn") && !w1.visible("restartBtn"));
        ok("players have no spectator label", !host.visible("spectatorBadge"));
        await tap(w1, 4, 0);
        ok("spectator: tapping gives a message and changes nothing", /Spectators can't play/.test(w1.status()) && server.value("rooms/" + code).state.moves === 1);

        await tap(guest, 4, 0);
        ok("spectator: sees live moves", w1.cell(4, 0).textContent === "O" && /^X's turn \(Host\)/.test(w1.status()), w1.status());

        const w2 = await watcher(server, "w2-uid", ULT, code), w3 = await watcher(server, "w3-uid", ULT, code);
        ok("3 spectators: counter says 3/3 everywhere", /3\/3/.test(host.text("barSpectators")) && /3\/3/.test(w3.text("barSpectators")));
        const w4 = await watcher(server, "w4-uid", ULT, code);
        ok("4th spectator is refused with a clear message and stays in the lobby", /already has 3 spectators/.test(w4.text("onlineMessage")) && w4.visible("onlineStart") && !w4.visible("roomBar"), w4.text("onlineMessage"));
        const late = device(server, "late-uid", ULT); await settle();
        late.type("roomCodeInput", code); late.click("joinRoomBtn"); await settle();
        ok("joining as a player on a full room suggests Spectate", /already full/.test(late.text("onlineMessage")) && /Spectate/.test(late.text("onlineMessage")), late.text("onlineMessage"));
        late.close();

        // spectators are not players: leaving or dropping doesn't pause anything or start any countdown
        w2.browser.disconnect(); await settle();
        ok("a watcher dropping does not pause the match or start a countdown", /Your turn \(X\)/.test(host.status()) && !/disconnected/i.test(host.status()) && !/disconnected/i.test(guest.status()) && /Spectators: 2\/3/.test(host.text("barSpectators")), host.status() + " | " + host.text("barSpectators"));
        // refresh: same slot back
        const sv = w2.stateFor();
        ok("the watcher's saved room remembers the spectator role", sv.saved.role === "spectator");
        w2.close();
        const w2b = device(server, "w2-uid", ULT, { restored: true, prefs: sv.prefs, saved: sv.saved }); await settle();
        ok("a refreshing watcher returns to the match without using a 4th slot", w2b.visible("spectatorBadge") && Object.keys(server.value("rooms/" + code).spectators).length === 3 && /Spectators: 3\/3/.test(host.text("barSpectators")), host.text("barSpectators"));

        // leaving frees a slot
        w1.click("leaveBtn"); await settle();
        ok("leaving frees the slot at once and goes back to the lobby", w1.visible("onlineStart") && /Spectators: 2\/3/.test(host.text("barSpectators")));
        const w4b = await watcher(server, "w4-uid", ULT, code);
        ok("the freed slot can be taken by the waiting person", w4b.visible("spectatorBadge") && /Spectators: 3\/3/.test(host.text("barSpectators")));

        // Home as a spectator = leave, no warning
        let asked = false; w3.w.confirm = () => { asked = true; return true; };
        const allowedNav = homeClick(w3); await settle();
        ok("Home as a spectator: no warning, slot freed", asked === false && allowedNav === false && /Spectators: 2\/3/.test(host.text("barSpectators")));

        // results from a neutral view + following a rematch
        guest.browser.disconnect(); await settle();
        server.advance(120500); await sleep(700);
        ok("spectator sees a neutral abandonment result", /^Host \(X\) wins: the other player didn't come back within 2 minutes\./.test(w4b.status()), w4b.status());
        ok("spectator: highlights gone at the end", w4b.active().length === 0);
        guest.browser.reconnect(); await settle();
        host.click("rematchBtn"); await settle();
        ok("spectator is offered 'Watch rematch'", w4b.visible("rematchBtn") && w4b.text("rematchBtn") === "Watch rematch", w4b.text("rematchBtn"));
        w4b.click("rematchBtn"); await settle();
        ok("the watcher follows to the new room (waiting for the second player)", w4b.text("barCode") === host.text("roomCodeText") && /Waiting for the second player/.test(w4b.status()), w4b.status());
        guest.click("rematchBtn"); await settle();
        ok("...and sees the rematch start", /X's turn \(Host\)/.test(w4b.status()) && w4b.marks() === "", w4b.status());
        [host, guest, w1, w2b, w3, w4, w4b].forEach(p => p.close());
    }
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, BAS);
        const w = await watcher(server, "w1-uid", BAS, code);
        await tap(host, 0, 4);
        ok("basic: spectator sees the board and the turn", w.cell(0, 4).textContent === "X" && w.status() === "O's turn (Guest)", w.status());
        for (const [who, c] of [[guest, 0], [host, 1], [guest, 3], [host, 7]]) await tap(who, 0, c);
        ok("basic: spectator sees a neutral result with the big mark", w.status() === "X wins the game!" && w.$("overlay").style.display === "flex", w.status());
        [host, guest, w].forEach(p => p.close());
    }

    /* =============== Home = leaving the match =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, ULT);
        await tap(host, 4, 4);
        let asked = "";
        host.w.confirm = q => { asked = q; return false; };
        const proceeded = homeClick(host); await settle();
        ok("Home during a match asks first, with the exact wording", asked === "Are you sure you want to leave? Your opponent may win if you don't return within 2 minutes.", asked);
        ok("Cancel keeps you in the match: navigation stopped, still online, opponent sees nothing", proceeded === false && server.value("rooms/" + code + "/presence/X").online === true && /Your turn \(O\)/.test(guest.status()), guest.status());

        host.w.confirm = () => true;
        homeClick(host); await settle();
        ok("OK: the opponent immediately sees the countdown", server.value("rooms/" + code + "/presence/X").online === false && /Opponent disconnected\. Waiting for reconnection: 02:00/.test(guest.status()), guest.status());
        ok("the room is not deleted and the saved room is kept", server.value("rooms/" + code) !== null && JSON.parse(host.w.localStorage.getItem("ttt-online-room")).code === code);
        ok("the match state is untouched", server.value("rooms/" + code).state.moves === 1 && server.value("rooms/" + code).cells[4][4] === "X");

        // comes back within 120 s: resumes
        const back = host.stateFor();
        host.browser.disconnect(); host.close(); server.advance(90000);
        const host2 = device(server, "host-uid", ULT, { restored: true, prefs: back.prefs, saved: back.saved }); await settle();
        ok("returning within 120 s resumes the same match", host2.visible("roomBar") && host2.cell(4, 4).textContent === "X" && /Your turn|Opponent's turn/.test(guest.status()) && !/disconnected/.test(guest.status()), guest.status());

        // does not come back: the opponent wins
        homeClick(host2); host2.w.confirm = () => true; homeClick(host2); await settle();
        host2.browser.disconnect(); host2.close();
        server.advance(120500); await sleep(700);
        ok("not returning: the opponent wins by abandonment", /^You win! Your opponent abandoned the match/.test(guest.status()) && server.value("rooms/" + code).state.winner === "O", guest.status());
        guest.close();
    }
    {
        const server = new FakeServer(Date.now());
        // not an active match: no warning
        const h = device(server, "host-uid", ULT); await settle();
        h.click("createRoomBtn"); await settle();
        let asked = false; h.w.confirm = () => { asked = true; return false; };
        const nav = homeClick(h); await settle();
        const code = h.text("roomCodeText");
        ok("Home while waiting alone: no warning, room kept", nav === true && asked === false && server.value("rooms/" + code) !== null);
        const g = device(server, "guest-uid", ULT); await settle();
        g.type("roomCodeInput", code); g.click("joinRoomBtn"); await settle();
        // game over: no warning
        h.browser.disconnect(); await settle(); server.advance(120500); await sleep(700);
        h.browser.reconnect(); await settle();
        asked = false; g.w.confirm = () => { asked = true; return false; };
        const nav2 = homeClick(g); await settle();
        ok("Home after the match has finished: no warning, nothing to abandon", nav2 === true && asked === false);
        // offline modes: plain link
        const off = load(ULT, {}); await settle();
        ok("local / computer modes: Home is a plain link with no dialog", homeClick(off) === true);
        const cpu = load(ULT, { prefs: { mode: "computer", difficulty: "easy", side: "X" } }); await settle();
        ok("vs Computer: Home is a plain link with no dialog", homeClick(cpu) === true);
        [h, g, off, cpu].forEach(p => p.close());
    }

    /* =============== both players dropped =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, ULT);
        await tap(host, 4, 4);
        host.browser.disconnect(); server.advance(3000); guest.browser.disconnect(); await settle();
        const w = await watcher(server, "w1-uid", ULT, code);
        ok("both away: a spectator is told the game is paused", /Both players are disconnected/.test(w.status()) && w.active().length === 0, w.status());
        server.advance(400000);
        guest.browser.reconnect(); await sleep(700);
        ok("one returns after both dropped: no automatic win, a clear explanation", /nobody wins by abandonment/.test(guest.status()) && server.value("rooms/" + code).state.winner === undefined, guest.status());
        host.browser.reconnect(); await settle();
        ok("when the other returns the game resumes", /Your turn \(O\)/.test(guest.status()) && /Your turn|Opponent's turn/.test(host.status()) && guest.mine().length === 1, guest.status());
        [host, guest, w].forEach(p => p.close());
    }

    /* =============== offline highlight colours =============== */
    {
        const local = load(ULT, {}); await settle();
        local.$("C4-4").dispatchEvent(new local.w.Event("click"));
        ok("local 2-player Ultimate: the player to move sees GREEN", local.$("C4").classList.contains("active") && local.$("C4").classList.contains("mine"));
        local.close();
        const cpu = load(ULT, { prefs: { mode: "computer", difficulty: "hard", side: "X" } }); await settle();
        cpu.$("C4-4").dispatchEvent(new cpu.w.Event("click"));
        ok("vs Computer: while the computer thinks the highlight is YELLOW", cpu.$("C4").classList.contains("active") && !cpu.$("C4").classList.contains("mine"));
        await sleep(900);
        ok("vs Computer: back to GREEN on the human's turn", cpu.d.querySelectorAll(".cellContainer.active.mine").length >= 1);
        cpu.close();
    }

    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
