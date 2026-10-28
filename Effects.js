/*
 * Visual effects shared by both games (no libraries):
 *   - winning lines: an animated SVG line through the three winning cells (Basic board, each won Ultimate mini-board,
 *     and across the three winning mini-boards when an Ultimate match is won)
 *   - a result banner (win / lose / draw / neutral) with a light confetti or rain effect on a canvas
 * Everything respects "prefers-reduced-motion" (no animation, no particles; the banner and lines still appear).
 *
 * The functions only DISPLAY what the game says. They never decide who won.
 */
(function () {
    "use strict";

    const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    const SVGNS = "http://www.w3.org/2000/svg";
    const SEEN_KEY = "ttt-results-seen";

    function reducedMotion() {
        try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
        catch (e) { return false; }
    }

    /* ---------------- finding lines ---------------- */

    // the three cells of a line completed by `mark` (or null)
    function lineFor(cells, mark) {
        for (const l of LINES) if (cells[l[0]] === mark && cells[l[1]] === mark && cells[l[2]] === mark) return l;
        return null;
    }
    // { mark, line } for the first X or O line, else null
    function lineWinner(cells) {
        for (const l of LINES) {
            const v = cells[l[0]];
            if ((v === "X" || v === "O") && v === cells[l[1]] && v === cells[l[2]]) return { mark: v, line: l };
        }
        return null;
    }

    /* ---------------- drawing lines ---------------- */

    function center(i) { return { x: ((i % 3) + 0.5) / 3 * 100, y: (Math.floor(i / 3) + 0.5) / 3 * 100 }; }

    // The SVG uses percentages of its host (a 3x3 grid), so it stays aligned at every screen size.
    function drawLine(host, line, mark, animate, extraClass) {
        const svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("viewBox", "0 0 100 100");
        svg.setAttribute("preserveAspectRatio", "none");
        svg.setAttribute("class", "winLine " + mark + (animate && !reducedMotion() ? " animate" : " static") + (extraClass ? " " + extraClass : ""));
        svg.setAttribute("aria-hidden", "true");
        const a = center(line[0]), b = center(line[2]);
        ["halo", "core"].forEach(function (cls) {                  // a soft outline under the coloured line keeps it readable on any cell colour
            const ln = document.createElementNS(SVGNS, "line");
            ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
            ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
            ln.setAttribute("pathLength", "1");
            ln.setAttribute("class", cls);
            svg.appendChild(ln);
        });
        host.appendChild(svg);
        return svg;
    }

    let shown = new WeakMap();                                      // host -> key of the line currently drawn there

    function setLine(host, spec, animate, extraClass) {
        if (!host) return;
        const key = spec ? spec.mark + ":" + spec.line.join("") : "";
        if ((shown.get(host) || "") === key) return;
        host.querySelectorAll(":scope > .winLine").forEach(function (e) { e.remove(); });
        shown.set(host, key);
        if (spec) drawLine(host, spec.line, spec.mark, animate, extraClass);
    }

    // "live" = we have already shown this game once in this page, so a NEW win is animated.
    // The first sync after loading a page (or after reset()) just shows lines without animating (e.g. after a refresh).
    let prevBasic = null, prevUltimate = null;

    // Forget the previous game: remove any drawn lines, and treat the next sync as a fresh start (no animation).
    function reset() {
        prevBasic = null;
        prevUltimate = null;
        shown = new WeakMap();
        document.querySelectorAll("svg.winLine").forEach(function (e) { e.remove(); });
    }

    function syncBasic(boardEl, cells) {
        const w = lineWinner(cells);
        const live = prevBasic !== null;
        setLine(boardEl, w, live && !prevBasic);
        prevBasic = !!w;
    }

    // args: { grid, boards: [9 mini-board elements], boardStates: [9][9], overall: [9] }
    function syncUltimate(a) {
        const live = prevUltimate !== null;
        for (let b = 0; b < 9; b++) {
            const mark = a.overall[b];
            let spec = null;
            if (mark === "X" || mark === "O") { const l = lineFor(a.boardStates[b], mark); if (l) spec = { mark: mark, line: l }; }
            setLine(a.boards[b], spec, live && !(prevUltimate.overall[b] === mark));
        }
        const mw = lineWinner(a.overall);                            // three mini-boards in a row = the match is won
        setLine(a.grid, mw, live && !prevUltimate.master, "master");
        prevUltimate = { overall: a.overall.slice(), master: !!mw };
    }

    /* ---------------- results ---------------- */

    let banner = null, card = null, titleEl = null, subEl = null, hideTimer = null;
    let canvas = null, raf = 0;

    function ensureBanner() {
        if (banner) return;
        banner = document.createElement("div");
        banner.className = "resultBanner";
        banner.hidden = true;
        banner.setAttribute("role", "status");
        banner.setAttribute("aria-live", "polite");
        banner.innerHTML = '<div class="resultCard"><h2 class="resultTitle"></h2><p class="resultSub"></p>' +
            '<button type="button" class="resultClose" aria-label="Dismiss">\u00D7</button></div>';
        document.body.appendChild(banner);
        card = banner.querySelector(".resultCard");
        titleEl = banner.querySelector(".resultTitle");
        subEl = banner.querySelector(".resultSub");
        banner.querySelector(".resultClose").addEventListener("click", hideResult);
    }

    function stopParticles() {
        if (raf && window.cancelAnimationFrame) window.cancelAnimationFrame(raf);
        raf = 0;
        if (canvas) { canvas.remove(); canvas = null; }
    }

    // mode: "confetti" (win) or "rain" (defeat: a few slow grey-blue drops)
    function particles(mode) {
        stopParticles();
        if (!window.requestAnimationFrame) return;
        const c = document.createElement("canvas");
        c.className = "fxCanvas";
        c.setAttribute("aria-hidden", "true");
        const ctx = c.getContext && c.getContext("2d");
        if (!ctx) return;                                           // (no canvas support: just skip the effect)
        document.body.appendChild(c);
        canvas = c;
        const dpr = Math.min(window.devicePixelRatio || 1, 1.5);   // keep it light on phones
        let W = 0, H = 0;
        function size() { W = window.innerWidth; H = window.innerHeight; c.width = W * dpr; c.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }
        size();

        const colors = mode === "confetti" ? ["#e53935", "#1e63d6", "#ffd23f", "#2e9d4f", "#ff7ab8", "#7c4dff"] : ["#7f8da3", "#9aa7bb"];
        const count = mode === "confetti" ? 90 : 38;
        const duration = mode === "confetti" ? 3400 : 2600;
        const parts = [];
        for (let i = 0; i < count; i++) {
            parts.push({
                x: Math.random() * W, y: -20 - Math.random() * H * 0.4,
                vx: mode === "confetti" ? (Math.random() - 0.5) * 2.2 : (Math.random() - 0.5) * 0.4,
                vy: mode === "confetti" ? 2 + Math.random() * 3.2 : 2.5 + Math.random() * 2,
                s: mode === "confetti" ? 5 + Math.random() * 6 : 1.5 + Math.random() * 1.5,
                len: 10 + Math.random() * 12, rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.3,
                color: colors[i % colors.length]
            });
        }
        const start = performance.now();
        function frame(now) {
            if (!canvas) return;
            const t = now - start;
            ctx.clearRect(0, 0, W, H);
            ctx.globalAlpha = t > duration - 700 ? Math.max(0, (duration - t) / 700) : 1;   // fade out at the end
            for (const p of parts) {
                p.x += p.vx; p.y += p.vy; p.rot += p.vr;
                if (mode === "confetti") p.vy = Math.min(p.vy + 0.02, 5.5);
                ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
                if (mode === "confetti") { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); ctx.restore(); }
                else { ctx.lineWidth = p.s; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 3, p.y - p.len); ctx.stroke(); }
            }
            if (t < duration) raf = window.requestAnimationFrame(frame); else stopParticles();
        }
        raf = window.requestAnimationFrame(frame);
    }

    /*
     * opts: { kind: "win" | "lose" | "draw" | "neutral", title, sub, live }
     *   live = the result just happened in front of the player (so play the particle effect). When false (e.g. the page
     *   was opened after the match ended) the banner is shown calmly, without particles.
     */
    function result(opts) {
        ensureBanner();
        const kind = opts.kind || "neutral";
        card.className = "resultCard " + kind;
        titleEl.textContent = opts.title || "";
        subEl.textContent = opts.sub || "";
        subEl.hidden = !opts.sub;
        banner.hidden = false;
        if (!reducedMotion()) {
            void card.offsetWidth;                                  // restart the CSS animation
            card.classList.add("play");
            if (opts.live && kind === "win") particles("confetti");
            else if (opts.live && kind === "lose") particles("rain");
        }
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(hideResult, 9000);
    }

    function hideResult() {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (banner) banner.hidden = true;
        stopParticles();
    }

    // Has this finished match already been presented on this device? Returns true the FIRST time for a key.
    function markSeen(key) {
        try {
            const list = JSON.parse(localStorage.getItem(SEEN_KEY) || "[]");
            if (list.indexOf(key) >= 0) return false;
            list.push(key);
            localStorage.setItem(SEEN_KEY, JSON.stringify(list.slice(-40)));
        } catch (e) { /* no storage: just show it */ }
        return true;
    }

    window.Effects = {
        lineFor: lineFor, lineWinner: lineWinner,
        syncBasic: syncBasic, syncUltimate: syncUltimate, reset: reset,
        result: result, hideResult: hideResult, markSeen: markSeen, reducedMotion: reducedMotion
    };
})();
