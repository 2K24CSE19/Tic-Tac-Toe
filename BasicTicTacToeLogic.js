const cells = document.querySelectorAll(".cell");
const statusBar = document.querySelector("#statusBar");
const restartBtn = document.querySelector("#restartBtn");
const overlay = document.querySelector("#overlay");
const winnerChar = document.querySelector("#winnerChar");
const winConditions = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6]
];
let options = ["", "", "", "", "", "", "", "", ""];
let currentPlayer = "X";
let running = false;

let settings = GameOptions.get();   // 2 players or vs computer (see GameOptions.js)
let gameToken = 0;                  // changes on every restart, so a late computer move can be ignored

initializeGame();

function initializeGame() {
    cells.forEach(cell => cell.addEventListener("click", cellClicked));
    restartBtn.addEventListener("click", restartGame);
    GameOptions.onChange(function () {
        settings = GameOptions.get();
        restartGame();
    });
    running = true;
    updateStatus();
    syncEffects();                          // baseline, so the first win AFTER this is animated
    maybeComputerMove();
}

/* ---------- who is playing ---------- */

function computerSide() {
    return settings.side === "X" ? "O" : "X";
}

function isComputerTurn() {
    return settings.vsComputer && running && currentPlayer === computerSide();
}

function updateStatus() {
    if (settings.online) return;            // the online panel writes the status text itself
    if (!settings.vsComputer) {
        statusBar.textContent = `${currentPlayer}'s turn`;
    } else if (currentPlayer === computerSide()) {
        statusBar.textContent = `Computer (${currentPlayer}) is thinking...`;
    } else {
        statusBar.textContent = `Your turn (${currentPlayer})`;
    }
}

function winnerText(player) {
    if (!settings.vsComputer) return `${player} wins!`;
    return player === computerSide() ? "Computer wins!" : "You win!";
}

/* ---------- turns ---------- */

function cellClicked() {
    const index = Number(this.getAttribute("cellIndex"));
    if (settings.online) {                  // online games are played through the room (see OnlinePanel.js)
        if (window.GameView && GameView.onOnlineClick) GameView.onOnlineClick(0, index);
        return;
    }
    if (isComputerTurn()) return;           // ignore taps while it's the computer's turn
    playMove(index);
}

function playMove(index) {
    if (options[index] != "" || !running) {
        return;
    }

    updateCell(cells[index], index);
    checkWinner();
}

function maybeComputerMove() {
    if (!isComputerTurn()) return;

    const token = gameToken;
    updateStatus();
    setTimeout(function () {
        if (token !== gameToken || !running) return;    // game was restarted meanwhile
        const move = TTTBot.basic.chooseMove(options, currentPlayer, settings.difficulty);
        if (move >= 0) playMove(move);
    }, 450);
}

function updateCell(cell, index) {
    options[index] = currentPlayer;
    cell.textContent = currentPlayer;
    cell.classList.add(currentPlayer);
    cell.classList.add("disabled");
}

function changePlayer() {
    currentPlayer = (currentPlayer == "X") ? "O" : "X";
    updateStatus();
}

function checkWinner() {
    let roundWon = false;

    for (let i = 0; i < winConditions.length; i++) {
        const condition = winConditions[i];
        const cellA = options[condition[0]];
        const cellB = options[condition[1]];
        const cellC = options[condition[2]];

        if (cellA == "" || cellB == "" || cellC == "") {
            continue;
        }
        if (cellA == cellB && cellB == cellC) {
            roundWon = true;
            break;
        }
    }

    if (roundWon) {
        statusBar.textContent = winnerText(currentPlayer);
        showWinner(currentPlayer);
        running = false;
        syncEffects();                      // winning line
        announceResult(currentPlayer);
    } else if (!options.includes("")) {
        statusBar.textContent = `Draw!`;
        running = false;
        announceResult("draw");
    } else {
        changePlayer();
        maybeComputerMove();
    }
}

function showWinner(winner) {
    winnerChar.textContent = winner;
    winnerChar.classList.add(winner);
    overlay.style.display = "flex";
}

function restartGame() {
    gameToken++;
    currentPlayer = "X";
    options = ["", "", "", "", "", "", "", "", ""];
    cells.forEach(cell => {
        cell.textContent = "";
        cell.classList.remove("X");
        cell.classList.remove("O");
        cell.classList.remove("disabled");
        cell.classList.remove("lastMove");
    });
    overlay.style.display = "none";
    winnerChar.classList.remove("X");
    winnerChar.classList.remove("O");
    Effects.reset();                        // forget the old game's line / result
    Effects.hideResult();
    restartBtn.classList.remove("attention");
    syncEffects();
    running = true;
    updateStatus();
    maybeComputerMove();
}

/* ---------- online games: show whatever position the room says ---------- */

window.GameView = {
    onOnlineClick: null,                    // set by OnlinePanel.js: called with (board, cell) when a cell is tapped online

    // g = MultiplayerCore.roomToGame(room); view = { playing, interactive }
    showOnline: function (g, view) {
        options = g.boardStates[0].slice();
        currentPlayer = g.currentPlayer || "X";
        running = !!view.playing && !g.over;

        cells.forEach((cell, i) => {
            const v = options[i];
            cell.textContent = v;
            cell.classList.toggle("X", v === "X");
            cell.classList.toggle("O", v === "O");
            cell.classList.toggle("lastMove", !!(g.last && g.last.c === i));
            cell.classList.toggle("disabled", v !== "" || !view.interactive);
        });

        winnerChar.classList.remove("X", "O");
        winnerChar.textContent = "";
        if (g.winner === "X" || g.winner === "O") showWinner(g.winner);
        else overlay.style.display = "none";
        syncEffects();
    }
};

/* ---------- winning line and the result banner ---------- */

function syncEffects() {
    Effects.syncBasic(document.querySelector(".cellContainer"), options);
}

// Offline games only (online results are announced by OnlinePanel.js).
function announceResult(w) {
    restartBtn.classList.add("attention");  // make the next step obvious: Reset glows until it is pressed
    let kind, title, sub = "";
    if (w === "draw") { kind = "draw"; title = "It's a draw!"; }
    else if (settings.vsComputer) {
        if (w === computerSide()) { kind = "lose"; title = "You Lost!"; sub = "The computer won this one."; }
        else { kind = "win"; title = "Congratulations! You Win!"; }
    } else { kind = "win"; title = "Congratulations! " + w + " Wins!"; }
    Effects.result({ kind: kind, title: title, sub: sub, live: true });
}
