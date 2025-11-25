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

// Detect file type
function detectType(filename) {
    const f = filename.toLowerCase();

    if (f.endsWith(".json")) return "rpgmv-json";
    if (f.endsWith(".rvdata2")) return "rvdata2";
    if (f.endsWith(".wolf")) return "wolf";
    if (f.endsWith(".ks")) return "kirikiriscript";
    if (f.endsWith(".rpa")) return "renpy-rpa";
    if (f.endsWith(".rpyc")) return "renpy-rpyc";
    if (f.endsWith(".xp3")) return "xp3archive";

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
   UPLOAD
======================================================================== */
app.post("/Upload", upload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { originalname, buffer } = req.file;
    const type = detectType(originalname);
    const id = uuidv4();

    // MV/MZ JSON
    if (type === "rpgmv-json") {
        try {
            const obj = JSON.parse(buffer.toString("utf8"));
            const { lines, mapping } = extractMVTextAndMapping(obj);

            store.set(id, {
                type,
                name: originalname,
                raw: obj,
                lines,
                mapping
            });

            return res.json({ id, type, name: originalname, lines });
        } catch (e) {
            return res.json({ id, error: "Invalid JSON" });
        }
    }

    // Ren'Py RPA / RPYC (làm tiếp ở bước sau)
    if (type === "renpy-rpa" || type === "renpy-rpyc") {
        store.set(id, {
            type,
            name: originalname,
            rawBuffer: buffer
        });

        return res.json({
            id,
            type,
            name: originalname,
            message: "Ren'Py file loaded. Extracting support coming next."
        });
    }

    // unknown
    store.set(id, { type, name: originalname, rawBuffer: buffer });
    return res.json({
        id,
        type,
        name: originalname,
        message: "This file type is not supported yet."
    });
});

/* ========================================================================
   EDIT GET
======================================================================== */
app.get("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.type === "rpgmv-json") {
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
   EDIT SAVE
======================================================================== */
app.post("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.type === "rpgmv-json") {
        const newLines = req.body.lines;

        const updated = insertMVTextBack(item.raw, newLines, item.mapping);
        const jsonText = JSON.stringify(updated, null, 2);
        const buf = Buffer.from(jsonText);

        res.setHeader("Content-Type", "application/json");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }

    return res.status(501).json({ error: "Saving not supported yet" });
});

app.get("/", (req, res) => {
    res.send("Backend is running.");
});

app.listen(10000, () => console.log("Server running on 10000"));
