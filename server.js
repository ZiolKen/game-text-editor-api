const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "200mb" }));

// RAM storage (dùng tạm cho Fly.io)
const store = new Map(); // id -> { meta, rawBuffer, parsed, type }

// Detect type by extension
function detectType(filename) {
    const f = filename.toLowerCase();

    if (f.endsWith(".json")) return "rpgmv-json";
    if (f.endsWith(".rvdata2")) return "rvdata2";
    if (f.endsWith(".wolf")) return "wolf-data";
    if (f.endsWith(".rpa")) return "renpy-rpa";
    if (f.endsWith(".rpyc")) return "renpy-rpyc";
    if (f.endsWith(".xp3")) return "xp3-archive";
    if (f.endsWith(".ks")) return "kikiriki-script";

    return "unknown";
}

// -----------------------------
// POST /Upload
// -----------------------------
app.post("/Upload", upload.single("file"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { originalname, buffer } = req.file;
    const type = detectType(originalname);

    const id = uuidv4();
    let parsed = null;

    if (type === "rpgmv-json") {
        try {
            parsed = JSON.parse(buffer.toString("utf8"));
        } catch (e) {
            return res.status(400).json({ error: "Invalid JSON" });
        }
    }

    store.set(id, {
        meta: { name: originalname, uploadedAt: Date.now() },
        rawBuffer: buffer,
        parsed,
        type
    });

    res.json({
        id,
        name: originalname,
        type,
        supportsEdit: !!parsed
    });
});

// -----------------------------
// GET /Edit/:id
// -----------------------------
app.get("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    if (item.type === "rpgmv-json") {
        return res.json({
            id: req.params.id,
            name: item.meta.name,
            type: item.type,
            data: item.parsed
        });
    }

    return res.status(501).json({
        id: req.params.id,
        name: item.meta.name,
        type: item.type,
        message: "This file type is not supported yet."
    });
});

// -----------------------------
// POST /Edit/:id  (SAVE)
// -----------------------------
app.post("/Edit/:id", (req, res) => {
    const item = store.get(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });

    // Only JSON file supported for now
    if (item.type === "rpgmv-json") {
        const newData = req.body.data;

        try {
            const jsonText = JSON.stringify(newData, null, 2);
            const buf = Buffer.from(jsonText, "utf8");

            item.parsed = newData;
            item.rawBuffer = buf;

            res.setHeader("Content-Type", "application/json");
            res.setHeader("Content-Disposition", `attachment; filename="${item.meta.name}"`);
            return res.send(buf);
        } catch (e) {
            return res.status(400).json({ error: "JSON encoding failed" });
        }
    }

    return res.status(501).json({ error: "Saving not supported for this type" });
});

// Health check
app.get("/", (req, res) => {
    res.send("Backend is running.");
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
