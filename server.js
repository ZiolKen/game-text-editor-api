const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "500mb" }));

// RAM storage
const store = new Map();

// =====================
// Detect file type
// =====================
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

/* ========================================================================
   MV/MZ — Extract & Reinsert text
======================================================================== */

function extractMVTextAndMapping(commonEvents) {
    const lines = [];
    const mapping = [];

    commonEvents.forEach((ev, evIndex) => {
        if (!ev || !Array.isArray(ev.list)) return;

        ev.list.forEach((cmd, cmdIndex) => {
            const code = cmd.code;
            const params = cmd.parameters || [];

            // 401 / 405 = message / scroll text
            if ((code === 401 || code === 405) && typeof params[0] === "string") {
                lines.push(params[0]);
                mapping.push({ evIndex, cmdIndex, paramIndex: 0 });
            }

            // Choices 102
            else if (code === 102 && Array.isArray(params[0])) {
                params[0].forEach((choice, choiceIndex) => {
                    if (typeof choice === "string") {
                        lines.push(choice);
                        mapping.push({ evIndex, cmdIndex, paramIndex: [0, choiceIndex] });
                    }
                });
            }

            // 402 — When choice
            else if (code === 402 && typeof params[1] === "string") {
                lines.push(params[1]);
                mapping.push({ evIndex, cmdIndex, paramIndex: 1 });
            }

            // Labels 118/119
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

        if (Array.isArray(m.paramIndex)) {
            cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = text;
        } else {
            cmd.parameters[m.paramIndex] = text;
        }
    });

    return commonEvents;
}

/* ========================================================================
   Ren'Py .rpy — Extract & Reinsert "dialogue"
======================================================================== */

function extractRenpyTextAndMapping(source) {
    const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
    const lines = [];
    const mapping = [];
    let match;

    while ((match = regex.exec(source)) !== null) {
        lines.push(match[1]); 
        mapping.push({ start: match.index, end: regex.lastIndex });
    }

    return { lines, mapping };
}

function insertRenpyTextBack(source, newLines, mapping) {
    let result = "";
    let lastIndex = 0;

    for (let i = 0; i < mapping.length && i < newLines.length; i++) {
        const m = mapping[i];
        const text = newLines[i] ?? "";

        result += source.slice(lastIndex, m.start);

        const escaped = text
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');

        result += `"${escaped}"`;
        lastIndex = m.end;
    }

    result += source.slice(lastIndex);
    return result;
}

/* ========================================================================
   POST /Upload
======================================================================== */
app.post("/Upload", upload.array("files"), (req, res) => {
    if (!req.files || req.files.length === 0)
        return res.status(400).json({ error: "No files uploaded" });

    const results = [];

    for (const file of req.files) {
        const { originalname, buffer } = file;
        const type = detectType(originalname);
        const id = uuidv4();

        // Ren’Py script (.rpy)
        if (type === "renpy-script") {
            const source = buffer.toString("utf8");
            const { lines, mapping } = extractRenpyTextAdvanced(source);

            store.set(id, {
                type,
                name: originalname,
                renpySource: source,
                renpyMapping: mapping,
                lines
            });

            results.push({ id, type, name: originalname, lines });
            continue;
        }

        // MV/MZ JSON
        if (type === "rpgmv-json") {
            try {
                const obj = JSON.parse(buffer.toString("utf8"));
                const { lines, mapping } = extractMVTextAndMapping(obj);

                store.set(id, {
                    type,
                    name: originalname,
                    mvRaw: obj,
                    mvMapping: mapping,
                    lines
                });

                results.push({ id, type, name: originalname, lines });
                continue;
            } catch {
                results.push({ error: "Invalid JSON", name: originalname });
                continue;
            }
        }

        // unsupported
        store.set(id, { type, name: originalname, rawBuffer: buffer });
        results.push({ id, type, name: originalname, message: "Not supported yet." });
    }

    res.json({ files: results });
});

/* ========================================================================
   GET /Edit/:id
======================================================================== */
app.get("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.type === "rpgmv-json" || item.type === "renpy-script") {
        return res.json({
            id: req.params.id,
            type: item.type,
            name: item.name,
            lines: item.lines
        });
    }

    return res.status(501).json({ error: "Not supported yet." });
});

