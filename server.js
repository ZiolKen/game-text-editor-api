const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "500mb" }));

// In-memory store
const store = new Map();

/* ======================================================
   Detect file type
====================================================== */
function detectType(filename) {
    const f = filename.toLowerCase();

    if (f.endsWith(".json")) return "rpgmv-json";
    if (f.endsWith(".rpy")) return "renpy-script";
    if (f.endsWith(".rvdata2")) return "rvdata2";
    if (f.endsWith(".wolf")) return "wolf";
    if (f.endsWith(".rpa")) return "renpy-rpa";
    if (f.endsWith(".rpyc")) return "renpy-rpyc";
    if (f.endsWith(".xp3")) return "xp3archive";
    if (f.endsWith(".ks")) return "kirikiriscript";

    return "unknown";
}

/* ======================================================
   1) Extract MV CommonEvents.json
====================================================== */
function extractMVTextAndMapping(commonEvents) {
    const lines = [];
    const mapping = [];

    commonEvents.forEach((ev, evIndex) => {
        if (!ev || !Array.isArray(ev.list)) return;

        ev.list.forEach((cmd, cmdIndex) => {
            const code = cmd.code;
            const params = cmd.parameters || [];

            if ((code === 401 || code === 405) && typeof params[0] === "string") {
                lines.push(params[0]);
                mapping.push({ evIndex, cmdIndex, paramIndex: 0 });
            }
            else if (code === 102 && Array.isArray(params[0])) {
                params[0].forEach((choice, ci) => {
                    if (typeof choice === "string") {
                        lines.push(choice);
                        mapping.push({
                            evIndex, cmdIndex,
                            paramIndex: [0, ci]
                        });
                    }
                });
            }
            else if (code === 402 && typeof params[1] === "string") {
                lines.push(params[1]);
                mapping.push({ evIndex, cmdIndex, paramIndex: 1 });
            }
            else if ((code === 118 || code === 119) && typeof params[0] === "string") {
                lines.push(params[0]);
                mapping.push({ evIndex, cmdIndex, paramIndex: 0 });
            }
        });
    });

    return { lines, mapping };
}

function insertMVTextBack(commonEvents, newLines, mapping) {
    mapping.forEach((m, i) => {
        const text = newLines[i];
        const ev = commonEvents[m.evIndex];
        const cmd = ev.list[m.cmdIndex];

        if (Array.isArray(m.paramIndex))
            cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = text;
        else
            cmd.parameters[m.paramIndex] = text;
    });

    return commonEvents;
}

/* ======================================================
   2) Extract MapXXX.json
====================================================== */
function extractMapTextAndMapping(mapJson) {
    const lines = [];
    const mapping = [];

    if (!mapJson.events) return { lines, mapping };

    Object.keys(mapJson.events).forEach(eventId => {
        const ev = mapJson.events[eventId];
        if (!ev || !Array.isArray(ev.pages)) return;

        ev.pages.forEach((page, pageIndex) => {
            if (!page.list) return;

            page.list.forEach((cmd, cmdIndex) => {

                const code = cmd.code;
                const params = cmd.parameters || [];

                if ((code === 401 || code === 405) && typeof params[0] === "string") {
                    lines.push(params[0]);
                    mapping.push({
                        type: "event",
                        eventId, pageIndex,
                        cmdIndex, paramIndex: 0
                    });
                }
                else if (code === 102 && Array.isArray(params[0])) {
                    params[0].forEach((choice, ci) => {
                        if (typeof choice === "string") {
                            lines.push(choice);
                            mapping.push({
                                type: "event",
                                eventId, pageIndex,
                                cmdIndex,
                                paramIndex: [0, ci]
                            });
                        }
                    });
                }
                else if (code === 402 && typeof params[1] === "string") {
                    lines.push(params[1]);
                    mapping.push({
                        type: "event",
                        eventId, pageIndex,
                        cmdIndex, paramIndex: 1
                    });
                }
                else if (code === 355 && typeof params[0] === "string") {
                    const m = params[0].match(/"([^"]+)"/);
                    if (m) {
                        lines.push(m[1]);
                        mapping.push({
                            type: "script",
                            eventId, pageIndex, cmdIndex,
                            extractFull: params[0]
                        });
                    }
                }
                else if ((code === 118 || code === 119) && typeof params[0] === "string") {
                    lines.push(params[0]);
                    mapping.push({
                        type: "event",
                        eventId, pageIndex,
                        cmdIndex, paramIndex: 0
                    });
                }
            });
        });
    });

    return { lines, mapping };
}

