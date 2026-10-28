/*
 * Game mode picker shared by both games: "2 Players" or "vs Computer",
 * plus difficulty and which side you play. The choice is remembered between visits.
 *
 *   GameOptions.get()      -> { vsComputer, online, difficulty, side }
 *   GameOptions.set({ mode: "online" })   change a setting from code
 *   GameOptions.onChange(fn)   fn() runs whenever the player changes a setting
 */
(function () {
    const KEY = "ttt-options";
    const DEFAULTS = { mode: "two", difficulty: "medium", side: "X" };
    const MODES = ["two", "computer", "online"];
    const DIFFS = ["easy", "medium", "hard", "impossible"];
    const SIDES = ["X", "O"];

    const modeSel = document.getElementById("modeSelect");
    const diffSel = document.getElementById("difficultySelect");
    const sideSel = document.getElementById("sideSelect");

    function load() {
        let saved = {};
        try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { /* no storage: use defaults */ }
        return {
            mode: MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode,
            difficulty: DIFFS.includes(saved.difficulty) ? saved.difficulty : DEFAULTS.difficulty,
            side: SIDES.includes(saved.side) ? saved.side : DEFAULTS.side
        };
    }
    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(current)); } catch (e) { /* private mode: just don't remember */ }
    }

    let current = load();
    const listeners = [];

    function showSelections() {
        if (modeSel) modeSel.value = current.mode;
        if (diffSel) { diffSel.value = current.difficulty; diffSel.hidden = current.mode !== "computer"; }
        if (sideSel) { sideSel.value = current.side; sideSel.hidden = current.mode !== "computer"; }
    }

    function onSelectChanged() {
        if (modeSel && MODES.includes(modeSel.value)) current.mode = modeSel.value;
        if (diffSel && DIFFS.includes(diffSel.value)) current.difficulty = diffSel.value;
        if (sideSel && SIDES.includes(sideSel.value)) current.side = sideSel.value;
        save();
        showSelections();
        listeners.forEach(fn => fn());
    }

    [modeSel, diffSel, sideSel].forEach(sel => { if (sel) sel.addEventListener("change", onSelectChanged); });
    showSelections();

    window.GameOptions = {
        get: function () {
            return {
                vsComputer: current.mode === "computer",
                online: current.mode === "online",
                difficulty: current.difficulty,
                side: current.side
            };
        },
        set: function (partial) {
            if (partial.mode && MODES.includes(partial.mode)) current.mode = partial.mode;
            if (partial.difficulty && DIFFS.includes(partial.difficulty)) current.difficulty = partial.difficulty;
            if (partial.side && SIDES.includes(partial.side)) current.side = partial.side;
            save();
            showSelections();
            listeners.forEach(fn => fn());
        },
        onChange: function (fn) { listeners.push(fn); }
    };
})();
