/*
 * Online mode on both game pages.
 *
 *   - Lobby: create a private room, share the code, join with a code.
 *   - Playing: the board shows whatever the room says; a tap sends a move to the server; the status line says
 *     whose turn it is, and handles disconnects (pause + 120 s countdown), claiming a win, and rematches.
 *
 * Firebase is only loaded when the player actually opens Online mode, so offline play never depends on it.
 * (The page's own game code is in *Logic.js and exposes window.GameView.)
 */
(function () {
    "use strict";

    const panel = document.getElementById("onlinePanel");
    if (!panel) return;

    const Core = window.MultiplayerCore;
    const Online = window.TTTOnline;
    const GAME = document.body.dataset.game;                       // "basic" | "ultimate"
    const GAME_NAME = GAME === "ultimate" ? "Ultimate" : "Basic";
    const OTHER_PAGE = GAME === "ultimate" ? "BasicTicTacToe.html" : "UltimateTicTacToe.html";
    const OTHER_NAME = GAME === "ultimate" ? "Basic" : "Ultimate";
    const BOARD_NAMES = ["top-left", "top-center", "top-right", "middle-left", "center", "middle-right",
        "bottom-left", "bottom-center", "bottom-right"];

    const $ = id => document.getElementById(id);
    const startView = $("onlineStart"), roomView = $("onlineRoom");
    const createBtn = $("createRoomBtn"), joinBtn = $("joinRoomBtn"), codeInput = $("roomCodeInput");
    const message = $("onlineMessage"), note = $("roomNote");
    const codeText = $("roomCodeText"), copyBtn = $("copyCodeBtn"), shareBtn = $("shareLinkBtn"), leaveCardBtn = $("leaveRoomBtn");
    const seatYou = $("seatYou"), seatOpp = $("seatOpponent");
    const roomBar = $("roomBar"), barCode = $("barCode"), barYou = $("barYou"), barOpp = $("barOpp");
    const barYouDot = $("barYouDot"), barOppDot = $("barOppDot");
    const leaveBtn = $("leaveBtn"), rematchBtn = $("rematchBtn"), claimBtn = $("claimBtn");
    const statusBar = $("statusBar"), modeSelect = $("modeSelect"), restartBtn = $("restartBtn");
    const modeLink = document.querySelector(".modeLink");
    const spectateBtn = $("spectateBtn"), spectatorBadge = $("spectatorBadge"), barSpectators = $("barSpectators"), homeLink = $("homeLink");
    const container = document.querySelector(".gameContainer");

    let client = null;
    let inRoom = false;
    let inGameView = false;                                        // true once both players are in the room: the board is shown
    let started = false;
    let myConnected = true;
    let lastRoom = null;
    let ticker = null;
    let sending = false;
    let flashing = false;
    let flashTimer = null;
    let rematchPending = false;                                    // I started a rematch and am waiting for the opponent
    let busyButtons = false;
    let lastOver = null;                                           // was the game still running at the previous update? (null = not seen yet)
    let claiming = false;                                          // an automatic "opponent abandoned" claim is being sent

    const LEAVE_WARNING = "Are you sure you want to leave? Your opponent may win if you don't return within 2 minutes.";

    /* ---------------- small helpers ---------------- */

    function say(el, text, kind) {
        el.textContent = text || "";
        el.dataset.kind = kind || "";
    }
    function sayWithLink(el, text, linkText, href, kind) {
        el.textContent = text + " ";
        const a = document.createElement("a");
        a.href = href;
        a.textContent = linkText;
        el.appendChild(a);
        el.dataset.kind = kind || "";
    }
    function setStatus(text) { if (!flashing) statusBar.textContent = text; }

    // Show a short message in the status line, then go back to the normal one.
    function flash(text) {
        flashing = true;
        statusBar.textContent = text;
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(function () { flashing = false; render(); }, 2200);
    }

    function showView(name) {
        startView.hidden = name !== "start";
        roomView.hidden = name !== "room";
    }

    function setBusy(busy) {
        createBtn.disabled = busy;
        joinBtn.disabled = busy;
        spectateBtn.disabled = busy;
        codeInput.disabled = busy;
    }

    function pageUrl(code) {
        return location.href.split(/[?#]/)[0] + "?room=" + code;
    }

    function mmss(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60), sec = total % 60;
        return (m < 10 ? "0" : "") + m + ":" + (sec < 10 ? "0" : "") + sec;
    }

    function dot(kind) {
        const d = document.createElement("span");
        d.className = "dot " + kind;
        d.setAttribute("aria-hidden", "true");
        return d;
    }

    async function requireClient() {
        if (client) return client;
        const fb = await Online.loadSdk();
        const c = Online.createClient(fb, window.TTT_FIREBASE_CONFIG);
        await c.ready();
        client = c;
        return client;
    }

    /* ---------------- which screen is showing ---------------- */

    function setGameView(on) {
        inGameView = on;
        container.classList.toggle("inGame", on);
        panel.hidden = !GameOptions.get().online || on;
        roomBar.hidden = !on;
    }

    function applyMode() {
        const online = GameOptions.get().online;
        container.classList.toggle("isOnline", online);
        restartBtn.hidden = online;                                // nothing to reset in a lobby / online game
        if (!online) {
            setGameView(false);
            panel.hidden = true;
            return;
        }
        panel.hidden = inGameView;
        if (!inRoom && !started) autoStart();
        if (!inRoom && started && !message.textContent) setStatus("Create a room or enter a code to play online.");
    }

    // First time Online is shown: follow a ?room= link, or come back to the room we were in before a refresh.
    async function autoStart() {
        started = true;
        showView("start");
        setStatus("Connecting...");
        const linked = new URLSearchParams(location.search).get("room");
        const savedFirst = (function () { try { return JSON.parse(localStorage.getItem("ttt-online-room")); } catch (e) { return null; } })();

        try {
            await requireClient();
        } catch (e) {
            say(message, e.message, "error");
            setStatus("Online play isn't available right now.");
            started = false;                                      // let a later click try again
            return;
        }

        if (linked) {
            history.replaceState(null, "", location.href.split(/[?#]/)[0]);     // don't re-join the link on every refresh
            codeInput.value = Core.normalizeRoomCode(linked);
            await joinWith(linked);
            return;
        }

        const saved = client.getSavedRoom() || savedFirst;
        if (saved && saved.game === GAME && Core.isValidRoomCode(saved.code)) {
            setStatus("Reconnecting to your room...");
            try {
                if (saved.role === "spectator") {
                    const w = await client.spectateRoom(saved.code, { expectGame: GAME });
                    await enterRoom(w.code, w.role === "spectator" ? { role: "spectator" } : undefined);
                } else {
                    const info = await client.joinRoom(saved.code, { expectGame: GAME });
                    await enterRoom(info.code);
                }
                return;
            } catch (e) {
                if (e.code === "not-found" || e.code === "full" || e.code === "wrong-game" || e.code === "spectators-full") {
                    client.forget();
                    say(message, "Your last room (" + saved.code + ") isn't available any more.", "");
                } else {
                    codeInput.value = saved.code;
                    say(message, e.message + " Press Join to try again.", "error");
                }
            }
        } else if (saved && saved.game && saved.game !== GAME && Core.isValidRoomCode(saved.code)) {
            sayWithLink(message, "You have an open " + (saved.game === "ultimate" ? "Ultimate" : "Basic") + " room (" + saved.code + ").",
                "Go to it", (saved.game === "ultimate" ? "UltimateTicTacToe.html" : "BasicTicTacToe.html"), "");
        }
        setStatus("Create a room or enter a code to play online.");
    }

    /* ---------------- create / join / leave ---------------- */

    async function createRoom() {
        setBusy(true);
        say(message, "Creating your room...", "");
        try {
            await requireClient();
            const code = await client.createRoom(GAME);
            await enterRoom(code);
        } catch (e) {
            say(message, e.message, "error");
        } finally {
            setBusy(false);
        }
    }

    async function joinWith(raw) {
        setBusy(true);
        say(message, "Joining...", "");
        try {
            await requireClient();
            const info = await client.joinRoom(raw, { expectGame: GAME });
            await enterRoom(info.code);
        } catch (e) {
            if (e.code === "wrong-game") {
                sayWithLink(message, e.message, "Open it on the " + OTHER_NAME + " page", OTHER_PAGE + "?room=" + Core.normalizeRoomCode(raw), "error");
            } else if (e.canSpectate) {
                say(message, e.message + " Press Spectate to watch it instead.", "error");
            } else {
                say(message, e.message, "error");
            }
            setStatus("Create a room or enter a code to play online.");
        } finally {
            setBusy(false);
        }
    }

    async function spectateWith(raw) {
        setBusy(true);
        say(message, "Joining as a spectator...", "");
        try {
            await requireClient();
            const info = await client.spectateRoom(raw, { expectGame: GAME });
            await enterRoom(info.code, info.role === "spectator" ? { role: "spectator" } : undefined);
        } catch (e) {
            if (e.code === "wrong-game") {
                sayWithLink(message, e.message, "Open it on the " + OTHER_NAME + " page", OTHER_PAGE, "error");
            } else {
                say(message, e.message, "error");
            }
            setStatus("Create a room or enter a code to play online.");
        } finally {
            setBusy(false);
        }
    }

    async function enterRoom(code, eopts) {
        inRoom = true;
        lastRoom = null;
        lastOver = null;
        if (window.Effects) { Effects.reset(); Effects.hideResult(); }
        myConnected = true;
        setGameView(false);
        modeSelect.disabled = true;                                // leave the room before switching modes
        if (modeLink) modeLink.hidden = true;
        codeText.textContent = code;
        say(message, "", "");
        say(note, "", "");
        showView("room");
        setStatus(rematchPending ? "Waiting for your opponent to join the rematch..." : "Joining the room...");
        await client.attach(code, {
            // fresh news from the server always replaces a short "flash" message
            onRoom: function (room) { lastRoom = room; flashing = false; render(); },
            onConnection: function (ok) { myConnected = ok; flashing = false; render(); },
            onGone: function () { roomClosed(); },
            onError: function (e) { say(note, e.message, "error"); flash(e.message); }
        }, eopts && eopts.role === "spectator" ? { role: "spectator" } : undefined);
    }

    function backToStart(text, kind) {
        inRoom = false;
        lastRoom = null;
        lastOver = null;
        if (window.Effects) { Effects.reset(); Effects.hideResult(); }
        rematchPending = false;
        stopTicker();
        setGameView(false);
        panel.hidden = !GameOptions.get().online;
        modeSelect.disabled = false;
        if (modeLink) modeLink.hidden = false;
        [leaveBtn, rematchBtn, claimBtn].forEach(function (b) { b.hidden = true; });
        spectatorBadge.hidden = true;
        showView("start");
        say(message, text || "", kind || "");
        flashing = false;
        setStatus("Create a room or enter a code to play online.");
    }

    function roomClosed() {
        if (client) client.leave();
        backToStart("The host closed the room.", "");
    }

    async function leaveRoom() {
        if (busyButtons) return;
        const role = client.currentRole();
        const watching = role === "spectator";
        const opponentJoined = !!(lastRoom && lastRoom.players && lastRoom.players.O);
        const gameOn = !watching && opponentJoined && !(lastRoom.state && lastRoom.state.winner);
        if (gameOn && typeof window.confirm === "function" && !window.confirm(LEAVE_WARNING)) return;
        const code = codeText.textContent;
        await client.leave({ deleteRoom: role === "X" && !opponentJoined });
        backToStart(opponentJoined && !watching ? "You left room " + code + ". Enter the code to come back." : "", "");
    }

    // Home = leaving the match (same abandonment countdown as a dropped connection), but the room is kept so you can return.
    async function onHomeClicked(e) {
        if (!client || !inRoom || !lastRoom) return;                    // offline modes / lobby: plain navigation
        const role = client.currentRole();
        const joined = !!(lastRoom.players && lastRoom.players.O);
        const over = !!(lastRoom.state && lastRoom.state.winner);
        if (role === "spectator") {
            e.preventDefault();
            await client.leave();
            window.location.href = homeLink.getAttribute("href");
            return;
        }
        if (!joined || over) return;                                    // no opponent yet / match finished: nothing to abandon
        e.preventDefault();
        if (typeof window.confirm === "function" && !window.confirm(LEAVE_WARNING)) return;    // Cancel: stay in the match
        await client.markAway();                                        // opponent's countdown starts now
        try { window.location.href = homeLink.getAttribute("href"); } catch (err) { /* ignore */ }
    }

    /* ---------------- playing ---------------- */

    function reasonText(reason) {
        switch (reason) {
            case "not-your-turn": return "It's not your turn yet.";
            case "paused": return "The game is paused until both players are connected.";
            case "wrong-board": return "You have to play in the highlighted board.";
            case "over": return "The game is over.";
            default: return "That square isn't available.";
        }
    }

    async function onCellTapped(board, cell) {
        if (!inRoom || !lastRoom || !client || sending) return;
        const me = client.currentSeat();
        if (!me) { flash("You're watching. Spectators can't play."); return; }
        const reason = !myConnected ? "paused" : Core.moveError(lastRoom, board, cell, me);
        if (reason) { flash(reasonText(reason)); return; }
        sending = true;
        try {
            await client.sendMove(board, cell);
        } catch (e) {
            flash(e.code === "denied" ? "The server refused that move." : e.message);
        } finally {
            sending = false;
        }
    }

    // The opponent has been gone for the whole 120 s: send the claim for the win by ourselves (the server rules check the time).
    // If the clock estimate is a little early the server says no and we simply try again a moment later.
    async function autoClaim() {
        if (claiming) return;
        claiming = true;
        try {
            for (let i = 0; i < 8; i++) {
                try { await client.claimForfeit(); break; }
                catch (e) {
                    if (e.code !== "too-early") break;
                    await new Promise(function (r) { setTimeout(r, 1000); });
                    if (!lastRoom || (lastRoom.state && lastRoom.state.winner) || !inRoom) break;
                }
            }
        } finally {
            claiming = false;
            render();
        }
    }

    async function claimWin() {
        if (busyButtons) return;
        busyButtons = true;
        claimBtn.disabled = true;
        try {
            await client.claimForfeit();
        } catch (e) {
            flash(e.code === "too-early" ? "Not quite yet. Try again in a moment." : e.message);
        } finally {
            busyButtons = false;
            claimBtn.disabled = false;
        }
    }

    async function rematch() {
        if (busyButtons) return;
        busyButtons = true;
        rematchBtn.disabled = true;
        rematchBtn.classList.remove("attention");                       // stop the glow as soon as it is pressed
        try {
            if (client.currentRole() === "spectator") {                 // watchers follow the players to the new room
                const w = await client.spectateRoom(lastRoom.rematch, { expectGame: GAME });
                await enterRoom(w.code, w.role === "spectator" ? { role: "spectator" } : undefined);
                return;
            }
            const r = await client.startRematch();
            if (r.created) {
                rematchPending = true;
                await enterRoom(r.code);
            } else {
                const info = await client.joinRoom(r.code, { expectGame: GAME });
                rematchPending = false;
                await enterRoom(info.code);
            }
        } catch (e) {
            flash(e.message);
        } finally {
            busyButtons = false;
            rematchBtn.disabled = false;
        }
    }

    /* ---------------- showing the room ---------------- */

    function startTicker() { if (!ticker) ticker = setInterval(render, 500); }
    function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }

    function seatLabel(seat) { return seat === "X" ? "Host (X)" : "Guest (O)"; }

    function describeOpponent(me, st) {
        const opp = me === "X" ? "O" : "X";
        const name = (opp === "X" ? "Host" : "Opponent") + " (" + opp + ")";
        if (!st.joined) return { kind: "waiting", name: name, text: "waiting for them to join" };
        if (st.online) return { kind: "online", name: name, text: "connected" };
        return { kind: "away", name: name, text: st.graceLeftMs > 0 ? "away - " + mmss(st.graceLeftMs) + " left to come back" : "away - time is up" };
    }

    // neutral = the spectator's point of view (no "you")
    function resultText(g, me, neutral) {
        if (g.winner === "draw") return "It's a draw!";
        if (g.reason === "forfeit") {
            if (neutral) return seatLabel(g.winner) + " wins: the other player didn't come back within 2 minutes.";
            return g.winner === me ? "You win! Your opponent abandoned the match."
                : "You lost. You were away for more than 2 minutes, so your opponent won.";
        }
        const iWon = g.winner === me;
        let text = neutral ? g.winner + " wins the game!" : (iWon ? "You win the game!" : "Opponent wins the game.");
        if (GAME === "ultimate" && !Core.lineWinner(g.overallBoardState) && g.overallBoardState.every(function (v) { return v !== ""; })) {
            const w = g.winner === "X" ? g.xBoards : g.oBoards, l = g.winner === "X" ? g.oBoards : g.xBoards;
            text += " (" + w + " boards to " + l + ")";
        }
        return text;
    }

    function whereText(g) {
        return g.nextBoardIndex === null ? "any open board" : "the " + BOARD_NAMES[g.nextBoardIndex] + " board";
    }

    function turnText(g, me) {
        const mine = g.currentPlayer === me;
        if (GAME === "ultimate") {
            return mine ? "Your turn (" + me + ") - play in " + whereText(g)
                : "Opponent's turn (" + g.currentPlayer + ") - they play in " + whereText(g);
        }
        return mine ? "Your turn (" + me + ")" : "Opponent's turn (" + g.currentPlayer + ")";
    }

    function spectatorTurnText(g) {
        const who = g.currentPlayer + "'s turn (" + (g.currentPlayer === "X" ? "Host" : "Guest") + ")";
        return GAME === "ultimate" ? who + " - plays in " + whereText(g) : who;
    }

    // Winning line / banner / celebration for a finished match, once per match on this device.
    function presentResult(g, me) {
        const wasLive = lastOver === false;                         // we watched it end (vs. opening a page after it ended)
        lastOver = g.over;
        if (!g.over || !window.Effects) return;
        const key = "room:" + codeText.textContent + ":" + g.winner + ":" + g.moves + (g.reason ? ":" + g.reason : "");
        if (!Effects.markSeen(key)) return;
        const abandoned = g.reason === "forfeit";
        const tb = tieBreakNote(g);
        let kind, title, sub = "";
        if (g.winner === "draw") { kind = me ? "draw" : "neutral"; title = "It's a draw!"; }
        else if (me && g.winner === me) { kind = "win"; title = "Congratulations! You Win!"; sub = abandoned ? "Your opponent abandoned the match." : tb; }
        else if (me) { kind = "lose"; title = "You Lost!"; sub = abandoned ? "You were away for more than 2 minutes." : tb; }
        else {
            kind = "neutral";
            title = abandoned ? seatLabel(g.winner) + " wins" : g.winner + " wins!";
            sub = abandoned ? "The other player didn't come back within 2 minutes." : tb;
        }
        Effects.result({ kind: kind, title: title, sub: sub, live: wasLive });
    }

    // " 5 boards to 4" when an Ultimate match was decided by counting boards (no three in a row)
    function tieBreakNote(g) {
        if (GAME !== "ultimate" || g.winner === "draw" || Core.lineWinner(g.overallBoardState) || !g.overallBoardState.every(function (v) { return v !== ""; })) return "";
        const w = g.winner === "X" ? g.xBoards : g.oBoards, l = g.winner === "X" ? g.oBoards : g.xBoards;
        return w + " boards to " + l;
    }

    function render() {
        if (!inRoom || !lastRoom || !client) return;
        const role = client.currentRole();
        if (!role) return;
        const watching = role === "spectator";
        const room = lastRoom;
        const now = client.serverNow();
        const phase = Core.roomPhase(room, now);
        const g = Core.roomToGame(room);
        const joined = !!(room.players && room.players.O);

        barSpectators.textContent = "Spectators: " + Core.spectatorCount(room) + "/" + Core.SPECTATOR_SLOTS.length;
        spectatorBadge.hidden = !watching;
        setGameView(watching || joined);
        if (joined) rematchPending = false;

        if (watching) renderWatcher(room, g, phase, now, joined);
        else renderPlayer(room, g, phase, now, joined, role);

        if (phase === "guest-away" || phase === "host-away" || phase === "both-away" || !myConnected) startTicker(); else stopTicker();
    }

    function renderPlayer(room, g, phase, now, joined, me) {
        const opp = me === "X" ? "O" : "X";
        const oppStatus = Core.seatStatus(room, opp, now);
        const od = describeOpponent(me, oppStatus);
        const youKind = myConnected ? "online" : "away";

        if (!joined) {
            /* ---- waiting in the lobby card ---- */
            seatYou.textContent = "";
            seatYou.appendChild(dot(youKind));
            seatYou.appendChild(document.createTextNode("You (" + me + (me === "X" ? ", host" : "") + ") - " + (myConnected ? "connected" : "reconnecting...")));
            seatOpp.textContent = "";
            seatOpp.appendChild(dot(od.kind));
            seatOpp.appendChild(document.createTextNode(od.name + " - " + od.text));
            setStatus(!myConnected ? "You're offline. Reconnecting..."
                : (rematchPending ? "Waiting for your opponent to join the rematch..." : "Waiting for an opponent to join..."));
            if (!note.dataset.kind) say(note, rematchPending ? "They'll see a Join rematch button. You can also send the code." : "Send them the code or the link.", "");
            [leaveBtn, rematchBtn, claimBtn].forEach(function (b) { b.hidden = true; });
            return;
        }

        /* ---- the game ---- */
        barCode.textContent = codeText.textContent;
        barYou.textContent = "You (" + me + ")";
        barOpp.textContent = (opp === "X" ? "Host" : "Opponent") + " (" + opp + ")";
        barYouDot.className = "dot " + youKind;
        barOppDot.className = "dot " + od.kind;

        const playing = phase === "playing" && myConnected;
        const interactive = playing && !g.over && g.currentPlayer === me;
        if (window.GameView) window.GameView.showOnline(g, { playing: playing, interactive: interactive, spectator: false });
        presentResult(g, me);

        const canClaim = Core.canClaimForfeit(room, me, now);
        if (canClaim) autoClaim();

        let bar;
        if (!myConnected) bar = "You're offline. Reconnecting...";
        else if (g.over) bar = resultText(g, me, false);
        else if (phase === "both-away") bar = "Both players were disconnected. The game is paused.";
        else if (phase === "host-away" || phase === "guest-away") {
            const iAmAway = (phase === "host-away" && me === "X") || (phase === "guest-away" && me === "O");
            if (iAmAway) bar = "Reconnecting...";
            else if (oppStatus.graceLeftMs > 0) bar = "Opponent disconnected. Waiting for reconnection: " + mmss(oppStatus.graceLeftMs);
            else if (canClaim) bar = "Opponent didn't return. Declaring you the winner...";
            else bar = "You were both disconnected, so nobody wins by abandonment. Waiting for your opponent to return.";
        } else bar = turnText(g, me);
        setStatus(bar);

        leaveBtn.hidden = false;
        rematchBtn.hidden = !g.over;
        rematchBtn.textContent = room.rematch ? "Join rematch" : "Rematch";
        // the glow says "this is what to press next"; it stops once a rematch is being set up
        rematchBtn.classList.toggle("attention", g.over && !busyButtons && !rematchPending && !rematchBtn.disabled);
        claimBtn.hidden = !(canClaim && !claiming);
    }

    function renderWatcher(room, g, phase, now, joined) {
        const xs = Core.seatStatus(room, "X", now), os = Core.seatStatus(room, "O", now);
        barCode.textContent = codeText.textContent;
        barYou.textContent = "Host (X)";
        barOpp.textContent = joined ? "Guest (O)" : "Guest (O) - not joined";
        barYouDot.className = "dot " + (xs.online ? "online" : "away");
        barOppDot.className = "dot " + (!os.joined ? "waiting" : (os.online ? "online" : "away"));

        const playing = phase === "playing" && myConnected;
        if (window.GameView) window.GameView.showOnline(g, { playing: playing, interactive: false, spectator: true });
        presentResult(g, null);

        let bar;
        if (!myConnected) bar = "You're offline. Reconnecting...";
        else if (g.over) bar = resultText(g, null, true);
        else if (!joined) bar = "Waiting for the second player to join.";
        else if (phase === "both-away") bar = "Both players are disconnected. The game is paused.";
        else if (phase === "host-away") bar = "Host (X) disconnected. Waiting for reconnection: " + mmss(xs.graceLeftMs);
        else if (phase === "guest-away") bar = "Guest (O) disconnected. Waiting for reconnection: " + mmss(os.graceLeftMs);
        else bar = spectatorTurnText(g);
        setStatus(bar);

        leaveBtn.hidden = false;
        claimBtn.hidden = true;
        rematchBtn.hidden = !room.rematch;                              // watchers can only FOLLOW a rematch
        rematchBtn.textContent = "Watch rematch";
        rematchBtn.classList.remove("attention");
    }

    /* ---------------- copy / share ---------------- */

    async function copyText(text) {
        try {
            if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
        } catch (e) { /* fall through */ }
        try {
            const ta = document.createElement("textarea");
            ta.value = text;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand && document.execCommand("copy");
            document.body.removeChild(ta);
            return !!ok;
        } catch (e) { return false; }
    }

    async function copyCode() {
        const ok = await copyText(codeText.textContent);
        say(note, ok ? "Code copied." : "Couldn't copy. Press and hold the code to copy it.", ok ? "ok" : "error");
        setTimeout(function () { say(note, "", ""); render(); }, 2500);
    }

    async function shareLink() {
        const code = codeText.textContent;
        const url = pageUrl(code);
        if (navigator.share) {
            try {
                await navigator.share({ title: "Tic Tac Toe", text: "Join my " + GAME_NAME + " Tic Tac Toe game. Room code: " + code, url: url });
                return;
            } catch (e) {
                if (e && e.name === "AbortError") return;            // the player closed the share sheet
            }
        }
        const ok = await copyText(url);
        say(note, ok ? "Link copied. Send it to your friend." : "Couldn't copy the link: " + url, ok ? "ok" : "error");
        setTimeout(function () { say(note, "", ""); render(); }, 3500);
    }

    /* ---------------- wiring ---------------- */

    createBtn.addEventListener("click", createRoom);
    joinBtn.addEventListener("click", function () { joinWith(codeInput.value); });
    spectateBtn.addEventListener("click", function () { spectateWith(codeInput.value); });
    if (homeLink) homeLink.addEventListener("click", onHomeClicked);
    codeInput.addEventListener("keydown", function (e) { if (e.key === "Enter") joinWith(codeInput.value); });
    codeInput.addEventListener("input", function () {
        const pos = codeInput.selectionStart;
        codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
        try { codeInput.setSelectionRange(pos, pos); } catch (e) { /* not supported */ }
    });
    copyBtn.addEventListener("click", copyCode);
    shareBtn.addEventListener("click", shareLink);
    leaveCardBtn.addEventListener("click", leaveRoom);
    leaveBtn.addEventListener("click", leaveRoom);
    rematchBtn.addEventListener("click", rematch);
    claimBtn.addEventListener("click", claimWin);
    if (window.GameView) window.GameView.onOnlineClick = onCellTapped;

    // A shared link (?room=CODE) switches this page to Online mode by itself.
    if (new URLSearchParams(location.search).get("room") && !GameOptions.get().online) {
        GameOptions.set({ mode: "online" });
    }
    GameOptions.onChange(applyMode);
    applyMode();
})();