function insertMapTextBack(mapJson, newLines, mapping) {
    mapping.forEach((m, i) => {
        const newText = newLines[i];
        const ev = mapJson.events[m.eventId];
        if (!ev) return;

        const page = ev.pages[m.pageIndex];
        if (!page) return;

        const cmd = page.list[m.cmdIndex];
        if (!cmd) return;

        if (m.type === "event") {
            if (Array.isArray(m.paramIndex))
                cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = newText;
            else
                cmd.parameters[m.paramIndex] = newText;
        }
        else if (m.type === "script") {
            cmd.parameters[0] = m.extractFull.replace(/"([^"]+)"/, `"${newText}"`);
        }
    });

    return mapJson;
}

/* ======================================================
   3) Ren'Py extract
====================================================== */

const RGX_ASSET_FILE = /\.(png|jpe?g|gif|webp|mp3|ogg|wav|mp4|webm|m4a|avi|mov|ttf|otf|pfb|pfm|ps|woff2?|eot|svg)["']?$/i;
const RGX_ASSET_PATH = /["'](images?|audio|music|voice|bg|sfx|movie|video|sounds?)\//i;

const RGX_FULL_STRING = /^"((?:\\.|[^"\\])*)"$/;
const RGX_STRING_INSIDE = /"((?:\\.|[^"\\])*)"/;
const RGX_DICT = /{\s*dialog:\s*["']([\s\S]*?)["']\s*,\s*line:\s*(\d+)\s*}/g;
const RGX_ANY_STRING = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;

const DIALOG_BLACKLIST = [
    "screen", "background", "outlines", "outline_scaling", "easeout", "hovered", "unhovered",
    "font", "text", "text_font", "style", "key", "if", "else", "at", "def", "config", "size",
    "add", "action", "show", "play", "image", "sound", "align", "import", "with", "move",
    "menu", "jump", "scene", "init", "hide", "stop", "queue", "transform", "define",
    "window", "voice", "pause", "call", "return", "renpy", "python"
];

function isDialogLine(line) {
    const raw = line;
    const trimmed = raw.trim();
    if (!trimmed) return false;

    // remove comments respecting quotes
    let lineNoComment = "";
    let inS = false, inD = false;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        const prev = i > 0 ? trimmed[i - 1] : null;

        if (c === "'" && !inD && prev !== "\\") inS = !inS;
        else if (c === '"' && !inS && prev !== "\\") inD = !inD;
        else if (c === "#" && !inS && !inD) break;

        lineNoComment += c;
    }

    const t = lineNoComment.trim();
    if (!t) return false;

    if (/^(label|key|style|text_font|font|if|else|at|align|easeout|size|hovered|unhovered|import|config|with|def|move|background|text|add|action|screen|sound|outlines|outline_scaling|menu|jump|scene|init|show|hide|stop|play|queue|transform|define|image|window|voice|pause|call|return|renpy|python)\b/i.test(t))
        return false;

    if (/^[\w\s]*=[^"'`]/.test(t)) return false;

    if (RGX_ASSET_FILE.test(t)) return false;
    if (RGX_ASSET_PATH.test(t)) return false;

    const outsideQuotes = t.replace(RGX_ANY_STRING, "");
    for (const kw of DIALOG_BLACKLIST) {
        if (new RegExp(`\\b${kw}\\b`, "i").test(outsideQuotes)) {
            if (!/^[a-zA-Z_][\w]*\s+["']/.test(t)) return false;
        }
    }

    if (/^[\w\s]+:\s*["'].*["']/.test(t)) return true;
    if (RGX_FULL_STRING.test(t)) return true;
    if (/^[\w_]+\s+"(.+?)"/.test(t)) return true;

    if (RGX_STRING_INSIDE.test(t)) {
        const m = t.match(RGX_STRING_INSIDE);
        if (!m) return false;
        const text = m[1].trim();
        if (!text) return false;
        if (/^[.\s]+$/.test(text)) return false;
        return true;
    }

    if (/{.*?}/.test(t) && /[A-Za-z0-9\u00C0-\u1EF9]/.test(t))
        return true;

    return false;
}

function escapeDialog(str) {
    return str
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, "\\n");
}

/**
 * Extract all dialog strings in .rpy using isDialogLine.
 * mapping: { lineIndex, stringIndex, quoteType }
 */
function extractRenpyTextAdvanced(source) {
    const linesArr = source.split(/\r?\n/);
    const allTexts = [];
    const mapping = [];

    for (let i = 0; i < linesArr.length; i++) {
        const line = linesArr[i];
        if (!isDialogLine(line)) continue;

        let idxInLine = 0;
        RGX_ANY_STRING.lastIndex = 0;
        let m;
        while ((m = RGX_ANY_STRING.exec(line)) !== null) {
            const raw = m[0];
            const quote = raw[0]; // " hoặc '
            const inner = raw.slice(1, -1);

            allTexts.push(inner);
            mapping.push({
                lineIndex: i,
                stringIndex: idxInLine,
                quoteType: quote
            });

            idxInLine++;
        }
    }

    return { lines: allTexts, mapping };
}

function insertRenpyTextBackAdvanced(source, newLines, mapping) {
    const linesArr = source.split(/\r?\n/);

    function replaceNthString(line, nth, newText, quoteType) {
        let count = -1;
        RGX_ANY_STRING.lastIndex = 0;
        return line.replace(RGX_ANY_STRING, (match) => {
            count++;
            if (count === nth) {
                return quoteType + escapeDialog(newText) + quoteType;
            }
            return match;
        });
    }

    mapping.forEach((m, i) => {
        const text = newLines[i] ?? "";
        const idx = m.lineIndex;
        const line = linesArr[idx];
        if (line == null) return;

        linesArr[idx] = replaceNthString(line, m.stringIndex, text, m.quoteType);
    });

    return linesArr.join("\n");
}

/* ======================================================
   UPLOAD — MAP + COMMON + RPY
====================================================== */

app.post("/Upload", upload.array("files"), (req, res) => {
    if (!req.files?.length)
        return res.status(400).json({ error: "No files uploaded" });

    const results = [];

    for (const file of req.files) {
        const id = uuidv4();
        const { originalname, buffer } = file;
        const type = detectType(originalname);

        if (type === "rpgmv-json") {
            try {
                const obj = JSON.parse(buffer.toString("utf8"));

                // CommonEvents.json → array
                if (Array.isArray(obj)) {
                    const { lines, mapping } = extractMVTextAndMapping(obj);
                    store.set(id, {
                        type,
                        name: originalname,
                        mvRaw: obj,
                        mvMapping: mapping,
                        lines
                    });
                    results.push({ id, type, name: originalname, lines });
                }
                // MapXXX.json → object
                else if (obj.events) {
                    const { lines, mapping } = extractMapTextAndMapping(obj);
                    store.set(id, {
                        type,
                        name: originalname,
                        mapRaw: obj,
                        mapMapping: mapping,
                        lines
                    });
                    results.push({ id, type, name: originalname, lines });
                }
                else {
                    results.push({ name: originalname, error: "Unsupported JSON format" });
                }

                continue;
            } catch {
                results.push({ name: originalname, error: "Invalid JSON" });
                continue;
            }
        }

        // RenPy
        if (type === "renpy-script") {
            const src = buffer.toString("utf8");
            const { lines, mapping } = extractRenpyTextAdvanced(src);

            store.set(id, {
                type,
                name: originalname,
                renpySource: src,
                renpyMapping: mapping,
                lines
            });

            results.push({ id, type, name: originalname, lines });
            continue;
        }

        // Unsupported
        store.set(id, { type, name: originalname, rawBuffer: buffer });
        results.push({
            id, type, name: originalname,
            message: "This file type is not supported yet."
        });
    }

    res.json({ files: results });
});

/* ======================================================
   LOAD /Edit/:id
====================================================== */
app.get("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.lines)
        return res.json({
            id: req.params.id,
            type: item.type,
            name: item.name,
            lines: item.lines
        });

    return res.status(501).json({ error: "Not supported yet." });
});

/* ======================================================
   SAVE /Edit/:id
====================================================== */
app.post("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    const newLines = req.body.lines;
    if (!Array.isArray(newLines))
        return res.status(400).json({ error: "Invalid lines payload" });

    // CommonEvents
    if (item.mvRaw && item.mvMapping) {
        const updated = insertMVTextBack(item.mvRaw, newLines, item.mvMapping);
        const buf = Buffer.from(JSON.stringify(updated, null, 2), "utf8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    // Map
    if (item.mapRaw && item.mapMapping) {
        const updated = insertMapTextBack(item.mapRaw, newLines, item.mapMapping);
        const buf = Buffer.from(JSON.stringify(updated, null, 2), "utf8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    // RenPy
    if (item.renpySource) {
        const updated = insertRenpyTextBackAdvanced(
            item.renpySource,
            newLines,
            item.renpyMapping
        );
        const buf = Buffer.from(updated, "utf8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    return res.status(501).json({ error: "Saving not supported" });
});

/* ======================================================
   RUN SERVER
====================================================== */

app.get("/", (req, res) => res.send("Backend is running."));

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server running on", port));
