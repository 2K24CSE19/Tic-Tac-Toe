const grid = document.querySelector("#grid");

const boardNames = [
    "top-left", "top-center", "top-right",
    "middle-left", "center", "middle-right",
    "bottom-left", "bottom-center", "bottom-right"
];

buildGrid();   // create the 9 boards x 9 cells before we look them up

const cells = document.querySelectorAll(".cell");
const boards = document.querySelectorAll(".cellContainer");
const statusBar = document.querySelector("#statusBar");
const restartBtn = document.querySelector("#restartBtn");

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

let boardStates = Array(9).fill().map(() => Array(9).fill(""));
let overallBoardState = Array(9).fill("");   // "" = open, "X"/"O" = won, "draw" = tied
let currentPlayer = "X";
let running = false;
let nextBoardIndex = null;                   // null = free turn (play in any open board)

let settings = GameOptions.get();            // 2 players or vs computer (see GameOptions.js)
let gameToken = 0;                           // changes on every restart, so a late computer move can be ignored

initializeGame();

function initializeGame() {
    cells.forEach(cell => cell.addEventListener("click", cellClicked));
    restartBtn.addEventListener("click", restartGame);
    GameOptions.onChange(function () {
        settings = GameOptions.get();
        restartGame();
    });
    running = true;
    updateBoardStates();
    updateStatus();
    syncEffects();
    maybeComputerMove();
}

/* ---------- who is playing ---------- */

function computerSide() {
    return settings.side === "X" ? "O" : "X";
}

function isComputerTurn() {
    return settings.vsComputer && running && currentPlayer === computerSide();
}

// "X wins" in 2-player mode, "You win" / "Computer wins" against the computer.
function winnerName(player) {
    if (!settings.vsComputer) return `${player} wins`;
    return player === computerSide() ? "Computer wins" : "You win";
}

/* ---------- setup ---------- */

function buildGrid() {
    for (let b = 0; b < 9; b++) {
        const board = document.createElement("div");
        board.className = "cellContainer";
        board.id = `C${b}`;
        board.dataset.board = b;

        for (let c = 0; c < 9; c++) {
            const cell = document.createElement("div");
            cell.className = "cell";
            cell.id = `C${b}-${c}`;
            cell.setAttribute("cellIndex", `${b}-${c}`);
            cell.setAttribute("role", "button");
            cell.setAttribute("aria-label", `${boardNames[b]} board, cell ${c + 1}`);
            board.appendChild(cell);
        }
        grid.appendChild(board);
    }
}

/* ---------- helpers ---------- */

function isBoardOpen(boardIndex) {
    return overallBoardState[boardIndex] === "";
}

// Returns "X" or "O" if that player has 3 in a row in `state`, otherwise null.
// Only real marks count, so three "draw" boards in a row never win.
function findLineWinner(state) {
    for (const [a, b, c] of winConditions) {
        if ((state[a] === "X" || state[a] === "O") && state[a] === state[b] && state[a] === state[c]) {
            return state[a];
        }
    }
    return null;
}

/* ---------- turn handling ---------- */

function cellClicked() {
    const [boardIndex, cellIndex] = this.getAttribute("cellIndex").split("-").map(Number);
    if (settings.online) {                  // online games are played through the room (see OnlinePanel.js)
        if (window.GameView && GameView.onOnlineClick) GameView.onOnlineClick(boardIndex, cellIndex);
        return;
    }
    if (isComputerTurn()) return;           // ignore taps while it's the computer's turn
    playMove(boardIndex, cellIndex);
}

function playMove(boardIndex, cellIndex) {
    if (!running) return;
    if (boardStates[boardIndex][cellIndex] !== "") return;                         // cell already used
    if (!isBoardOpen(boardIndex)) return;                                          // board already won / tied
    if (nextBoardIndex !== null && nextBoardIndex !== boardIndex) return;          // wrong board

    updateCell(document.querySelector(`#C${boardIndex}-${cellIndex}`), boardIndex, cellIndex);
    checkBoardWinner(boardIndex);

    if (checkOverallWinner()) {
        updateBoardStates();   // game over: clear highlights, lock the grid
        syncEffects();         // winning lines
        announceResult();      // banner + celebration / defeat
        return;                // keep the final message on screen
    }

    // Destination rule: the cell you played picks the opponent's board.
    // If that board is closed (won / full / tied) the opponent gets a free turn.
    nextBoardIndex = isBoardOpen(cellIndex) ? cellIndex : null;

    changePlayer();
    updateBoardStates();
    updateStatus();
    syncEffects();
    maybeComputerMove();
}

function maybeComputerMove() {
    if (!isComputerTurn()) return;

    const token = gameToken;
    updateStatus();
    setTimeout(function () {
        if (token !== gameToken || !running) return;    // game was restarted meanwhile
        const move = TTTBot.ultimate.chooseMove({
            cells: boardStates,
            meta: overallBoardState,
            next: nextBoardIndex,
            player: currentPlayer
        }, settings.difficulty);
        if (move) playMove(move.board, move.cell);
    }, 450);
}

function updateCell(cell, boardIndex, cellIndex) {
    boardStates[boardIndex][cellIndex] = currentPlayer;
    cell.textContent = currentPlayer;
    cell.classList.add(currentPlayer);
}

function changePlayer() {
    currentPlayer = (currentPlayer === "X") ? "O" : "X";
}

/* ---------- small boards ---------- */

function checkBoardWinner(boardIndex) {
    const board = document.querySelector(`#C${boardIndex}`);
    const winner = findLineWinner(boardStates[boardIndex]);

    if (winner) {
        overallBoardState[boardIndex] = winner;
        board.dataset.winner = winner;          // CSS draws the big X / O from this
        board.classList.add(`won${winner}`);
    } else if (!boardStates[boardIndex].includes("")) {
        overallBoardState[boardIndex] = "draw"; // full, no line: claimed by neither
        board.classList.add("drawn");
    }
}

