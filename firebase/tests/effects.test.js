/*
 * Tests of the winning lines, result banners, particles and glowing buttons (offline AND online).
 *   cd firebase && npm run test:effects
 */
const { FakeServer } = require("./fake-firebase");
const { load, sleep, settle } = require("./page-harness");

let pass = 0, fail = 0;
const failures = [];
let lastName = "(start)";
process.on("uncaughtException", e => { console.log("UNCAUGHT after check: " + lastName + "\n" + String(e.stack).split("\n").slice(0, 4).join("\n")); process.exit(1); });
const ok = (name, cond, extra) => { lastName = name; if (cond) pass++; else { fail++; failures.push(name + (extra !== undefined ? "  -> " + extra : "")); } };

const ULT = "UltimateTicTacToe.html", BAS = "BasicTicTacToe.html";
const near = (a, b) => Math.abs(a - b) < 0.1;

// a fake canvas so particle effects can run in jsdom; counts how many were started
function stubCanvas(p) {
    p.canvases = 0;
    const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    p.w.HTMLCanvasElement.prototype.getContext = function () { p.canvases++; return ctx; };
    p.w.requestAnimationFrame = fn => setTimeout(() => fn(p.w.performance.now()), 16);
    p.w.cancelAnimationFrame = id => clearTimeout(id);
}
const lineOf = (host) => { const l = host && host.querySelector(":scope > svg.winLine .core"); return l ? { x1: +l.getAttribute("x1"), y1: +l.getAttribute("y1"), x2: +l.getAttribute("x2"), y2: +l.getAttribute("y2"), cls: l.parentNode.getAttribute("class") } : null; };
const banner = p => { const b = p.d.querySelector(".resultBanner"); return b && !b.hidden ? { kind: b.querySelector(".resultCard").className, title: b.querySelector(".resultTitle").textContent, sub: b.querySelector(".resultSub").textContent } : null; };
const click = (p, id) => p.$(id).dispatchEvent(new p.w.Event("click"));

function device(server, uid, page, extra) {
    const browser = server.browser(uid, (extra && extra.restored) ? { restored: true } : {});
    const p = load(page, Object.assign({ prefs: { mode: "online" }, firebase: browser.firebase, now: () => server.now(), onClose: () => browser.dispose() }, extra));
    p.browser = browser;
    p.cell = (b, c) => page === BAS ? p.$("C" + c) : p.$("C" + b + "-" + c);
    return p;
}
async function tap(p, b, c) { p.cell(b, c).dispatchEvent(new p.w.Event("click")); await settle(); }
async function join(server, page, code, uid, how) {
    const p = device(server, uid, page); stubCanvas(p); await settle();
    p.type("roomCodeInput", code); p.click(how || "joinRoomBtn"); await settle();
    return p;
}

