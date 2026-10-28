/*
 * Dark / light theme switch, shared by every page.
 * - First visit: follows the device setting (prefers-color-scheme).
 * - After the player clicks the toggle: remembers the choice (localStorage).
 * This file is loaded in <head>, so the theme is applied before the page paints (no flash).
 */
(function () {
    const KEY = "ttt-theme";
    const root = document.documentElement;
    const media = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

    function savedTheme() {
        try { return localStorage.getItem(KEY); } catch (e) { return null; }
    }
    function systemTheme() {
        return media && media.matches ? "dark" : "light";
    }

    function applyTheme(theme) {
        const dark = theme === "dark";
        root.setAttribute("data-theme", theme);

        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute("content", dark ? "#16181d" : "#faf7f0");

        const btn = document.getElementById("themeToggle");
        if (btn) {
            btn.textContent = dark ? "\u2600\uFE0F" : "\uD83C\uDF19";   // sun / moon
            const label = dark ? "Switch to light theme" : "Switch to dark theme";
            btn.setAttribute("aria-label", label);
            btn.setAttribute("aria-pressed", String(dark));
            btn.title = label;
        }
    }

    applyTheme(savedTheme() || systemTheme());

    document.addEventListener("DOMContentLoaded", function () {
        applyTheme(root.getAttribute("data-theme"));   // now the button exists, set its icon

        const btn = document.getElementById("themeToggle");
        if (btn) {
            btn.addEventListener("click", function () {
                const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
                try { localStorage.setItem(KEY, next); } catch (e) { /* private mode: just don't remember */ }
                applyTheme(next);
            });
        }
    });

    // If the player never chose, follow the device when it switches (e.g. at sunset).
    if (media && media.addEventListener) {
        media.addEventListener("change", function () {
            if (!savedTheme()) applyTheme(systemTheme());
        });
    }
})();