/* ========================================================================
   POST /Edit/:id (SAVE)
======================================================================== */
app.post("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    const newLines = req.body.lines;
    if (!Array.isArray(newLines)) {
        return res.status(400).json({ error: "Invalid lines payload" });
    }

    // MV/MZ
    if (item.type === "rpgmv-json") {
        const updated = insertMVTextBack(item.mvRaw, newLines, item.mvMapping);
        const jsonText = JSON.stringify(updated, null, 2);
        const buf = Buffer.from(jsonText, "utf8");

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    // Ren'Py .rpy
    if (item.type === "renpy-script") {
        const updated = insertRenpyTextBack(
            item.renpySource,
            newLines,
            item.renpyMapping
        );
        const buf = Buffer.from(updated, "utf8");

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    return res.status(501).json({ error: "Saving not supported yet" });
});

app.get("/", (req, res) => {
    res.send("Backend is running.");
});

const port = process.env.PORT || 10000;
app.listen(port, () => console.log("Server running on", port));

const RGX_ASSET_FILE = /\.(png|jpe?g|gif|webp|mp3|ogg|wav|mp4|webm|m4a|avi|mov|ttf|otf|pfb|pfm|ps|woff2?|eot|svg)["']?$/i;
const RGX_ASSET_PATH = /["'](images?|audio|music|voice|bg|sfx|movie|video|sounds?)\//i;

const RGX_FULL_STRING = /^"((?:\\.|[^"\\])*)"$/;
const RGX_STRING_INSIDE = /"((?:\\.|[^"\\])*)"/;
const RGX_DICT = /{\s*dialog:\s*["']([\s\S]*?)["']\s*,\s*line:\s*(\d+)\s*}/g;
const RGX_ANY_STRING = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;

const DIALOG_BLACKLIST = [
    "screen", "background", "outlines", "outline_scaling", "easeout", "hovered",
    "unhovered", "font", "text", "text_font", "size", "key", "if", "else", "at",
    "def", "config", "add", "action", "align", "image", "show", "play", "sound",
    "move", "import", "with", "jump", "menu", "scene", "init", "hide", "queue",
    "transform", "define", "pause", "return", "python"
];

function isDialogLine(line) {
    const raw = line;
    const trimmed = raw.trim();
    if (!trimmed) return false;

    // remove trailing comments
    let final = "";
    let inS = false, inD = false;
    for (let i = 0; i < trimmed.length; i++) {
        const c = trimmed[i];
        const prev = trimmed[i - 1];

        if (c === "'" && !inD && prev !== "\\") inS = !inS;
        else if (c === '"' && !inS && prev !== "\\") inD = !inD;
        else if (c === "#" && !inS && !inD) break;

        final += c;
    }

    final = final.trim();
    if (!final) return false;

    if (/^(label|style|if|else|jump|menu|scene|init|define|transform|image|show|hide|play|stop|pause|return|python)\b/i.test(final))
        return false;

    if (/^[\w\s]*=[^"'`]/.test(final)) return false;

    if (RGX_ASSET_FILE.test(final)) return false;
    if (RGX_ASSET_PATH.test(final)) return false;

    const outside = final.replace(RGX_ANY_STRING, "");
    for (const kw of DIALOG_BLACKLIST) {
        if (new RegExp(`\\b${kw}\\b`, "i").test(outside)) {
            if (!/^[a-zA-Z_][\w]*\s+["']/.test(final)) return false;
        }
    }

    if (/^[\w\s]+:\s*["'].*["']/.test(final)) return true;
    if (RGX_FULL_STRING.test(final)) return true;
    if (/^[\w_]+\s+"(.+?)"/.test(final)) return true;

    if (RGX_STRING_INSIDE.test(final)) {
        const m = final.match(RGX_STRING_INSIDE);
        if (!m) return false;

        const text = m[1].trim();
        if (!text) return false;
        if (/^[.\s]+$/.test(text)) return false;

        return true;
    }

    if (/{.*?}/.test(final) && /[A-Za-z0-9\u00C0-\u1EF9]/.test(final))
        return true;

    return false;
}

function escapeDialog(str) {
    return str
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, "\\n");
}

function extractRenpyTextAdvanced(source) {
    const lines = [];
    const mapping = [];

    const srcLines = source.split("\n");

    for (let i = 0; i < srcLines.length; i++) {
        const line = srcLines[i];

        if (!isDialogLine(line)) continue;

        let m;
        while ((m = RGX_ANY_STRING.exec(line)) !== null) {
            const rawFull = m[0];
            const textInside = rawFull.slice(1, -1);
            const start = source.indexOf(rawFull);

            lines.push(textInside);

            mapping.push({
                index: i,
                raw: rawFull,
                text: textInside
            });
        }
    }

    return { lines, mapping };
}

function insertRenpyTextBackAdvanced(source, newLines, mapping) {
    let out = source;

    for (let i = mapping.length - 1; i >= 0; i--) {
        const m = mapping[i];
        const replacement = `"${escapeDialog(newLines[i] || "")}"`;

        out = out.replace(m.raw, replacement);
    }

    return out;
}