/* ---------- master grid ---------- */

// Returns true if the game is over (and writes the result to the status bar).
function checkOverallWinner() {
    const lineWinner = findLineWinner(overallBoardState);

    if (lineWinner) {
        gameResult = lineWinner;
        statusBar.textContent = `${winnerName(lineWinner)} the game!`;
        running = false;
        return true;
    }

    if (!overallBoardState.includes("")) {
        // Master grid is full with no 3-in-a-row: most small boards wins.
        const xBoards = overallBoardState.filter(s => s === "X").length;
        const oBoards = overallBoardState.filter(s => s === "O").length;

        if (xBoards > oBoards) {
            gameResult = "X";
            statusBar.textContent = `${winnerName("X")} on boards, ${xBoards} to ${oBoards}!`;
        } else if (oBoards > xBoards) {
            gameResult = "O";
            statusBar.textContent = `${winnerName("O")} on boards, ${oBoards} to ${xBoards}!`;
        } else {
            gameResult = "draw";
            statusBar.textContent = `It's a draw! (${xBoards} boards each)`;
        }
        running = false;
        return true;
    }

    return false;
}

/* ---------- display ---------- */

// lockInput = true: show where play is happening but don't let this player click (e.g. the opponent's turn online)
function updateBoardStates(lockInput) {
    boards.forEach((board, i) => {
        const playable = running && isBoardOpen(i) && (nextBoardIndex === null || nextBoardIndex === i);
        board.classList.toggle("active", playable);
        // green = the person looking at the screen can play here now; yellow = it is somebody else's move
        board.classList.toggle("mine", playable && !lockInput && !isComputerTurn());
    });

    cells.forEach(cell => {
        const boardIndex = Number(cell.getAttribute("cellIndex").split("-")[0]);
        const playable = running && isBoardOpen(boardIndex) && (nextBoardIndex === null || nextBoardIndex === boardIndex);
        cell.classList.toggle("disabled", !playable || !!lockInput);
    });
}

function updateStatus() {
    if (settings.online) return;            // the online panel writes the status text itself
    const where = nextBoardIndex === null
        ? "play in any open board"
        : `play in the ${boardNames[nextBoardIndex]} board`;

    if (!settings.vsComputer) {
        statusBar.textContent = `${currentPlayer}'s turn - ${where}`;
    } else if (currentPlayer === computerSide()) {
        statusBar.textContent = `Computer (${currentPlayer}) is thinking...`;
    } else {
        statusBar.textContent = `Your turn (${currentPlayer}) - ${where}`;
    }
}

function restartGame() {
    gameToken++;
    currentPlayer = "X";
    boardStates = Array(9).fill().map(() => Array(9).fill(""));
    overallBoardState = Array(9).fill("");
    nextBoardIndex = null;
    gameResult = null;
    Effects.reset();                  // forget the old game's lines / result
    Effects.hideResult();
    restartBtn.classList.remove("attention");

    cells.forEach(cell => {
        cell.textContent = "";
        cell.classList.remove("X", "O", "disabled", "lastMove");
    });
    boards.forEach(board => {
        board.classList.remove("wonX", "wonO", "drawn", "active", "mine");
        delete board.dataset.winner;
    });

    running = true;
    updateBoardStates();
    updateStatus();
    syncEffects();
    maybeComputerMove();
}

/* ---------- online games: show whatever position the room says ---------- */

window.GameView = {
    onOnlineClick: null,                    // set by OnlinePanel.js: called with (board, cell) when a cell is tapped online

    // g = MultiplayerCore.roomToGame(room); view = { playing, interactive }
    showOnline: function (g, view) {
        boardStates = g.boardStates.map(row => row.slice());
        overallBoardState = g.overallBoardState.slice();
        nextBoardIndex = g.nextBoardIndex;
        currentPlayer = g.currentPlayer || "X";
        running = !!view.playing && !g.over;

        cells.forEach(cell => {
            const [b, c] = cell.getAttribute("cellIndex").split("-").map(Number);
            const v = boardStates[b][c];
            cell.textContent = v;
            cell.classList.toggle("X", v === "X");
            cell.classList.toggle("O", v === "O");
            cell.classList.toggle("lastMove", !!(g.last && g.last.b === b && g.last.c === c));
        });
        boards.forEach((board, i) => {
            const r = overallBoardState[i];
            board.classList.toggle("wonX", r === "X");
            board.classList.toggle("wonO", r === "O");
            board.classList.toggle("drawn", r === "draw");
            if (r === "X" || r === "O") board.dataset.winner = r; else delete board.dataset.winner;
        });
        updateBoardStates(!view.interactive);
        syncEffects();
    }
};

/* ---------- winning lines and the result banner ---------- */

let gameResult = null;                      // "X" | "O" | "draw" once an offline game has finished

function syncEffects() {
    Effects.syncUltimate({ grid: grid, boards: Array.from(boards), boardStates: boardStates, overall: overallBoardState });
}

// Offline games only (online results are announced by OnlinePanel.js).
function announceResult() {
    const w = gameResult;
    restartBtn.classList.add("attention");  // make the next step obvious: Reset glows until it is pressed
    let kind, title, sub = "";
    if (w === "draw") { kind = "draw"; title = "It's a draw!"; }
    else if (settings.vsComputer) {
        if (w === computerSide()) { kind = "lose"; title = "You Lost!"; sub = "The computer won this one."; }
        else { kind = "win"; title = "Congratulations! You Win!"; }
    } else { kind = "win"; title = "Congratulations! " + w + " Wins!"; }
    Effects.result({ kind: kind, title: title, sub: sub, live: true });
}
