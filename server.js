/* ======================================================
      CONFIG
====================================================== */

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

function detectType(filename, buffer = "") {
    const f = filename.toLowerCase();

    if (f.endsWith(".json")) return "rpgmv-json";
    if (f.endsWith(".rpy")) return "renpy-script";

    if (f.endsWith(".ks")) {
        const text = buffer.toString();

        if (/@[a-zA-Z0-9_]+/.test(text)) return "kag-ks";

        if (/「[^」]+」/.test(text)) return "kag-ks";

        if (/\[[a-zA-Z0-9_]+[^\]]*\]/.test(text)) return "tyrano-ks";

        if (/\[iscript\]/i.test(text)) return "tyrano-ks";

        if (/\[(cm|eval|jump|tb_)/i.test(text)) return "tyrano-ks";

        return "tyrano-ks";
    }

    return "unknown";
}

/* ======================================================
   FILTER RPGM
====================================================== */

function isGarbageText(str) {
    if (!str) return true;

    const t = str.trim();
    if (!t) return true;
  
    if (/^\d+$/.test(t)) return true;
  
    if (/^(retry|correct|start|skip|skipit|again|player|end|fail|flag|flag[0-9]|options|theend|greet|menu|title|continue|load|save|settings|config|credits|back|next|yes|no|ok|cancel|exit|quit|help)$/i.test(t)) return true;
  
    if (/^(TILESET|POPTEXT|SE|BGM|BGS|ME|ANIM|COMMON|VAR|SWITCH|ACTOR|CLASS|SKILL|ITEM|WEAPON|ARMOR|ENEMY|TROOP|STATE|EVENT|MAP|SYS)-/i.test(t)) return true;
  
    if (/^<\/?\w+(\s+[^>]*)?>\s*$/i.test(t)) return true;
    if (/^(<br\s*\/?>)+$/i.test(t)) return true;
    if (/^<[^>]+>$/i.test(t)) return true;
  
    if (/^\\[a-z]+(\[.*?\])?$/i.test(t)) return true;  
    if (/^\\[ivcnpg]\[\d+\]$/i.test(t)) return true;
    if (/^\\c\[\d+\].+\\c\[0\]$/i.test(t)) return true;  
  
    if (/^[\.…,!?;:\-_=+*#@$%^&()[\]{}|\/\\<>~`'"]+$/.test(t)) return true;
 
    if (/^(this\.|self\.|game_|$game|@|undefined|null|true|false|var |let |const )/.test(t)) return true;
     
    if (!/[A-Za-z0-9\u00C0-\u1EF9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(t)) return true;
 
    if (t.length <= 2 && !/^(ok|no|go|up|hi|me|we|he|it|is|am|an|at|be|by|do|if|in|of|on|or|so|to|us|oh|ah)$/i.test(t)) return true;
 
    if (t.replace(/\s/g, '').length <= 1) return true;

    return false;
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
                if (!isGarbageText(params[0])) {
                    lines.push(params[0]);
                    mapping.push({ evIndex, cmdIndex, paramIndex: 0 });
                }
            }
 
            else if (code === 102 && Array.isArray(params[0])) {
                params[0].forEach((choice, ci) => {
                    if (typeof choice === "string" && !isGarbageText(choice)) {
                        lines.push(choice);
                        mapping.push({
                            evIndex, cmdIndex,
                            paramIndex: [0, ci]
                        });
                    }
                });
            }
 
            else if (code === 402 && typeof params[1] === "string") {
                if (!isGarbageText(params[1])) {
                    lines.push(params[1]);
                    mapping.push({
                        evIndex, cmdIndex,
                        paramIndex: 1
                    });
                }
            }
 
            else if ((code === 118 || code === 119) && typeof params[0] === "string") {
                if (!isGarbageText(params[0])) {
                    lines.push(params[0]);
                    mapping.push({
                        evIndex, cmdIndex,
                        paramIndex: 0
                    });
                }
            }
 
            else if (code === 320 && typeof params[1] === "string") {
                if (!isGarbageText(params[1])) {
                    lines.push(params[1]);
                    mapping.push({
                        evIndex, cmdIndex,
                        paramIndex: 1
                    });
                }
            }
 
            else if (code === 324 && typeof params[1] === "string") {
                if (!isGarbageText(params[1])) {
                    lines.push(params[1]);
                    mapping.push({
                        evIndex, cmdIndex,
                        paramIndex: 1
                    });
                }
            }
 
            else if ((code === 355 || code === 655) && typeof params[0] === "string") {
                const matches = params[0].match(/"([^"]+)"/g);
                if (matches) {
                    matches.forEach(match => {
                        const text = match.slice(1, -1);
                        if (!isGarbageText(text)) {
                            lines.push(text);
                            mapping.push({
                                evIndex, cmdIndex,
                                paramIndex: 0,
                                type: "script",
                                extractFull: params[0],
                                originalText: text
                            });
                        }
                    });
                }
            }
 
            else if ((code === 356 || code === 656) && typeof params[0] === "string") {
                const matches = params[0].match(/"([^"]+)"/g);
                if (matches) {
                    matches.forEach(match => {
                        const text = match.slice(1, -1);
                        if (!isGarbageText(text)) {
                            lines.push(text);
                            mapping.push({
                                evIndex, cmdIndex,
                                paramIndex: 0,
                                type: "script",
                                extractFull: params[0],
                                originalText: text
                            });
                        }
                    });
                }
            }
        });
    });

    return { lines, mapping };
}

