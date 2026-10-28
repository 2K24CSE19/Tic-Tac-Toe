/* Draws the two little decorative game boards on the landing page. */

const previewBasic = document.querySelector("#previewBasic");
const previewUltimate = document.querySelector("#previewUltimate");

// "." = empty square
const basicCells = "XO..XO.OX";   // X wins on the diagonal

const ultimateBoards = [
    { cells: "XO.OX..OX", winner: "X" },
    { cells: "O.X.O...." },
    { cells: "..O.X.O.." },
    { cells: "X.O.XO..." },
    { cells: "OXXXO.O.O", winner: "O" },
    { cells: ".X..O...." },
    { cells: "..X.O.X.." },
    { cells: "O..X....." },
    { cells: "X.O.X....", active: true }
];

function makeCell(ch) {
    const cell = document.createElement("div");
    cell.className = "miniCell" + (ch === "X" ? " X" : ch === "O" ? " O" : "");
    cell.textContent = ch === "." ? "" : ch;
    return cell;
}

function makeSmallBoard(cells, extraClass) {
    const board = document.createElement("div");
    board.className = "miniBoard" + (extraClass ? " " + extraClass : "");
    for (const ch of cells) board.appendChild(makeCell(ch));
    return board;
}

previewBasic.appendChild(makeSmallBoard(basicCells, "single"));

const grid = document.createElement("div");
grid.className = "miniGrid";
for (const b of ultimateBoards) {
    const board = makeSmallBoard(b.cells, b.active ? "active" : "");
    if (b.winner) board.dataset.winner = b.winner;
    grid.appendChild(board);
}
previewUltimate.appendChild(grid);

/* ---------- a hidden Easter egg: click the word "Toe" in the title three times within 2 seconds ---------- */

(function () {
    const toe = document.getElementById("toeWord");
    if (!toe) return;

    const NEEDED = 3;
    const WITHIN_MS = 2000;
    const MESSAGE = "Congratulations! You found an Easter egg. Now try finding another one... maybe there isn't one.";
    let clicks = [];                       // times of the most recent clicks on "Toe"
    let overlay = null;
    let previousFocus = null;

    // Only clicks on the word "Toe" count. Clicks on the rest of the title (or anywhere else) are simply ignored.
    toe.addEventListener("click", function () {
        const now = Date.now();
        clicks.push(now);
        clicks = clicks.filter(function (t) { return now - t <= WITHIN_MS; }).slice(-NEEDED);
        if (clicks.length >= NEEDED) {
            clicks = [];
            showEgg();
        }
    });

    function showEgg() {
        if (overlay) return;
        previousFocus = document.activeElement;
        overlay = document.createElement("div");
        overlay.className = "eggOverlay";
        overlay.setAttribute("role", "dialog");
        overlay.setAttribute("aria-modal", "true");
        overlay.setAttribute("aria-labelledby", "eggText");
        overlay.innerHTML = '<div class="eggCard"><div class="eggEmoji" aria-hidden="true">\uD83E\uDD5A</div>' +
            '<p id="eggText"></p><button type="button" class="btn primary eggClose">Got it</button></div>';
        overlay.querySelector("#eggText").textContent = MESSAGE;
        document.body.appendChild(overlay);

        // playful: the egg wobbles, then cracks open
        const egg = overlay.querySelector(".eggEmoji");
        const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!reduce) setTimeout(function () { if (overlay) egg.textContent = "\uD83D\uDC23"; }, 1000);

        overlay.addEventListener("click", function (e) { if (e.target === overlay) hideEgg(); });     // tap outside the card
        overlay.querySelector(".eggClose").addEventListener("click", hideEgg);
        document.addEventListener("keydown", onKey);
        overlay.querySelector(".eggClose").focus();
    }

    function onKey(e) {
        if (e.key === "Escape") hideEgg();
        else if (e.key === "Tab" && overlay) { e.preventDefault(); overlay.querySelector(".eggClose").focus(); }   // keep focus inside the dialog
    }

    function hideEgg() {
        if (!overlay) return;
        overlay.remove();
        overlay = null;
        document.removeEventListener("keydown", onKey);
        if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
})();
