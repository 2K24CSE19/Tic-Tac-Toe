/*
 * Tests of online PLAY on the real game pages: two simulated devices tap cells, the fake server enforces the real
 * security rules.   cd firebase && npm run test:play
 */
const { FakeServer } = require("./fake-firebase");
const { load, sleep, settle } = require("./page-harness");

let pass = 0, fail = 0;
const failures = [];
let lastName = "(start)";
process.on("uncaughtException", e => { console.log("UNCAUGHT after check: " + lastName + "\n" + String(e.stack).split("\n").slice(0, 4).join("\n")); process.exit(1); });
const ok = (name, cond, extra) => { lastName = name; if (cond) pass++; else { fail++; failures.push(name + (extra !== undefined ? "  -> " + extra : "")); } };

function device(server, uid, page, extra) {
    const browser = server.browser(uid, (extra && extra.restored) ? { restored: true } : {});
    const p = load(page, Object.assign({ prefs: { mode: "online" }, firebase: browser.firebase, now: () => server.now(), onClose: () => browser.dispose() }, extra));
    p.browser = browser;
    p.cell = (b, c) => page === "BasicTicTacToe.html" ? p.$("C" + c) : p.$("C" + b + "-" + c);
    p.marks = () => [...p.d.querySelectorAll(".cell")].map(c => c.textContent).join("");
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

(async () => {
    /* =============== ULTIMATE: a game of taps =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, "UltimateTicTacToe.html");
        ok("start: board is visible, lobby hidden, room bar shows the code", host.d.querySelector(".gameContainer").classList.contains("inGame") && host.text("barCode") === code && !host.visible("onlinePanel"));
        ok("start: Reset hidden, Leave visible, mode link hidden", !host.visible("restartBtn") && host.visible("leaveBtn") && host.d.querySelector(".modeLink").hidden);
        ok("start: host can tap, guest is locked", !host.cell(4, 4).classList.contains("disabled") && guest.cell(4, 4).classList.contains("disabled"));

        await tap(guest, 4, 4);
        ok("out of turn: the guest's tap is refused with a message", /not your turn/.test(guest.status()) && guest.cell(4, 4).textContent === "" && server.value("rooms/" + code).state.moves === 0, guest.status());

        await tap(host, 4, 4);
        ok("move: shows on both screens", host.cell(4, 4).textContent === "X" && guest.cell(4, 4).textContent === "X");
        ok("move: last move is outlined on both", host.cell(4, 4).classList.contains("lastMove") && guest.cell(4, 4).classList.contains("lastMove"));
        ok("move: statuses follow the turn", /^Opponent's turn \(O\) - they play in the center board/.test(host.status()) && /^Your turn \(O\) - play in the center board/.test(guest.status()), host.status() + " | " + guest.status());
        ok("move: the center board is highlighted for both", guest.$("C4").classList.contains("active") && !guest.$("C0").classList.contains("active") && host.$("C4").classList.contains("active"));
        ok("move: guest may now tap, host may not", !guest.cell(4, 0).classList.contains("disabled") && host.cell(4, 0).classList.contains("disabled"));

        await tap(guest, 0, 0);
        ok("wrong board: refused with an explanation", /highlighted board/.test(guest.status()) && guest.cell(0, 0).textContent === "", guest.status());
        await tap(host, 4, 0);
        ok("host can't play during the guest's turn", host.cell(4, 0).textContent === "" && /not your turn/.test(host.status()));

        // O plays 4-0, X 0-4, O 4-1, X 1-4, O 4-2: O completes the top row of board 4
        for (const [who, b, c] of [[guest, 4, 0], [host, 0, 4], [guest, 4, 1], [host, 1, 4], [guest, 4, 2]]) await tap(who, b, c);
        ok("small board: O wins the center board on both screens", ["C4"].every(id => [host, guest].every(p => p.$(id).classList.contains("wonO") && p.$(id).dataset.winner === "O")));
        ok("small board: score counter went up", server.value("rooms/" + code).state.ob === 1 && server.value("rooms/" + code).boards[4] === "O");
        ok("small board: O's last cell sent X to the top-right board", /^Your turn \(X\) - play in the top-right board/.test(host.status()), host.status());

        await tap(host, 2, 4);                                              // X plays cell 4 -> points at board 4, which is closed
        ok("free turn: sent to a won board, so O may play anywhere", /^Your turn \(O\) - play in any open board/.test(guest.status()) && /^Opponent's turn \(O\) - they play in any open board/.test(host.status()), guest.status());
        ok("free turn: every open board is highlighted, the won one is not", guest.$("C0").classList.contains("active") && guest.$("C8").classList.contains("active") && !guest.$("C4").classList.contains("active"));
        await tap(guest, 4, 5);
        ok("closed board: tapping inside it is refused", /isn't available/.test(guest.status()) && guest.cell(4, 5).textContent === "");
        await tap(guest, 8, 8);
        ok("free turn: playing anywhere works", guest.cell(8, 8).textContent === "O" && host.cell(8, 8).textContent === "O");

        /* ---- the guest's connection drops mid-game: the game pauses ---- */
        guest.browser.disconnect(); await settle();
        ok("pause: host sees the countdown and the board locks", /Waiting for reconnection: 02:00/.test(host.status()) && host.cell(0, 0).classList.contains("disabled"), host.status());
        ok("pause: nothing is highlighted while paused", !host.$("C0").classList.contains("active"));
        await tap(host, 8, 8);
        await tap(host, 0, 0);
        ok("pause: taps are refused", /paused/.test(host.status()) && host.cell(0, 0).textContent === "", host.status());
        server.advance(5000);
        guest.browser.reconnect(); await settle();
        ok("pause: game resumes when the guest returns", /^Opponent's turn \(O\)|^Your turn \(X\)/.test(host.status()) && !/disconnected/.test(host.status()), host.status());

        /* ---- the host refreshes the page mid-game: the position is still there ---- */
        const before = host.marks();
        const saved = { prefs: JSON.parse(host.w.localStorage.getItem("ttt-options")), saved: JSON.parse(host.w.localStorage.getItem("ttt-online-room")) };
        host.browser.disconnect(); host.close(); await settle();
        ok("refresh: guest sees the game paused", /Opponent disconnected\. Waiting for reconnection/.test(guest.status()), guest.status());
        const host2 = device(server, "host-uid", "UltimateTicTacToe.html", { restored: true, prefs: saved.prefs, saved: saved.saved });
        await settle();
        ok("refresh: the whole position is restored", host2.marks() === before && host2.$("C4").classList.contains("wonO"), host2.marks());
        ok("refresh: it is still the right player's turn", /^Opponent's turn \(O\)|^Your turn \(X\)/.test(host2.status()), host2.status());

        /* ---- forfeit: the guest stays away for 120 seconds ---- */
        guest.browser.disconnect(); await settle();
        server.advance(119000); await sleep(700);
        ok("forfeit: no claim button before 120 s", !host2.visible("claimBtn"));
        server.advance(1500); await sleep(700);
        ok("forfeit: after 120 s the win is claimed automatically (no button needed)", /^You win! Your opponent abandoned the match/.test(host2.status()) && server.value("rooms/" + code).state.reason === "forfeit", host2.status());
        ok("forfeit: board is locked and Rematch is offered", host2.visible("rematchBtn") && host2.cell(0, 0).classList.contains("disabled") && !host2.visible("claimBtn"));
        guest.browser.reconnect(); await settle();
        ok("forfeit: the returning guest is told what happened", /^You lost\. You were away for more than 2 minutes/.test(guest.status()) && guest.visible("rematchBtn"), guest.status());
        await tap(guest, 0, 0);
        ok("forfeit: no more moves", /over/i.test(guest.status()) || guest.cell(0, 0).textContent === "");

        /* ---- rematch ---- */
        const oldCode = code;
        host2.click("rematchBtn"); await settle();
        const newCode = host2.text("roomCodeText");
        ok("rematch: host is waiting in a new room", newCode !== oldCode && /Waiting for your opponent to join the rematch/.test(host2.status()) && host2.visible("onlineRoom") && !host2.visible("roomBar"), host2.status());
        ok("rematch: guest is offered 'Join rematch'", guest.text("rematchBtn") === "Join rematch", guest.text("rematchBtn"));
        guest.click("rematchBtn"); await settle();
        ok("rematch: both are at a fresh board in the new room", host2.marks().replace(/ /g, "") === "" && guest.marks() === "" && host2.text("barCode") === newCode && guest.text("barCode") === newCode, host2.marks());
        ok("rematch: host is X again and moves first", /^Your turn \(X\) - play in any open board/.test(host2.status()) && /^Opponent's turn \(X\)/.test(guest.status()), host2.status() + " | " + guest.status());
        ok("rematch: no leftover big marks or outlines", !host2.d.querySelector(".wonO") && !host2.d.querySelector(".lastMove") && !guest.d.querySelector(".wonO"));
        await tap(host2, 3, 3);
        ok("rematch: play continues", guest.cell(3, 3).textContent === "X");
        ok("rematch: refresh would return to the new room", JSON.parse(host2.w.localStorage.getItem("ttt-online-room")).code === newCode);

        /* ---- leaving mid-game asks first ---- */
        guest.w.confirm = () => false;
        guest.click("leaveBtn"); await settle();
        ok("leave: cancelling the question keeps you in the game", guest.visible("roomBar"));
        let asked = "";
        guest.w.confirm = q => { asked = q; return true; };
        guest.click("leaveBtn"); await settle();
        ok("leave: the guest is warned about the 2 minutes", /2 minutes/.test(asked), asked);
        ok("leave: back at the lobby, mode picker free again", guest.visible("onlineStart") && !guest.visible("roomBar") && guest.$("modeSelect").disabled === false && !guest.d.querySelector(".modeLink").hidden);
        host2.close(); guest.close();
    }

    /* =============== BASIC =============== */
    {
        const server = new FakeServer(Date.now());
        const { host, guest, code } = await pair(server, "BasicTicTacToe.html");
        ok("basic: board appears for both", host.d.querySelector(".gameContainer").classList.contains("inGame") && guest.d.querySelector(".gameContainer").classList.contains("inGame"));
        ok("basic: turn text", /^Your turn \(X\)$/.test(host.status()) && /^Opponent's turn \(X\)$/.test(guest.status()), host.status() + " | " + guest.status());
        await tap(guest, 0, 0);
        ok("basic: out of turn refused", /not your turn/.test(guest.status()) && guest.cell(0, 0).textContent === "");
        for (const [who, c] of [[host, 0], [guest, 3], [host, 1], [guest, 4], [host, 2]]) await tap(who, 0, c);
        ok("basic: X wins on both screens with the big mark", host.$("overlay").style.display === "flex" && guest.$("overlay").style.display === "flex" && host.text("winnerChar") === "X" && guest.text("winnerChar") === "X");
        ok("basic: result texts", host.status() === "You win the game!" && guest.status() === "Opponent wins the game.", host.status() + " | " + guest.status());
        ok("basic: Rematch offered, board locked", host.visible("rematchBtn") && guest.cell(0, 5).classList.contains("disabled"));
        host.click("rematchBtn"); await settle(); guest.click("rematchBtn"); await settle();
        ok("basic: rematch clears the board and the winner overlay", guest.marks() === "" && guest.$("overlay").style.display === "none" && host.$("overlay").style.display === "none");
        host.close(); guest.close();
    }
    {
        const server = new FakeServer(Date.now());
        const { host, guest } = await pair(server, "BasicTicTacToe.html");
        // X O X / X O O / O X X  (a draw)
        for (const [who, c] of [[host, 0], [guest, 1], [host, 2], [guest, 4], [host, 3], [guest, 5], [host, 7], [guest, 6], [host, 8]]) await tap(who, 0, c);
        ok("basic draw: both are told", host.status() === "It's a draw!" && guest.status() === "It's a draw!", host.status());
        ok("basic draw: no winner overlay", host.$("overlay").style.display !== "flex");
        host.close(); guest.close();
    }

    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
