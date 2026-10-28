/*
 * Computer opponent for both games. Pure logic: no page / DOM code in here.
 *
 *   TTTBot.basic.chooseMove(cells, player, difficulty)      -> cell index 0..8
 *   TTTBot.ultimate.chooseMove(snapshot, difficulty, opts)  -> { board, cell }
 *
 * Difficulties: "easy" | "medium" | "hard" | "impossible"
 *
 *              Basic                                   Ultimate
 *   easy       random move                             random legal move
 *   medium     wins / blocks, else random              looks one move ahead (small-board wins,
 *                                                      blocks, avoids sending you somewhere good)
 *   hard       perfect play, but slips 1 move in 5     searches 3 moves ahead, sometimes picks its
 *                                                      2nd/3rd best move
 *   impossible perfect play: it can never lose         searches as deep as it can in about 1 second
 *                                                      (Ultimate has no known perfect strategy, so this
 *                                                      is "extremely strong", not mathematically unbeatable)
 */
(function (root) {
    "use strict";

    const DIFFICULTIES = ["easy", "medium", "hard", "impossible"];

    const LINES = [
        [0, 1, 2], [3, 4, 5], [6, 7, 8],
        [0, 3, 6], [1, 4, 7], [2, 5, 8],
        [0, 4, 8], [2, 4, 6]
    ];
    const LINES_BY_CELL = Array.from({ length: 9 }, (_, c) => LINES.filter(l => l.includes(c)));

    function randInt(rng, n) { return Math.floor(rng() * n); }
    function pick(rng, arr) { return arr[randInt(rng, arr.length)]; }
    function shuffle(rng, arr) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = randInt(rng, i + 1);
            const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }

    /* ======================================================================
     *  BASIC (one 3x3 board) - small enough to solve completely
     * ==================================================================== */
    const Basic = (function () {
        const memo = new Map();

        function winner(c) {
            for (const l of LINES) {
                if (c[l[0]] && c[l[0]] === c[l[1]] && c[l[0]] === c[l[2]]) return c[l[0]];
            }
            return null;
        }

        // Score for `me` with `turn` to move: positive = I win, negative = I lose. Faster wins score higher.
        function minimax(c, turn, me, depth) {
            const w = winner(c);
            if (w) return w === me ? 10 - depth : depth - 10;
            if (!c.includes("")) return 0;

            const key = c.map(x => x || "-").join("") + turn + me;
            if (memo.has(key)) return memo.get(key);

            const other = turn === "X" ? "O" : "X";
            let best = turn === me ? -Infinity : Infinity;
            for (let i = 0; i < 9; i++) {
                if (c[i] !== "") continue;
                c[i] = turn;
                const v = minimax(c, other, me, depth + 1);
                c[i] = "";
                best = turn === me ? Math.max(best, v) : Math.min(best, v);
            }
            memo.set(key, best);
            return best;
        }

        function perfectMove(c, player, rng) {
            const other = player === "X" ? "O" : "X";
            let bestScore = -Infinity;
            let bestMoves = [];
            for (let i = 0; i < 9; i++) {
                if (c[i] !== "") continue;
                c[i] = player;
                const v = minimax(c, other, player, 1);
                c[i] = "";
                if (v > bestScore) { bestScore = v; bestMoves = [i]; }
                else if (v === bestScore) bestMoves.push(i);
            }
            return pick(rng, bestMoves);
        }

        function winningCell(c, p) {
            for (let i = 0; i < 9; i++) {
                if (c[i] !== "") continue;
                c[i] = p;
                const w = winner(c);
                c[i] = "";
                if (w === p) return i;
            }
            return -1;
        }

        function mediumMove(c, player, rng, empties) {
            const other = player === "X" ? "O" : "X";
            let m = winningCell(c, player);
            if (m >= 0) return m;
            m = winningCell(c, other);
            if (m >= 0) return m;
            return pick(rng, empties);
        }

        function chooseMove(cells, player, difficulty, opts) {
            const rng = (opts && opts.rng) || Math.random;
            const c = cells.slice();
            const empties = [];
            for (let i = 0; i < 9; i++) if (c[i] === "") empties.push(i);
            if (!empties.length) return -1;

            switch (difficulty) {
                case "easy":
                    return pick(rng, empties);
                case "medium":
                    return mediumMove(c, player, rng, empties);
                case "hard":
                    // plays perfectly, except about 1 move in 5 where it only plays "medium"
                    return rng() < 0.2 ? mediumMove(c, player, rng, empties) : perfectMove(c, player, rng);
                default:
                    return perfectMove(c, player, rng);
            }
        }

        return { chooseMove, winner };
    })();

    /* ======================================================================
     *  ULTIMATE (9 boards x 9 cells)
     *
     *  Internal state (fast typed arrays, 0 = empty, 1 = X, 2 = O, 3 = tied board):
     *    cells[81]   cell b*9+c is cell c of board b
     *    meta[9]     result of each small board
     *    next        board the player to move must use, or -1 for a free turn
     *    player      1 or 2 (side to move)
     * ==================================================================== */
    const Ultimate = (function () {
        const WIN = 100000;
        const INF = 1e9;
        const BOARD_W = [35, 30, 35, 30, 40, 30, 35, 30, 35];   // value of claiming each small board
        const META_W = [0, 12, 60, 0];                          // big-grid lines: 0 / 1 / 2 boards of mine
        const SMALL_W = [0, 1, 5, 0];                           // small-board lines: 0 / 1 / 2 marks of mine

        function code(ch) { return ch === "X" ? 1 : ch === "O" ? 2 : ch === "draw" ? 3 : 0; }

        // snapshot = { cells: boardStates (9 arrays of 9), meta: overallBoardState (9), next: index|null, player: "X"|"O" }
        function fromSnapshot(snap) {
            const s = {
                cells: new Int8Array(81),
                meta: new Int8Array(9),
                next: (snap.next === null || snap.next === undefined) ? -1 : snap.next,
                player: snap.player === "X" ? 1 : 2,
                over: false,
                winner: 0,
                stack: []
            };
            for (let b = 0; b < 9; b++) {
                s.meta[b] = code(snap.meta[b]);
                for (let c = 0; c < 9; c++) s.cells[b * 9 + c] = code(snap.cells[b][c]);
            }
            if (s.next >= 0 && s.meta[s.next] !== 0) s.next = -1;
            return s;
        }

        function legalMoves(s) {
            const out = [];
            if (s.over) return out;
            if (s.next >= 0) {
                const base = s.next * 9;
                for (let c = 0; c < 9; c++) if (s.cells[base + c] === 0) out.push(base + c);
            } else {
                for (let b = 0; b < 9; b++) {
                    if (s.meta[b] !== 0) continue;
                    const base = b * 9;
                    for (let c = 0; c < 9; c++) if (s.cells[base + c] === 0) out.push(base + c);
                }
            }
            return out;
        }

        // Same rules as the page: win a board, tied boards belong to nobody, sent-to-closed-board = free turn,
        // 3 boards in a row wins, full grid -> most boards wins (equal = draw).
        function makeMove(s, idx) {
            const b = (idx / 9) | 0;
            const base = b * 9;
            const c = idx - base;
            const p = s.player;
            const cells = s.cells;

            s.stack.push(idx, s.meta[b], s.next, s.over ? 1 : 0, s.winner);
            cells[idx] = p;

            let r = 0;
            const ls = LINES_BY_CELL[c];
            for (let i = 0; i < ls.length; i++) {
                const l = ls[i];
                if (cells[base + l[0]] === p && cells[base + l[1]] === p && cells[base + l[2]] === p) { r = p; break; }
            }
            if (r === 0) {
                let full = true;
                for (let i = 0; i < 9; i++) if (cells[base + i] === 0) { full = false; break; }
                if (full) r = 3;
            }

            if (r !== 0) {
                s.meta[b] = r;
                if (r === p) {
                    const ml = LINES_BY_CELL[b];
                    for (let i = 0; i < ml.length; i++) {
                        const l = ml[i];
                        if (s.meta[l[0]] === p && s.meta[l[1]] === p && s.meta[l[2]] === p) {
                            s.over = true; s.winner = p; break;
                        }
                    }
                }
                if (!s.over) {
                    let open = false, x = 0, o = 0;
                    for (let i = 0; i < 9; i++) {
                        const m = s.meta[i];
                        if (m === 0) open = true; else if (m === 1) x++; else if (m === 2) o++;
                    }
                    if (!open) { s.over = true; s.winner = x > o ? 1 : (o > x ? 2 : 3); }
                }
            }

            s.next = s.meta[c] === 0 ? c : -1;
            s.player = 3 - p;
        }

        function undoMove(s) {
            const winner = s.stack.pop();
            const over = s.stack.pop();
            const next = s.stack.pop();
            const metaB = s.stack.pop();
            const idx = s.stack.pop();
            s.cells[idx] = 0;
            s.meta[(idx / 9) | 0] = metaB;
            s.next = next;
            s.over = over === 1;
            s.winner = winner;
            s.player = 3 - s.player;
        }

        // Would player p complete a line on board b by playing cell c?
        function winsCell(cells, b, c, p) {
            const base = b * 9;
            const ls = LINES_BY_CELL[c];
            for (let i = 0; i < ls.length; i++) {
                const l = ls[i];
                let ok = true;
                for (let k = 0; k < 3; k++) {
                    const cc = l[k];
                    if (cc !== c && cells[base + cc] !== p) { ok = false; break; }
                }
                if (ok) return true;
            }
            return false;
        }

        function hasWinningCell(cells, b, p) {
            const base = b * 9;
            for (let c = 0; c < 9; c++) {
                if (cells[base + c] === 0 && winsCell(cells, b, c, p)) return true;
            }
            return false;
        }

        /* ---------- evaluation: score for the side to move ---------- */

        function evaluate(s) {
            const m = s.meta, cells = s.cells;
            let score = 0;                                   // from X's point of view

            for (let li = 0; li < 8; li++) {                 // lines on the big grid
                const l = LINES[li];
                let c1 = 0, c2 = 0, blocked = false;
                for (let k = 0; k < 3; k++) {
                    const v = m[l[k]];
                    if (v === 1) c1++; else if (v === 2) c2++; else if (v === 3) blocked = true;
                }
                if (!blocked) {
                    if (c2 === 0) score += META_W[c1];
                    if (c1 === 0) score -= META_W[c2];
                }
            }

            for (let b = 0; b < 9; b++) {
                const v = m[b];
                if (v === 1) score += BOARD_W[b];
                else if (v === 2) score -= BOARD_W[b];
                else if (v === 0) {                          // chances inside a small board that is still open
                    const base = b * 9;
                    let bs = 0;
                    for (let li = 0; li < 8; li++) {
                        const l = LINES[li];
                        let c1 = 0, c2 = 0;
                        for (let k = 0; k < 3; k++) {
                            const x = cells[base + l[k]];
                            if (x === 1) c1++; else if (x === 2) c2++;
                        }
                        if (c2 === 0) bs += SMALL_W[c1];
                        if (c1 === 0) bs -= SMALL_W[c2];
                    }
                    const centre = cells[base + 4];
                    if (centre === 1) bs += 2; else if (centre === 2) bs -= 2;
                    score += bs * (BOARD_W[b] / 30);
                }
            }

            if (s.next === -1) score += s.player === 1 ? 8 : -8;   // a free turn is worth having
            return s.player === 1 ? score : -score;
        }

        /* ---------- alpha-beta search ---------- */

        let nodes = 0, aborted = false, deadlineTs = 0;

        function moveOrderScore(s, idx) {
            const b = (idx / 9) | 0;
            const c = idx - b * 9;
            const p = s.player;
            let sc = 0;
            if (winsCell(s.cells, b, c, p)) sc += 100;
            else if (winsCell(s.cells, b, c, 3 - p)) sc += 40;
            if (s.meta[c] !== 0 && c !== b) sc -= 30;        // would hand the opponent a free turn
            if (c === 4) sc += 3; else if (c === 0 || c === 2 || c === 6 || c === 8) sc += 2;
            return sc;
        }

        function orderMoves(s, moves) {
            const n = moves.length;
            if (n < 2) return moves;
            const sc = new Array(n);
            for (let i = 0; i < n; i++) sc[i] = moveOrderScore(s, moves[i]);
            for (let i = 1; i < n; i++) {                    // insertion sort, best first
                const mv = moves[i], v = sc[i];
                let j = i - 1;
                while (j >= 0 && sc[j] < v) { moves[j + 1] = moves[j]; sc[j + 1] = sc[j]; j--; }
                moves[j + 1] = mv; sc[j + 1] = v;
            }
            return moves;
        }

        function negamax(s, depth, alpha, beta, ply) {
            if ((++nodes & 1023) === 0 && Date.now() > deadlineTs) aborted = true;
            if (aborted) return 0;

            if (s.over) {
                if (s.winner === 3) return 0;
                return s.winner === s.player ? WIN - ply : -(WIN - ply);
            }
            if (depth <= 0) return evaluate(s);

            const moves = orderMoves(s, legalMoves(s));
            let best = -INF;
            for (let i = 0; i < moves.length; i++) {
                makeMove(s, moves[i]);
                const v = -negamax(s, depth - 1, -beta, -alpha, ply + 1);
                undoMove(s);
                if (aborted) return 0;
                if (v > best) best = v;
                if (v > alpha) alpha = v;
                if (alpha >= beta) break;
            }
            return best;
        }

        // Iterative deepening: search 1 move ahead, then 2, then 3 ... until the time runs out.
        function searchBest(s, moves, timeMs, rng, maxDepth) {
            deadlineTs = Date.now() + timeMs;
            nodes = 0;
            aborted = false;

            const ordered = orderMoves(s, shuffle(rng, moves.slice()));   // shuffle first so ties vary
            let best = ordered[0];
            let depthReached = 0;

            for (let depth = 1; depth <= maxDepth; depth++) {
                let iterBest = null, iterScore = -INF, alpha = -INF;
                for (let i = 0; i < ordered.length; i++) {
                    makeMove(s, ordered[i]);
                    const v = -negamax(s, depth - 1, -INF, -alpha, 1);
                    undoMove(s);
                    if (aborted) break;
                    if (v > iterScore) { iterScore = v; iterBest = ordered[i]; }
                    if (v > alpha) alpha = v;
                }
                if (aborted || iterBest === null) break;   // unfinished depth: keep the last complete answer
                best = iterBest;
                depthReached = depth;
                const at = ordered.indexOf(best);          // search the best move first next time
                if (at > 0) { ordered.splice(at, 1); ordered.unshift(best); }
                if (Math.abs(iterScore) >= WIN - 200) break;   // forced win (or loss) already found
            }
            searchBest.lastDepth = depthReached;
            return best;
        }

        /* ---------- difficulty levels ---------- */

        function mediumMove(s, moves, rng) {
            const p = s.player, opp = 3 - p;
            let bestScore = -INF, bestMove = moves[0];
            for (let i = 0; i < moves.length; i++) {
                const idx = moves[i];
                const b = (idx / 9) | 0, c = idx - b * 9;
                const wins = winsCell(s.cells, b, c, p);
                const blocks = winsCell(s.cells, b, c, opp);

                let sc = 0;
                makeMove(s, idx);
                if (s.over && s.winner === p) {
                    sc += 10000;
                } else {
                    if (wins) sc += 50; else if (blocks) sc += 30;
                    if (!s.over) {
                        if (s.next === -1) sc -= 15;                                   // gives the opponent a free turn
                        else if (hasWinningCell(s.cells, s.next, opp)) sc -= 40;       // sends them to a board they can win
                    }
                    if (c === 4) sc += 3; else if (c === 0 || c === 2 || c === 6 || c === 8) sc += 1;
                }
                undoMove(s);

                sc += rng() * 10;                                                      // a little randomness
                if (sc > bestScore) { bestScore = sc; bestMove = idx; }
            }
            return bestMove;
        }

        function hardMove(s, moves, rng) {
            deadlineTs = Date.now() + 2000;
            nodes = 0;
            aborted = false;
            const scored = [];
            for (const idx of shuffle(rng, moves.slice())) {
                makeMove(s, idx);
                const v = -negamax(s, 2, -INF, INF, 1);   // my move + their reply + my reply = 3 moves ahead
                undoMove(s);
                scored.push({ idx, v });
            }
            scored.sort((a, b) => b.v - a.v);
            if (scored.length > 1 && rng() < 0.15) {      // now and then, play 2nd / 3rd best
                return scored[1 + randInt(rng, Math.min(2, scored.length - 1))].idx;
            }
            return scored[0].idx;
        }

        function chooseMove(snapshot, difficulty, opts) {
            opts = opts || {};
            const rng = opts.rng || Math.random;
            const s = fromSnapshot(snapshot);
            const moves = legalMoves(s);
            if (!moves.length) return null;

            let idx;
            switch (difficulty) {
                case "easy":
                    idx = pick(rng, moves);
                    break;
                case "medium":
                    idx = mediumMove(s, moves, rng);
                    break;
                case "hard":
                    idx = hardMove(s, moves, rng);
                    break;
                default:
                    idx = moves.length === 1 ? moves[0] : searchBest(s, moves, opts.timeMs || 1000, rng, 40);
            }
            const b = (idx / 9) | 0;
            return { board: b, cell: idx - b * 9 };
        }

        return {
            chooseMove,
            _engine: { fromSnapshot, legalMoves, makeMove, undoMove, evaluate, searchBest }
        };
    })();

    const api = { DIFFICULTIES, basic: Basic, ultimate: Ultimate };
    root.TTTBot = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
