// Loads one of the game pages in a simulated browser (jsdom), the way a real browser would: every <script src> in order.
const { JSDOM, VirtualConsole } = require("jsdom");
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "..") + path.sep;

/*
 * options:
 *   prefs     saved game options, e.g. { mode: "online" }
 *   saved     saved online room, e.g. { code: "ABC123", game: "ultimate" }
 *   url       page address (to test ?room=CODE links)
 *   firebase  fake Firebase SDK to put on the page (window.firebase)
 *   now       function returning the current time (replaces Date.now on the page)
 *   config    replacement for window.TTT_FIREBASE_CONFIG (set after firebase-config.js ran)
 *   storage   extra localStorage items to start with, e.g. { 'ttt-results-seen': '[]' }
 *   onClose   called when close() is used (to detach the page from the fake server)
 */
function load(page, options) {
    const o = options || {};
    let html = fs.readFileSync(DIR + page, "utf8");
    const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
    html = html.replace(/<script src="[^"]+"><\/script>/g, "");
    const vc = new VirtualConsole();                      // a page "navigating away" is not implemented in jsdom: ignore that, show real errors
    vc.on("jsdomError", e => { if (!/Not implemented: (navigation|HTMLCanvasElement)/.test(String(e.message))) console.error(e); });
    const dom = new JSDOM(html, { runScripts: "dangerously", url: o.url || ("http://localhost/" + page), virtualConsole: vc });
    const w = dom.window;
    if (o.now) w.Date.now = o.now;
    if (o.prefs) w.localStorage.setItem("ttt-options", JSON.stringify(o.prefs));
    if (o.saved) w.localStorage.setItem("ttt-online-room", JSON.stringify(o.saved));
    Object.keys(o.storage || {}).forEach(k => w.localStorage.setItem(k, o.storage[k]));
    if (o.firebase) w.firebase = o.firebase;
    w.confirm = () => true;
    for (const src of srcs) {
        const sc = w.document.createElement("script");
        sc.textContent = fs.readFileSync(DIR + src, "utf8");
        w.document.body.appendChild(sc);
        if (src === "firebase-config.js" && o.config !== undefined) w.TTT_FIREBASE_CONFIG = o.config;
    }
    const d = w.document;
    return {
        w, d,
        $: id => d.getElementById(id),
        click: id => d.getElementById(id).dispatchEvent(new w.Event("click")),
        type: (id, text) => { const el = d.getElementById(id); el.value = text; el.dispatchEvent(new w.Event("input")); },
        choose: (id, value) => { const el = d.getElementById(id); el.value = value; el.dispatchEvent(new w.Event("change")); },
        text: id => d.getElementById(id).textContent,
        visible: id => !d.getElementById(id).hidden,
        status: () => d.getElementById("statusBar").textContent,
        close: () => { if (o.onClose) o.onClose(); w.close(); }
    };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const settle = async () => { for (let i = 0; i < 12; i++) await sleep(0); };
module.exports = { load, sleep, settle };