(async () => {
    /* =============== OFFLINE: Basic =============== */
    {
        const p = load(BAS, {}); stubCanvas(p); await settle();
        for (const c of [0, 3, 1, 4, 2]) click(p, "C" + c);                       // X wins the top row
        const ln = lineOf(p.d.querySelector(".cellContainer"));
        ok("basic: a line is drawn through the centres of the three winning cells (top row)", ln && near(ln.x1, 16.67) && near(ln.y1, 16.67) && near(ln.x2, 83.33) && near(ln.y2, 16.67), JSON.stringify(ln));
        ok("basic: it is X's colour and animated (a live win)", /winLine X animate/.test(ln.cls), ln && ln.cls);
        ok("basic: banner says Congratulations", banner(p) && banner(p).kind.includes("win") && banner(p).title === "Congratulations! X Wins!", JSON.stringify(banner(p)));
        ok("basic: confetti started for a live win", p.canvases === 1, p.canvases);
        ok("basic: Reset glows to show the next step", p.$("restartBtn").classList.contains("attention"));
        click(p, "restartBtn");
        ok("basic: Reset stops glowing, line and banner are gone", !p.$("restartBtn").classList.contains("attention") && !lineOf(p.d.querySelector(".cellContainer")) && banner(p) === null && !p.d.querySelector(".fxCanvas"));
        p.close();
    }
    // every kind of line
    for (const [name, cells, a, b] of [["column", [0, 3, 1, 4, 8, 5], [0, 0], [0, 0]], ["diagonal", [0, 1, 4, 2, 8], [16.67, 16.67], [83.33, 83.33]], ["anti-diagonal", [2, 0, 4, 1, 6], [83.33, 16.67], [16.67, 83.33]], ["bottom row", [6, 0, 7, 1, 8], [16.67, 83.33], [83.33, 83.33]]]) {
        if (name === "column") continue;
        const p = load(BAS, {}); await settle();
        for (const c of cells) click(p, "C" + c);
        const ln = lineOf(p.d.querySelector(".cellContainer"));
        ok("basic: " + name + " line has the right ends", ln && near(ln.x1, a[0]) && near(ln.y1, a[1]) && near(ln.x2, b[0]) && near(ln.y2, b[1]), JSON.stringify(ln));
        p.close();
    }
    {
        const p = load(BAS, {}); await settle();
        for (const c of [0, 1, 3, 4, 6]) click(p, "C" + c);                          // X takes the left column: 0,3,6
        const ln = lineOf(p.d.querySelector(".cellContainer"));
        ok("basic: vertical line has the right ends", ln && near(ln.x1, 16.67) && near(ln.y1, 16.67) && near(ln.x2, 16.67) && near(ln.y2, 83.33), JSON.stringify(ln));
        p.close();
    }
    {   // draw
        const p = load(BAS, {}); stubCanvas(p); await settle();
        for (const c of [0, 1, 2, 4, 3, 5, 7, 6, 8]) click(p, "C" + c);
        ok("basic draw: neutral banner, no line, no particles", banner(p) && /draw/.test(banner(p).kind) && banner(p).title === "It's a draw!" && !lineOf(p.d.querySelector(".cellContainer")) && p.canvases === 0, JSON.stringify(banner(p)));
        ok("basic draw: Reset glows", p.$("restartBtn").classList.contains("attention"));
        p.close();
    }
    {   // vs computer: human wins / loses
        const win = load(BAS, { prefs: { mode: "computer", difficulty: "easy", side: "X" } }); stubCanvas(win); await settle();
        win.w.eval('options = ["X","X","","O","O","","","",""]; currentPlayer = "X"; running = true;'); ["C0", "C1", "C3", "C4"].forEach((id, i) => { win.$(id).textContent = ["X", "X", "O", "O"][i]; });
        click(win, "C2");
        ok("vs Computer: the human sees 'Congratulations! You Win!'", banner(win) && banner(win).title === "Congratulations! You Win!" && win.canvases === 1, JSON.stringify(banner(win)));
        click(win, "restartBtn");
        win.close();
        const lose = load(BAS, { prefs: { mode: "computer", difficulty: "impossible", side: "O" } }); stubCanvas(lose); await sleep(900);
        lose.w.eval('options = ["X","X","","O","O","","","",""]; currentPlayer = "X"; running = true;'); lose.w.eval("maybeComputerMove()");
        await sleep(900);
        ok("vs Computer: the human sees 'You Lost!' with a subtle effect", banner(lose) && /lose/.test(banner(lose).kind) && banner(lose).title === "You Lost!" && lose.canvases === 1, JSON.stringify(banner(lose)));
        ok("vs Computer: Reset glows after a loss", lose.$("restartBtn").classList.contains("attention"));
        lose.close();
    }
    {   // reduced motion
        const p = load(BAS, {}); stubCanvas(p); p.w.matchMedia = q => ({ matches: /reduce/.test(q) }); await settle();
        for (const c of [0, 3, 1, 4, 2]) click(p, "C" + c);
        const ln = lineOf(p.d.querySelector(".cellContainer"));
        ok("reduced motion: the line is shown without animation", ln && /static/.test(ln.cls) && !/animate/.test(ln.cls), ln && ln.cls);
        ok("reduced motion: banner is shown, but with no animation class and no particles", banner(p) && !/play/.test(banner(p).kind) && p.canvases === 0 && !p.d.querySelector(".fxCanvas"), JSON.stringify(banner(p)));
        p.close();
    }
    {   // banner can be dismissed, and doesn't come back by itself
        const p = load(BAS, {}); await settle();
        for (const c of [0, 3, 1, 4, 2]) click(p, "C" + c);
        p.d.querySelector(".resultClose").dispatchEvent(new p.w.Event("click"));
        ok("banner: the dismiss button closes it", banner(p) === null);
        p.close();
    }

    /* =============== OFFLINE: Ultimate =============== */
    {
        const p = load(ULT, {}); stubCanvas(p); await settle();
        for (const [b, c] of [[4, 0], [0, 4], [4, 1], [1, 4], [4, 2]]) p.$("C" + b + "-" + c).dispatchEvent(new p.w.Event("click"));
        const ln = lineOf(p.$("C4"));
        ok("ultimate: a line is drawn inside the won mini-board (top row)", ln && near(ln.x1, 16.67) && near(ln.y1, 16.67) && near(ln.x2, 83.33) && /winLine X animate/.test(ln.cls), JSON.stringify(ln));
        ok("ultimate: winning a mini-board does not end the match (no banner)", banner(p) === null && !lineOf(p.$("grid")));
        // finish the match: X owns boards 0 and 1, wins board 2
        p.w.eval('overallBoardState[0] = "X"; overallBoardState[1] = "X"; boardStates[2] = ["X","X","","O","O","","","",""]; nextBoardIndex = 2; currentPlayer = "X"; running = true; updateBoardStates();');
        p.$("C2-0").textContent = "X"; p.$("C2-1").textContent = "X";
        p.$("C2-2").dispatchEvent(new p.w.Event("click"));
        const master = lineOf(p.$("grid"));
        ok("ultimate: the three winning mini-boards are joined by a line across the grid", master && /master/.test(master.cls) && near(master.x1, 16.67) && near(master.y1, 16.67) && near(master.x2, 83.33) && near(master.y2, 16.67), JSON.stringify(master));
        ok("ultimate: the won mini-board also has its own line", !!lineOf(p.$("C2")));
        ok("ultimate: celebration for the match winner", banner(p) && banner(p).title === "Congratulations! X Wins!" && p.canvases === 1 && p.$("restartBtn").classList.contains("attention"), JSON.stringify(banner(p)));
        click(p, "restartBtn");
        ok("ultimate: Reset clears every line and the glow", !lineOf(p.$("grid")) && !lineOf(p.$("C4")) && !lineOf(p.$("C2")) && !p.$("restartBtn").classList.contains("attention"));
        p.close();
    }

    /* =============== ONLINE: Basic =============== */
    {
        const server = new FakeServer(Date.now());
        const host = device(server, "host-uid", BAS); stubCanvas(host); await settle();
        host.click("createRoomBtn"); await settle();
        const code = host.text("roomCodeText");
        const guest = await join(server, BAS, code, "guest-uid");
        const spec = await join(server, BAS, code, "w1-uid", "spectateBtn");
        for (const [who, c] of [[host, 0], [guest, 3], [host, 1], [guest, 4], [host, 2]]) await tap(who, 0, c);

        for (const [label, p] of [["host", host], ["guest", guest], ["spectator", spec]]) {
            const ln = lineOf(p.d.querySelector(".cellContainer"));
            ok("online basic (" + label + "): the winning line is drawn and animated", ln && near(ln.x1, 16.67) && near(ln.x2, 83.33) && /animate/.test(ln.cls), JSON.stringify(ln));
        }
        ok("online basic: the winner sees Congratulations + confetti", banner(host) && banner(host).title === "Congratulations! You Win!" && /win/.test(banner(host).kind) && host.canvases === 1, JSON.stringify(banner(host)));
        ok("online basic: the loser sees 'You Lost!' (subtle effect)", banner(guest) && banner(guest).title === "You Lost!" && /lose/.test(banner(guest).kind) && guest.canvases === 1, JSON.stringify(banner(guest)));
        ok("online basic: the spectator sees a neutral result, no confetti", banner(spec) && banner(spec).title === "X wins!" && /neutral/.test(banner(spec).kind) && spec.canvases === 0, JSON.stringify(banner(spec)));
        ok("online basic: Rematch glows for both players, not for the spectator", host.$("rematchBtn").classList.contains("attention") && guest.$("rematchBtn").classList.contains("attention") && !spec.$("rematchBtn").classList.contains("attention"));

        // once per match: dismiss, then keep rendering: it must not come back
        host.d.querySelector(".resultClose").dispatchEvent(new host.w.Event("click"));
        await sleep(700);
        ok("the result is shown only once per match (not again on later updates)", banner(host) === null && host.canvases === 1);

        host.click("rematchBtn"); await settle();
        ok("rematch: the glow stops as soon as it is pressed", !host.$("rematchBtn").classList.contains("attention"));
        ok("rematch: the old line and banner are gone on the host's new room screen", !host.d.querySelector("svg.winLine") && banner(host) === null);
        guest.click("rematchBtn"); await settle();
        ok("rematch: guest joins; the fresh board has no line, no banner, no glow", !guest.d.querySelector("svg.winLine") && banner(guest) === null && !guest.$("rematchBtn").classList.contains("attention"));
        [host, guest, spec].forEach(p => p.close());
    }
    {   // a page opened after the match ended: calm banner, no particles, line without animation, not repeated
        const server = new FakeServer(Date.now());
        const host = device(server, "host-uid", BAS); await settle();
        host.click("createRoomBtn"); await settle();
        const code = host.text("roomCodeText");
        const guest = await join(server, BAS, code, "guest-uid");
        for (const [who, c] of [[host, 0], [guest, 3], [host, 1], [guest, 4], [host, 2]]) await tap(who, 0, c);
        const saved = { prefs: JSON.parse(host.w.localStorage.getItem("ttt-options")), saved: JSON.parse(host.w.localStorage.getItem("ttt-online-room")), seen: host.w.localStorage.getItem("ttt-results-seen") };
        host.browser.disconnect(); host.close(); await settle();

        const sameDevice = device(server, "host-uid", BAS, { restored: true, prefs: saved.prefs, saved: saved.saved, storage: { "ttt-results-seen": saved.seen } }); stubCanvas(sameDevice); await settle();
        ok("refresh after a finished match on the same device: the banner is NOT shown again", banner(sameDevice) === null && sameDevice.canvases === 0);
        ok("...but the winning line is still there (without animation)", /static/.test((lineOf(sameDevice.d.querySelector(".cellContainer")) || {}).cls || ""));
        const newDevice = device(server, "host-uid", BAS, { restored: true, prefs: saved.prefs, saved: saved.saved }); stubCanvas(newDevice); await settle();
        ok("first view after the match ended (e.g. you were offline): a calm banner, no confetti", banner(newDevice) && banner(newDevice).title === "Congratulations! You Win!" && newDevice.canvases === 0);
        [guest, sameDevice, newDevice].forEach(p => p.close());
    }

    /* =============== ONLINE: Ultimate, board and match wins, abandonment =============== */
    {
        const server = new FakeServer(Date.now());
        const code = "ABCD23";
        server.seed(code, {                                  // X owns boards 0 and 1 and is about to win board 2
            game: "ultimate", host: "host-uid", createdAt: server.now(), players: { X: "host-uid", O: "guest-uid" },
            presence: { X: { online: true, at: server.now() }, O: { online: true, at: server.now() } },
            state: { turn: "X", moves: 20, next: "2", xb: 2, ob: 0, lb: "5", lc: "2" },
            cells: { 0: { 0: "X", 1: "X", 2: "X" }, 1: { 0: "X", 1: "X", 2: "X" }, 2: { 0: "X", 1: "X", 3: "O", 4: "O" } },
            boards: { 0: "X", 1: "X" }
        });
        const host = device(server, "host-uid", ULT, { saved: { code, game: "ultimate" } }); stubCanvas(host);
        const guest = device(server, "guest-uid", ULT, { saved: { code, game: "ultimate" } }); stubCanvas(guest);
        await settle();
        ok("seeded game loaded: pre-existing won boards show static lines", !!lineOf(host.$("C0")) && /static/.test(lineOf(host.$("C0")).cls));
        const spec = await join(server, ULT, code, "w1-uid", "spectateBtn");
        await tap(host, 2, 2);
        ok("ultimate online: new mini-board win gets an animated line", /animate/.test((lineOf(host.$("C2")) || {}).cls || "") && /animate/.test((lineOf(guest.$("C2")) || {}).cls || ""));
        for (const [label, p] of [["host", host], ["guest", guest], ["spectator", spec]]) {
            const m = lineOf(p.$("grid"));
            ok("ultimate online (" + label + "): the three winning mini-boards are joined by a line", m && /master/.test(m.cls) && near(m.x1, 16.67) && near(m.y1, 16.67) && near(m.x2, 83.33), JSON.stringify(m));
        }
        ok("ultimate online: winner / loser / spectator banners", banner(host).title === "Congratulations! You Win!" && banner(guest).title === "You Lost!" && banner(spec).title === "X wins!");
        [host, guest, spec].forEach(p => p.close());
    }
    {   // abandonment: banners but NO winning line
        const server = new FakeServer(Date.now());
        const host = device(server, "host-uid", BAS); stubCanvas(host); await settle();
        host.click("createRoomBtn"); await settle();
        const code = host.text("roomCodeText");
        const guest = await join(server, BAS, code, "guest-uid");
        const spec = await join(server, BAS, code, "w1-uid", "spectateBtn");
        await tap(host, 0, 4);
        guest.browser.disconnect(); await settle();
        server.advance(120500); await sleep(700);
        ok("abandonment: the winner is congratulated, with the reason", banner(host) && banner(host).title === "Congratulations! You Win!" && /abandoned/.test(banner(host).sub), JSON.stringify(banner(host)));
        ok("abandonment: no winning line is invented", !host.d.querySelector("svg.winLine") && !spec.d.querySelector("svg.winLine"));
        ok("abandonment: the spectator sees a neutral result", banner(spec) && /wins/.test(banner(spec).title) && /didn't come back/.test(banner(spec).sub), JSON.stringify(banner(spec)));
        guest.browser.reconnect(); await settle();
        ok("abandonment: the returning player sees 'You Lost!' with the reason", banner(guest) && banner(guest).title === "You Lost!" && /away for more than 2 minutes/.test(banner(guest).sub), JSON.stringify(banner(guest)));
        [host, guest, spec].forEach(p => p.close());
    }

    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