function insertMVTextBack(commonEvents, newLines, mapping) {
    mapping.forEach((m, i) => {
        const text = newLines[i];
        const ev = commonEvents[m.evIndex];
        if (!ev) return;

        const cmd = ev.list[m.cmdIndex];
        if (!cmd) return;
 
        if (m.type === "script") {
            cmd.parameters[m.paramIndex] = cmd.parameters[m.paramIndex].replace(
                new RegExp('"' + m.originalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'),
                '"' + text + '"'
            );
        } 
        else {
            if (Array.isArray(m.paramIndex))
                cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = text;
            else
                cmd.parameters[m.paramIndex] = text;
        }
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
                    if (!isGarbageText(params[0])) {
                        lines.push(params[0]);
                        mapping.push({ type:"event", eventId, pageIndex, cmdIndex, paramIndex:0 });
                    }
                } 
                else if (code === 102 && Array.isArray(params[0])) {
                    params[0].forEach((choice, ci) => {
                        if (typeof choice === "string" && !isGarbageText(choice)) {
                            lines.push(choice);
                            mapping.push({
                                type: "event",
                                eventId, pageIndex,
                                cmdIndex,
                                paramIndex:[0, ci]
                            });
                        }
                    });
                } 
                else if (code === 402 && typeof params[1] === "string") {
                    if (!isGarbageText(params[1])) {
                        lines.push(params[1]);
                        mapping.push({
                            type:"event",
                            eventId, pageIndex,
                            cmdIndex, paramIndex:1
                        });
                    }
                } 
                else if ((code === 355 || code === 655) && typeof params[0] === "string") { 
                    const matches = params[0].match(/"([^"]+)"/g);
                    if (matches) {
                        matches.forEach(match => {
                            const text = match.slice(1, -1);  
                            if (!isGarbageText(text)) {
                                lines.push(text);
                                mapping.push({
                                    type: "script",
                                    eventId, pageIndex, cmdIndex,
                                    extractFull: params[0],
                                    originalText: text
                                });
                            }
                        });
                    }
                } 
                else if ((code === 118 || code === 119) && typeof params[0] === "string") {
                    if (!isGarbageText(params[0])) {
                        lines.push(params[0]);
                        mapping.push({
                            type:"event",
                            eventId, pageIndex,
                            cmdIndex, paramIndex:0
                        });
                    }
                } 
                else if (code === 320 && typeof params[1] === "string") {
                    if (!isGarbageText(params[1])) {
                        lines.push(params[1]);
                        mapping.push({
                            type:"event",
                            eventId, pageIndex,
                            cmdIndex, paramIndex:1
                        });
                    }
                } 
                else if (code === 324 && typeof params[1] === "string") {
                    if (!isGarbageText(params[1])) {
                        lines.push(params[1]);
                        mapping.push({
                            type:"event",
                            eventId, pageIndex,
                            cmdIndex, paramIndex:1
                        });
                    }
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
            cmd.parameters[0] = cmd.parameters[0].replace(
                new RegExp('"' + m.originalText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'),
                '"' + newText + '"'
            );
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

/* ========================================================================
   4) TyranoScript .ks — extract & reinsert dialog
======================================================================== */

function extractTyranoTextAndMapping(source) {
    const linesArr = source.split(/\r?\n/);
    const out = [];
    const mapping = [];

    for (let i = 0; i < linesArr.length; i++) {
        const raw = linesArr[i];
        const line = raw.trim();

        if (!line) continue;
        if (line.startsWith("*")) continue;     
        if (line.startsWith(";")) continue;        
        if (line.startsWith("@")) continue;        
        if (/^\[[^\]]+\]$/.test(line)) continue;     
        if (/^if\s*\(.+\)/.test(line)) continue;  
        if (/^\w+\(.+\)$/.test(line)) continue;      
        if (/^[A-Za-z_]\w*\s*=/.test(line)) continue; 
        if (/^\{.*\}$/.test(line)) continue;    
        if (line.startsWith("[eval") || line.startsWith("eval")) continue;

        if (/^#[A-Za-z0-9_]+/.test(line)) continue; 

        if (/function\s*\(/.test(line)) continue;
        if (/[{}();=]/.test(line)) continue;
        if (/^\w+\.\w+\(/.test(line)) continue;

        const mHead = raw.match(/^(\s*(\[[^\]]*\]\s*)*)/);
        const prefix = mHead ? mHead[0] : "";
        const rest = raw.slice(prefix.length);

        const mTail = rest.match(/(\s*(\[[^\]]*\]\s*)*)$/);
        const suffix = mTail ? mTail[0] : "";

        const center = rest.slice(0, rest.length - suffix.length).trim();

        if (!/[A-Za-z\u00C0-\u1EF9]/.test(center)) continue;

        out.push(center);
        mapping.push({ lineIndex: i, prefix, center, suffix });
    }

    return { lines: out, mapping };
}

function insertTyranoTextBack(source, newLines, mapping) {
    const linesArr = source.split(/\r?\n/);

    mapping.forEach((m, i) => {
        const newText = newLines[i] ?? "";
        linesArr[m.lineIndex] = m.prefix + newText + m.suffix;
    });

    return linesArr.join("\n");
}

/* ========================================================================
   5) Kirikiri KAG .ks
======================================================================== */

function extractKAGTextAndMapping(source) {
    const lines = source.split(/\r?\n/);
    const out = [];
    const mapping = [];

    let inIscript = false;
    let inMacro = false;

    const isGarbage = (txt) => {
        if (!txt) return true;
        const t = txt.trim();

        return (
            t === "" ||
            /^;+/.test(t) ||
            /^\*.+/.test(t) ||
            /^\[.+\]$/.test(t) ||
            /^[@].+/.test(t) ||
            /^【.*?】$/.test(t) ||
            /^「§」$/.test(t) ||
            /^§$/.test(t) ||
            /^[\[\]{}()]+$/.test(t) ||
            /^[=><+\-*\/]+$/.test(t) ||
            /^#/.test(t) ||
            /^[0-9]+$/.test(t) ||
            /^(return|break|continue|if|else|while|for|function|var|const|let)$/i.test(t)
        );
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
 
        if (t.startsWith("[iscript]")) { inIscript = true; continue; }
        if (t.startsWith("[endscript]")) { inIscript = false; continue; }
        if (inIscript) continue;
 
        if (t.startsWith("[macro")) { inMacro = true; continue; }
        if (t.startsWith("[endmacro]")) { inMacro = false; continue; }
        if (inMacro) continue;

        if (isGarbage(t)) continue;

        let textValue = "";
        let quoteType = '"';
        let stringIndex = 0;
 
        const evalMatch = t.match(/@eval\s+exp=sf\.(?:name\d?|hnam\d?)="(.*?)"/);
        if (evalMatch) {
            textValue = evalMatch[1];
            out.push(textValue);
            mapping.push({
                lineIndex: i,
                original: raw,
                quoteType: '"',
                stringIndex: 0
            });
            continue;
        }
 
        const textAttrMatch = t.match(/text=(["'])(.*?)\1/);
        if (textAttrMatch) {
            textValue = textAttrMatch[2];
            quoteType = textAttrMatch[1];
            out.push(textValue);
            mapping.push({
                lineIndex: i,
                original: raw,
                quoteType: quoteType,
                stringIndex: 0
            });
            continue;
        }
 
        const quoteJPMatch = t.match(/「(.*?)」/g);
        if (quoteJPMatch) {
            quoteJPMatch.forEach((match, idx) => {
                const inner = match.slice(1, -1);
                if (!isGarbage(inner)) {
                    out.push(inner);
                    mapping.push({
                        lineIndex: i,
                        original: raw,
                        quoteType: '「',
                        stringIndex: idx
                    });
                }
            });
            continue;
        }
 
        if (/emb\s+exp="sf\.hnam/.test(t) || /。$/.test(t)) {
            textValue = raw.replace(/^;　?/, "").trim();
            if (!isGarbage(textValue)) {
                out.push(textValue);
                mapping.push({
                    lineIndex: i,
                    original: raw,
                    quoteType: '"',
                    stringIndex: 0
                });
            }
            continue;
        }
 
        if (/^\[cname\s+chara=.*?\]/.test(t)) {
            textValue = t
                .replace(/^\[cname\s+chara=.*?\]/, "")
                .replace(/\[np\]/gi, "")
                .trim();
            if (!isGarbage(textValue)) {
                out.push(textValue);
                mapping.push({
                    lineIndex: i,
                    original: raw,
                    quoteType: '"',
                    stringIndex: 0
                });
            }
            continue;
        }
 
        if (/[A-Za-z0-9\u3000-\u9FFF\u3040-\u309F\u30A0-\u30FF]/.test(t)) {
            if (!/^[\\\w\[\]<>\/=]+$/.test(t) && !isGarbage(t)) {
                out.push(raw.trim());
                mapping.push({
                    lineIndex: i,
                    original: raw,
                    quoteType: '"',
                    stringIndex: 0
                });
            }
        }
    }

    return { lines: out, mapping };
}

function insertKAGTextBack(source, newLines, mapping) {
    const lines = source.split(/\r?\n/);

    mapping.forEach((m, idx) => {
        const newText = newLines[idx];
        const line = lines[m.lineIndex];
        
        if (m.quoteType === '「') { 
            let count = 0;
            lines[m.lineIndex] = line.replace(/「(.*?)」/g, (match) => {
                if (count === m.stringIndex) {
                    count++;
                    return `「${newText}」`;
                }
                count++;
                return match;
            });
        } else if (m.quoteType === '"' || m.quoteType === "'") { 
            if (line.includes('text=')) {
                lines[m.lineIndex] = line.replace(
                    /text=(["'])(.*?)\1/,
                    `text=${m.quoteType}${newText}${m.quoteType}`
                );
            } else if (line.includes('@eval')) {
                lines[m.lineIndex] = line.replace(
                    /@eval\s+exp=sf\.(?:name\d?|hnam\d?)="(.*?)"/,
                    `@eval exp=sf.${line.match(/sf\.(name\d?|hnam\d?)/)[1]}="${newText}"`
                );
            } else { 
                lines[m.lineIndex] = newText;
            }
        }
    });

    return lines.join("\n");
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
        const type = detectType(originalname, buffer);

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

        // Tyrano
        if (type === "tyrano-ks") {
            const src = buffer.toString("utf8");
            const { lines, mapping } = extractTyranoTextAndMapping(src);
      
            store.set(id, {
                type,
                name: originalname,
                tyranoSource: src,
                tyranoMapping: mapping,
                lines
            });
      
            results.push({ id, type, name: originalname, lines });
            continue;
        }

        // Kirikiri KAG
        if (type === "kag-ks") {
            const src = buffer.toString("utf8");
            const { lines, mapping } = extractKAGTextAndMapping(src);

            store.set(id, {
                type,
                name: originalname,
                kagSource: src,
                kagMapping: mapping,
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

    // Tyrano
    if (item.tyranoSource) {
        const updated = insertTyranoTextBack(
            item.tyranoSource,
            newLines,
            item.tyranoMapping
        );
        const buf = Buffer.from(updated, "utf8");
        res.setHeader("Content-Disposition", `attachment; filename="${item.name}"`);
        return res.send(buf);
    }
   
    // KAG
    if (item.kagSource) {
        const updated = insertKAGTextBack(
            item.kagSource,
            newLines,
            item.kagMapping
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



