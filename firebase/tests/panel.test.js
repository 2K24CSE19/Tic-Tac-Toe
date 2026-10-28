/*
 * Tests of the Online lobby screen (OnlinePanel.js) on the real game pages, in a simulated browser, with a fake
 * Firebase that enforces the real security rules.   cd firebase && npm run test:panel
 */
const { FakeServer } = require("./fake-firebase");
const { load, sleep, settle } = require("./page-harness");

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; failures.push(name + (extra !== undefined ? "  -> " + extra : "")); } };

const ONLINE = { mode: "online" };
function device(server, uid, page, extra) {
    const browser = server.browser(uid, (extra && extra.restored) ? { restored: true } : {});
    const p = load(page, Object.assign({ prefs: ONLINE, firebase: browser.firebase, now: () => server.now(), onClose: () => browser.dispose() }, extra));
    p.browser = browser;
    return p;
}

(async () => {
    /* ---- offline play must not be touched by any of this ---- */
    {
        const server = new FakeServer(Date.now());
        const browser = server.browser("x");
        const p = load("UltimateTicTacToe.html", { firebase: browser.firebase, onClose: () => browser.dispose() });
        await settle();
        ok("offline: lobby hidden by default", !p.visible("onlinePanel"));
        ok("offline: board visible, Reset visible", !p.d.querySelector(".gameContainer").classList.contains("isOnline") && p.visible("restartBtn"));
        ok("offline: Firebase never started", browser.firebase.apps.length === 0);
        p.click("C4-4"); ok("offline: board still works", p.$("C4-4").textContent === "X");
        p.close();
    }

    /* ---- choosing Online shows the lobby ---- */
    const server = new FakeServer(Date.now());
    const host = device(server, "host-uid", "UltimateTicTacToe.html");
    await settle();
    ok("online: lobby visible", p(host, "onlinePanel") && host.d.querySelector(".gameContainer").classList.contains("isOnline"));
    ok("online: start view shown, room view hidden", host.visible("onlineStart") && !host.visible("onlineRoom"));
    ok("online: Reset hidden, status explains what to do", !host.visible("restartBtn") && /Create a room/.test(host.status()), host.status());
    ok("online: difficulty/side pickers hidden", !host.visible("difficultySelect") && !host.visible("sideSelect"));
    function p(page, id) { return page.visible(id); }

    /* ---- create a room ---- */
    host.click("createRoomBtn"); await settle();
    const code = host.text("roomCodeText");
    ok("create: room view with a 6-character code", host.visible("onlineRoom") && /^[A-HJ-NP-Z2-9]{6}$/.test(code), code);
    ok("create: room exists on the server", server.value("rooms/" + code) && server.value("rooms/" + code).game === "ultimate");
    ok("create: your seat shown", /You \(X, host\) - connected/.test(host.text("seatYou")), host.text("seatYou"));
    ok("create: opponent shown as not joined", /waiting for them to join/.test(host.text("seatOpponent")), host.text("seatOpponent"));
    ok("create: status says waiting", /Waiting for an opponent/.test(host.status()), host.status());
    ok("create: mode picker locked while in a room", host.$("modeSelect").disabled === true);
    ok("create: room remembered for refresh", JSON.parse(host.w.localStorage.getItem("ttt-online-room")).code === code);

    /* ---- copy / share ---- */
    host.click("copyCodeBtn"); await settle();
    ok("copy: no clipboard -> helpful message, no crash", /Couldn't copy/.test(host.text("roomNote")), host.text("roomNote"));
    let copied = null;
    host.w.navigator.clipboard = { writeText: t => { copied = t; return Promise.resolve(); } };
    host.click("copyCodeBtn"); await settle();
    ok("copy: copies the code", copied === code && /copied/i.test(host.text("roomNote")), copied);
    let shared = null;
    host.w.navigator.share = o => { shared = o; return Promise.resolve(); };
    host.click("shareLinkBtn"); await settle();
    ok("share: link points at this game with the room code", shared && shared.url === "http://localhost/UltimateTicTacToe.html?room=" + code, shared && shared.url);
    ok("share: text mentions the code", shared && shared.text.includes(code));
    delete host.w.navigator.share;
    host.click("shareLinkBtn"); await settle();
    ok("share: falls back to copying the link", copied === "http://localhost/UltimateTicTacToe.html?room=" + code, copied);

    /* ---- a second device joins ---- */
    const guest = device(server, "guest-uid", "UltimateTicTacToe.html");
    await settle();
    guest.type("roomCodeInput", "zz");  guest.click("joinRoomBtn"); await settle();
    ok("join: too-short code is explained", /6 letters or numbers/.test(guest.text("onlineMessage")), guest.text("onlineMessage"));
    guest.type("roomCodeInput", "aaaaaa"); guest.click("joinRoomBtn"); await settle();
    ok("join: unknown code is explained", /No room with that code/.test(guest.text("onlineMessage")), guest.text("onlineMessage"));
    guest.type("roomCodeInput", code.slice(0, 3).toLowerCase() + "-" + code.slice(3).toLowerCase());
    ok("join: typing is cleaned up (upper case, no dash)", guest.$("roomCodeInput").value === code, guest.$("roomCodeInput").value);
    guest.click("joinRoomBtn"); await settle();
    ok("join: guest is in the room", guest.visible("onlineRoom") && guest.text("roomCodeText") === code);
    ok("join: guest sits at the board as O, host shown connected", guest.d.querySelector(".gameContainer").classList.contains("inGame") && guest.text("barYou") === "You (O)" && guest.text("barOpp") === "Host (X)" && guest.$("barOppDot").className === "dot online", guest.text("barYou") + " | " + guest.text("barOpp"));
    ok("join: host sees the opponent connected and the board appears", host.d.querySelector(".gameContainer").classList.contains("inGame") && host.text("barOpp") === "Opponent (O)" && host.$("barOppDot").className === "dot online" && !host.visible("onlinePanel") && host.visible("roomBar"), host.text("barOpp"));
    ok("join: status shows whose turn it is", /^Your turn \(X\) - play in any open board/.test(host.status()) && /^Opponent's turn \(X\)/.test(guest.status()), host.status() + " | " + guest.status());

    /* ---- wrong game page, full room ---- */
    const basicGuest = device(server, "other-uid", "BasicTicTacToe.html"); await settle();
    basicGuest.type("roomCodeInput", code); basicGuest.click("joinRoomBtn"); await settle();
    const link = basicGuest.d.querySelector("#onlineMessage a");
    ok("wrong page: says it's an Ultimate room and links to the right page", /Ultimate/.test(basicGuest.text("onlineMessage")) && link && link.getAttribute("href") === "UltimateTicTacToe.html?room=" + code, basicGuest.text("onlineMessage"));
    const third = device(server, "third-uid", "UltimateTicTacToe.html"); await settle();
    third.type("roomCodeInput", code); third.click("joinRoomBtn"); await settle();
    ok("full room: third person is told it's full", /already full/.test(third.text("onlineMessage")) && !third.visible("onlineRoom"), third.text("onlineMessage"));
    basicGuest.close(); third.close();

    /* ---- refresh recovery ---- */
    const hostSaved = { prefs: JSON.parse(host.w.localStorage.getItem("ttt-options")), saved: JSON.parse(host.w.localStorage.getItem("ttt-online-room")) };
    host.browser.disconnect(); host.close(); await settle();                       // the host's tab is closed...
    ok("refresh: guest immediately sees the host is away", guest.$("barOppDot").className === "dot away", guest.$("barOppDot").className);
    ok("refresh: guest's status says the host is away", /Opponent disconnected\. Waiting for reconnection: 02:00/.test(guest.status()), guest.status());
    server.advance(4000);
    const host2 = device(server, "host-uid", "UltimateTicTacToe.html", { restored: true, prefs: hostSaved.prefs, saved: hostSaved.saved });
    await settle();                                                                // ...and reopened
    ok("refresh: host lands back in the same room", host2.visible("onlineRoom") && host2.text("roomCodeText") === code, host2.text("roomCodeText"));
    ok("refresh: host kept the seat", host2.text("barYou") === "You (X)" && host2.$("barYouDot").className === "dot online", host2.text("barYou"));
    ok("refresh: guest sees the host is back", guest.$("barOppDot").className === "dot online" && /^Opponent's turn \(X\)/.test(guest.status()), guest.status());

    /* ---- the guest drops: countdown ---- */
    guest.browser.disconnect(); await settle();
    ok("away: host sees the guest as away", host2.$("barOppDot").className === "dot away", host2.$("barOppDot").className);
    ok("away: status tells the host", /Opponent disconnected\. Waiting for reconnection: 02:00/.test(host2.status()), host2.status());
    server.advance(61000);
    await sleep(700);                                                              // the screen refreshes twice a second
    ok("away: countdown runs on the server clock (120s - 61s = 0:59 left)", /Waiting for reconnection: 00:59/.test(host2.status()), host2.status());
    guest.browser.reconnect(); await settle();
    ok("away: guest reconnects in time and the game resumes", host2.$("barOppDot").className === "dot online" && !host2.visible("claimBtn") && /Your turn|Opponent's turn/.test(host2.status()) && !host2.d.querySelector("#rematchBtn:not([hidden])"), host2.status());
    guest.browser.disconnect(); await settle();
    server.advance(120000); await sleep(700);
    ok("away: after 120 s the remaining player is declared the winner automatically", /^You win! Your opponent abandoned the match/.test(host2.status()) && server.value("rooms/" + code).state.winner === "X" && server.value("rooms/" + code).state.reason === "forfeit", host2.status());
    guest.browser.reconnect(); await settle();
    ok("away: the returning player sees they lost by abandonment", /^You lost\. You were away for more than 2 minutes/.test(guest.status()) && guest.visible("rematchBtn"), guest.status());
    ok("away: result is not changed by the late return", server.value("rooms/" + code).state.winner === "X");

    /* ---- the guest's own connection drops ---- */
    guest.browser.connected = false;
    guest.browser.connListeners.forEach(l => l.cb({ val: () => false }));
    await settle();
    ok("own offline: guest is told they're reconnecting", guest.$("barYouDot").className === "dot away" && /offline/i.test(guest.status()), guest.status());
    guest.browser.connected = true;
    guest.browser.connListeners.forEach(l => l.cb({ val: () => true }));
    await settle();
    ok("own offline: back to normal", guest.$("barYouDot").className === "dot online" && !/offline/i.test(guest.status()), guest.status());

    /* ---- leaving ---- */
    guest.click("leaveRoomBtn"); await settle();
    ok("leave: guest is back at the start", guest.visible("onlineStart") && !guest.visible("onlineRoom") && guest.$("modeSelect").disabled === false);
    ok("leave: guest forgets the room", guest.w.localStorage.getItem("ttt-online-room") === null);
    ok("leave: host sees the guest go", host2.$("barOppDot").className === "dot away", host2.$("barOppDot").className);
    guest.type("roomCodeInput", code); guest.click("joinRoomBtn"); await settle();
    ok("leave: guest can come back with the code and keeps seat O", guest.visible("roomBar") && guest.text("barYou") === "You (O)", guest.text("barYou"));

    /* ---- room closed by the host ---- */
    {
        const h = device(server, "h3-uid", "BasicTicTacToe.html"); await settle();
        h.click("createRoomBtn"); await settle();
        const c3 = h.text("roomCodeText");
        const g = device(server, "g3-uid", "BasicTicTacToe.html"); await settle();
        g.type("roomCodeInput", c3); g.click("joinRoomBtn"); await settle();
        ok("basic: works on the Basic page too", g.visible("onlineRoom") && server.value("rooms/" + c3).game === "basic");
        server.write({ uid: "h3-uid" }, "set", "rooms/" + c3, null); await settle();
        ok("closed room: guest is told and returned to the start", /host closed the room/i.test(g.text("onlineMessage")) && g.visible("onlineStart"), g.text("onlineMessage"));
        // host alone leaving deletes the empty room
        const h4 = device(server, "h4-uid", "BasicTicTacToe.html"); await settle();
        h4.click("createRoomBtn"); await settle();
        const c4 = h4.text("roomCodeText");
        h4.click("leaveRoomBtn"); await settle();
        ok("leaving an empty room deletes it", server.value("rooms/" + c4) === null);
        h.close(); g.close(); h4.close();
    }

    /* ---- shared link ---- */
    {
        const h = device(server, "h5-uid", "UltimateTicTacToe.html"); await settle();
        h.click("createRoomBtn"); await settle();
        const c5 = h.text("roomCodeText");
        const browser = server.browser("g5-uid");
        const g = load("UltimateTicTacToe.html", { url: "http://localhost/UltimateTicTacToe.html?room=" + c5, firebase: browser.firebase, now: () => server.now(), onClose: () => browser.dispose() });   // no saved prefs: a brand-new visitor
        await settle();
        ok("link: opens straight into the room", g.visible("onlineRoom") && g.text("roomCodeText") === c5, g.text("roomCodeText"));
        ok("link: Online mode switched on automatically", g.$("modeSelect").value === "online");
        ok("link: ?room removed from the address bar", g.w.location.search === "", g.w.location.search);
    ok("link: host sees the new player", h.text("barOpp") === "Opponent (O)" && h.$("barOppDot").className === "dot online");
        h.close(); g.close();
    }

    /* ---- problems ---- */
    {
        // the online service can't load, then can
        const browser = server.browser("p-uid");
        const p1 = load("UltimateTicTacToe.html", { now: () => server.now(), onClose: () => browser.dispose() });         // offline mode, no firebase on the page
        await settle();
        const realLoad = p1.w.TTTOnline.loadSdk;
        p1.w.TTTOnline.loadSdk = () => Promise.reject(new p1.w.TTTOnline.OnlineError("sdk-load", "Couldn't load the online service. Check your internet connection."));
        p1.choose("modeSelect", "online"); await settle();
        ok("no internet: clear message, offline play unaffected", /Couldn't load the online service/.test(p1.text("onlineMessage")) && p1.visible("onlineStart"), p1.text("onlineMessage"));
        p1.w.TTTOnline.loadSdk = () => Promise.resolve(browser.firebase);
        p1.click("createRoomBtn"); await settle();
        ok("no internet: Create works once the connection is back", p1.visible("onlineRoom"));
        p1.close();

        // missing settings
        const b2 = server.browser("q-uid");
        const p2 = load("BasicTicTacToe.html", { firebase: b2.firebase, config: {}, onClose: () => b2.dispose() });
        await settle();
        p2.choose("modeSelect", "online"); await settle();
        ok("not configured: explains what's missing", /isn't set up yet/.test(p2.text("onlineMessage")), p2.text("onlineMessage"));
        p2.close();

        // guest sign-in turned off in Firebase
        const b3 = server.browser("r-uid", { failSignIn: "auth/operation-not-allowed" });
        const p3 = load("BasicTicTacToe.html", { firebase: b3.firebase, onClose: () => b3.dispose() });
        await settle();
        p3.choose("modeSelect", "online"); await settle();
        ok("sign-in switched off: tells you how to fix it", /Authentication > Anonymous/.test(p3.text("onlineMessage")), p3.text("onlineMessage"));
        p3.close();

        // a saved room for the OTHER game
        const p4 = device(server, "s-uid", "BasicTicTacToe.html", { saved: { code: "ABCD23", game: "ultimate" } });
        await settle();
        const a = p4.d.querySelector("#onlineMessage a");
        ok("saved room belongs to the other game: offers a link", a && a.getAttribute("href") === "UltimateTicTacToe.html" && /Ultimate room \(ABCD23\)/.test(p4.text("onlineMessage")), p4.text("onlineMessage"));
        p4.close();

        // saved room that no longer exists
        const p5 = device(server, "t-uid", "BasicTicTacToe.html", { saved: { code: "ABCD24", game: "basic" } });
        await settle();
        ok("saved room is gone: friendly message and saved code dropped", /isn't available any more/.test(p5.text("onlineMessage")) && p5.w.localStorage.getItem("ttt-online-room") === null, p5.text("onlineMessage"));
        p5.close();
    }

    host2.close(); guest.close();
    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
