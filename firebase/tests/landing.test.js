/*
 * Tests of the home page Easter egg: three clicks on the word "Toe" within 2 seconds.
 *   cd firebase && npm run test:landing
 */
const { load, settle } = require("./page-harness");

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; failures.push(name + (extra !== undefined ? "  -> " + extra : "")); } };
const MESSAGE = "Congratulations! You found an Easter egg. Now try finding another one... maybe there isn't one.";

(async () => {
    let clock = 1000000;
    const p = load("index.html", { now: () => clock });
    await settle();
    const click = el => el.dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    const egg = () => p.d.querySelector(".eggOverlay");
    const toe = p.$("toeWord"), h1 = p.d.querySelector("h1");

    ok("the egg is hidden until triggered", egg() === null);
    ok("'Toe' has no visible hint: not a link, button, focusable, or titled", !toe.getAttribute("role") && !toe.hasAttribute("tabindex") && !toe.hasAttribute("title") && !toe.hasAttribute("href") && toe.tagName === "SPAN");
    ok("only the word Toe is wrapped, the rest of the title is not", toe.textContent === "Toe" && h1.textContent.replace(/\s+/g, " ").trim() === "Tic Tac Toe");

    // clicks on the other parts of the title do nothing
    for (let i = 0; i < 6; i++) { click(h1); clock += 100; }
    ok("clicking the rest of the title (6 times) does nothing", egg() === null);

    // 3 clicks in time: on the letters of "Toe" (T, o, e all count: clicks bubble up from the letters)
    const letters = toe.querySelectorAll("span");
    click(letters[0]); clock += 300; click(letters[1]); clock += 300;
    ok("2 clicks are not enough", egg() === null);
    click(toe);
    ok("3 clicks on 'Toe' within 2 s open the egg", egg() !== null);
    ok("it shows the exact message", egg().querySelector("#eggText").textContent === MESSAGE, egg() && egg().querySelector("#eggText").textContent);
    ok("it is an accessible dialog with a dismiss button", egg().getAttribute("role") === "dialog" && egg().getAttribute("aria-modal") === "true" && !!egg().querySelector(".eggClose"));
    ok("the egg is a floating overlay on the body (no layout shift in the page)", egg().parentNode === p.d.body);
    ok("focus moves to the dismiss button", p.d.activeElement === egg().querySelector(".eggClose"));

    // a 4th click while it is open doesn't stack another
    click(toe); click(toe); click(toe);
    ok("clicking again while open doesn't open a second one", p.d.querySelectorAll(".eggOverlay").length === 1);

    // dismiss: button
    egg().querySelector(".eggClose").dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    ok("the button dismisses it", egg() === null);

    // too slow: 3 clicks spread over more than 2 s
    clock += 5000;
    click(toe); clock += 1000; click(toe); clock += 1100; click(toe);
    ok("3 clicks that take longer than 2 s do not count", egg() === null);
    // ...but the last three within 2 s do
    clock += 500; click(toe);
    ok("a later burst of 3 within 2 s works (sliding window)", egg() !== null);

    // dismiss: Escape
    p.d.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    ok("Escape dismisses it", egg() === null);

    // dismiss: tap on the backdrop (but not on the card)
    clock += 5000; click(toe); click(toe); click(toe);
    egg().querySelector(".eggCard").dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    ok("tapping inside the card does not dismiss", egg() !== null);
    egg().dispatchEvent(new p.w.MouseEvent("click", { bubbles: true }));
    ok("tapping the backdrop dismisses it", egg() === null);

    // clicks on other parts of the page between "Toe" clicks neither count nor break the sequence
    clock += 5000;
    click(toe); click(h1); click(p.d.body); click(toe); click(h1); click(toe);
    ok("clicks elsewhere are ignored (they don't count, and they don't spoil a sequence)", egg() !== null);
    p.d.dispatchEvent(new p.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    // the rest of the landing page still works
    ok("the page navigation is untouched", p.d.querySelectorAll('a.btn[href$=".html"]').length >= 4 && p.d.querySelectorAll(".card").length === 2);

    // reduced motion: no cracking timer needed, still works
    const r = load("index.html", { now: () => clock });
    r.w.matchMedia = q => ({ matches: /reduce/.test(q) });
    await settle();
    const rt = r.$("toeWord");
    for (let i = 0; i < 3; i++) rt.dispatchEvent(new r.w.MouseEvent("click", { bubbles: true }));
    ok("works with reduced motion on", r.d.querySelector(".eggOverlay") !== null && r.d.querySelector(".eggEmoji").textContent === "\uD83E\uDD5A");

    console.log(`${pass} checks passed, ${fail} failed`);
    if (fail) { console.log("\nFAILURES:\n - " + failures.join("\n - ")); process.exit(1); }
    process.exit(0);
})().catch(e => { console.error("TEST CRASHED:", e); process.exit(1); });
