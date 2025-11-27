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
 
    if (/^(retry|correct|start|skip|skipit|again|player|end|fail|flag|flag[0-9]|options|theend|greet|menu|title|continue|load|save|settings|config|credits|back|next|yes|no|ok|cancel|exit|quit|help|none|picture|pictures)$/i.test(t)) {
        return true;
    }
 
    if (/^(TILESET|POPTEXT|SE|BGM|BGS|ME|ANIM|COMMON|VAR|SWITCH|ACTOR|CLASS|SKILL|ITEM|WEAPON|ARMOR|ENEMY|TROOP|STATE|EVENT|MAP|SYS|BG|PIC|PICTURE)-/i.test(t)) {
        return true;
    }
 
    if (/^<\/?\w+(\s+[^>]*)?>\s*$/i.test(t)) return true;
    if (/^(<br\s*\/?>)+$/i.test(t)) return true;
    if (/^<[^>]+>$/i.test(t)) return true;
 
    if (/^\\[a-z]+(\[.*?\])?$/i.test(t)) return true;
    if (/^\\[ivcnpg]\[\d+\]$/i.test(t)) return true;
    if (/^\\c\[\d+\].+\\c\[0\]$/i.test(t)) return true;
 
    if (/^[\.…,!?;:\-_=+*#@$%^&()[\]{}|\/\\<>~`'"]+$/.test(t)) return true;
 
    if (/^(this\.|self\.|game_|$game|@|undefined|null|true|false|var |let |const )/.test(t)) return true;
 
    if (!/[A-Za-z0-9\u00C0-\u1EF9\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/.test(t)) return true;
 
    if (t.length <= 2 && !/^(ok|no|go|up|hi|me|we|he|it|is|am|an|at|be|by|do|if|in|of|on|or|so|to|us|oh|ah)$/i.test(t)) {
        return true;
    }
 
    if (/^(KeyHint|OldMap\d*|Prayer|prayer|Chest|Offering)$/i.test(t)) return true;
 
    if (!/\s/.test(t) && /^[A-Za-z0-9_]+$/.test(t)) return true;
 
    if (t.replace(/\s/g, '').length <= 1) return true;

    return false;
}

function stripSpeakerPrefix(text) {
    if (typeof text !== "string") {
        return { text, prefix: null, skip: false };
    }

    const trimmed = text.replace(/^\s+/, "");
    const m = trimmed.match(/^([A-Za-z]{2,8}|NPC|Npc|npc)\.(.*)$/);
    if (!m) {
        return { text, prefix: null, skip: false };
    }

    const prefix = m[1] + ".";
    let body = m[2].replace(/^\s+/, "");
 
    if (!body) {
        return { text, prefix, skip: true };
    }
 
    if (/^\/[A-Za-z0-9_]+$/.test(body)) {
        return { text, prefix, skip: true };
    }

    return { text: body, prefix, skip: false };
}

const RGX_RPGM_ASSET = /\.(png|jpe?g|gif|bmp|webp|ogg|mp3|wav|m4a|mp4|webm|m4v)$/i;

function pushRpgmLine(lines, mapping, text, meta, opts = {}) {
    if (typeof text !== "string") return;

    let value = text;
    let speakerPrefix = null;

    if (opts.stripSpeakerPrefix) {
        const res = stripSpeakerPrefix(text);
        if (res.skip) return;   
        value = res.text;
        speakerPrefix = res.prefix;
    }

    if (isGarbageText(value)) return;

    lines.push(value);
    mapping.push({
        ...meta,
        speakerPrefix,   
    });
}

function isRpgmMetaComment(str) {
    if (!str) return true;
    const t = str.trim();
    if (!t) return true;

    if (/^<[^>]+>$/.test(t)) return true;
    if (/^[A-Z0-9_]+$/.test(t)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*:?$/.test(t)) return true;

    return false;
}
 
function normalizeRpgmText(str) {
    return str
        .replace(/\\[A-Za-z]+\[[^\]]*\]/g, "")   
        .replace(/\\[A-Za-z]+/g, "")        
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<\/?\w+(\s+[^>]*)?>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
 
function isDialogueText(str) {
    if (!str) return false;

    const pre = stripSpeakerPrefix(str);
    if (pre.skip) return false;

    let t = pre.text.trim();
    if (!t) return false;

    if (isGarbageText(t)) return false;

    t = normalizeRpgmText(t);
    if (!t) return false;
 
    t = t.replace(/^["“”]+/, "").replace(/["“”]+$/, "").trim();
    if (!t) return false;

    if (isGarbageText(t)) return false;

    const lower = t.toLowerCase();
 
    if (/^(none|picture|pictures|bg|keyhint|oldmap\d*|prayer|chest|offering)$/i.test(t)) {
        return false;
    }
 
    if (/^(a|an|the)\s+/i.test(t) &&
        !/\b(i|me|my|mine|we|us|our|you|your|yours|he|she|they|him|her|them)\b/i.test(t)) {
        return false;
    }
 
    if (
        !/\b(i|me|my|mine|we|us|our|you|your|yours|he|she|they|him|her|them)\b/i.test(t) &&
        /\b(key|plant|potion|artifact|statue|ladder|book|camera|rope|boots?|shovel|talisman|medallion|mask|bullet|gunpowder|essence|page|doll|coin|flower|algae|bikini|whip|powder|liquid|device|oil|container|nuts?)\b/i.test(t) &&
        /\b(can be|used to|used for|used in crafting|that can)\b/i.test(t)
    ) {
        return false;
    }
 
    if (!/\s/.test(t) && /^[A-Za-z0-9_]+$/.test(t)) return false;
 
    if (/^(i|i'm|i’ve|i'd|i’ll|we|we're|we’ve|we’ll|you|you’re|you'll|he|she|they|it|oh|ah|well|hey|hmm|ugh)\b/i.test(t)) {
        return true;
    }
 
    if (/\b(i|me|my|mine|we|us|our|you|your|yours)\b/i.test(t)) {
        return true;
    }
 
    if (/[!?…]/.test(t)) return true;
 
    if (/[.!?]\s+[A-Z]/.test(t)) return true;
 
    if (t.length >= 16 && t.split(/\s+/).length >= 3) return true;

    return false;
}
 
function isChoiceText(str) {
    if (!str) return false;
    let t = str.trim();
    if (!t) return false;

    t = normalizeRpgmText(t);
    if (!t) return false;
 
    if (/^(none|picture|pictures)$/i.test(t)) return false;
    if (/^(bg|bg-)/i.test(t)) return false;
 
    if (!/\s/.test(t) && /^[A-Za-z0-9_\-]+$/.test(t) &&
        !/^(yes|no|ok)$/i.test(t)) {
        return false;
    }
 
    if (/^(cancel|back)$/i.test(t)) return false;
 
    return true;
}

/* ======================================================
   RPGM Script String Extractor
====================================================== */

function extractRpgmScriptStrings(script, cb) {
    if (typeof script !== "string") return;

    const processed = new Set();

    const templateRegex = /`([^`]*(?:\\.[^`]*)*)`/g;
    let m;
    while ((m = templateRegex.exec(script)) !== null) {
        const value = m[1];
        const key = `template:${value}`;
        if (!processed.has(key) && !isGarbageText(value) && !RGX_RPGM_ASSET.test(value)) {
            processed.add(key);
            cb(value, m[1], "template");
        }
    }

    const stringRegex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/g;
    while ((m = stringRegex.exec(script)) !== null) {
        const value = (m[1] != null ? m[1] : m[2]) ?? "";
        const trimmed = value.trim();

        if (!trimmed) continue;
        if (!/\s/.test(trimmed) && RGX_RPGM_ASSET.test(trimmed)) continue;
        if (isGarbageText(value)) continue;

        const key = `string:${value}`;
        if (!processed.has(key)) {
            processed.add(key);
            cb(value, value, "string");
        }
    }

    const pluginMatch = script.match(/^(\w+)\s+(.+)$/);
    if (pluginMatch) {
        const args = pluginMatch[2];

        try {
            const jsonMatch = args.match(/\{[^}]+\}/);
            if (jsonMatch) {
                const obj = JSON.parse(jsonMatch[0]);
                Object.entries(obj).forEach(([key, val]) => {
                    if (typeof val === 'string' && !isGarbageText(val)) {
                        const pkey = `plugin_json:${val}`;
                        if (!processed.has(pkey)) {
                            processed.add(pkey);
                            cb(val, val, "plugin_json");
                        }
                    }
                });
            }
        } catch {}

        const kvRegex = /(\w+)\s*:\s*(["'])([^\2]*?)\2/g;
        let kvm;
        while ((kvm = kvRegex.exec(args)) !== null) {
            const val = kvm[3];
            if (!isGarbageText(val)) {
                const kvkey = `plugin_kv:${val}`;
                if (!processed.has(kvkey)) {
                    processed.add(kvkey);
                    cb(val, val, "plugin_kv");
                }
            }
        }
    }

    const concatRegex = /(["'`])([^\1]*?)\1(\s*\+\s*(["'`])([^\4]*?)\4)+/g;
    while ((m = concatRegex.exec(script)) !== null) {
        const fullMatch = m[0];
        const parts = fullMatch.match(/(["'`])([^\1]*?)\1/g);
        if (parts && parts.length > 1) {
            const combined = parts.map(p => {
                const inner = p.slice(1, -1);
                return inner.replace(/\\(.)/g, '$1');
            }).join('');

            if (!isGarbageText(combined)) {
                const ckey = `concat:${combined}`;
                if (!processed.has(ckey)) {
                    processed.add(ckey);
                    cb(combined, fullMatch, "concat");
                }
            }
        }
    }
}

/* ======================================================
   RPGM JSON Universal
====================================================== */

function extractMVTextAndMapping(commonEvents) {
    const lines = [];
    const mapping = [];

    commonEvents.forEach((ev, evIndex) => {
        if (!ev || !Array.isArray(ev.list)) return;

        ev.list.forEach((cmd, cmdIndex) => {
            if (!cmd) return;
            const code = cmd.code;
            const params = cmd.parameters || [];
            const base = { evIndex, cmdIndex };
 
            if ((code === 401 || code === 405) && typeof params[0] === "string") {
                if (isDialogueText(params[0])) {
                    pushRpgmLine(
                        lines,
                        mapping,
                        params[0],
                        { ...base, paramIndex: 0 },
                        { stripSpeakerPrefix: true }
                    );
                }
            }
 
            if (code === 102 && Array.isArray(params[0])) {
                params[0].forEach((choice, ci) => {
                    if (typeof choice !== "string") return;
                    if (!isChoiceText(choice)) return;

                    pushRpgmLine(
                        lines,
                        mapping,
                        choice,
                        { ...base, paramIndex: [0, ci] },
                        { stripSpeakerPrefix: false }
                    );
                });
            }
        });
    });

    return { lines, mapping };
}

function insertMVTextBack(commonEvents, newLines, mapping) {
    mapping.forEach((m, i) => {
        const text = newLines[i];
        if (typeof text !== "string") return;

        const ev = commonEvents[m.evIndex];
        if (!ev) return;

        const cmd = ev.list[m.cmdIndex];
        if (!cmd) return;

        if (m.extractType) { 
            const oldScript = cmd.parameters[0];
            if (typeof oldScript !== "string") return;

            let newScript = oldScript;

            const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapeQuotes = (str) => str.replace(/"/g, '\\"').replace(/'/g, "\\'");

            if (m.extractType === 'template') {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp('`' + escaped + '`', 'g'),
                    '`' + text + '`'
                );
            } else if (m.extractType === 'concat') {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp(escaped, 'g'),
                    '"' + escapeQuotes(text) + '"'
                );
            } else {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp('(["\'])' + escaped + '\\1', 'g'),
                    (match, quote) => quote + escapeQuotes(text) + quote
                );
            }

            cmd.parameters[0] = newScript;
        } else {
            let finalText = text;
            if (m.speakerPrefix) {
                finalText = m.speakerPrefix + finalText;
            }

            if (Array.isArray(m.paramIndex)) {
                cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = finalText;
            } else {
                cmd.parameters[m.paramIndex] = finalText;
            }
        }
    });

    return commonEvents;
}

/* ======================================================
   RPGM MapXXX JSON
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
                if (!cmd) return;
                const code = cmd.code;
                const params = cmd.parameters || [];
                const base = { eventId, pageIndex, cmdIndex };

                if ((code === 401 || code === 405) && typeof params[0] === "string") {
                    if (isDialogueText(params[0])) {
                        pushRpgmLine(
                            lines,
                            mapping,
                            params[0],
                            { ...base, paramIndex: 0 },
                            { stripSpeakerPrefix: true }
                        );
                    }
                }

                if (code === 102 && Array.isArray(params[0])) {
                    params[0].forEach((choice, ci) => {
                        if (typeof choice !== "string") return;
                        if (!isChoiceText(choice)) return;

                        pushRpgmLine(
                            lines,
                            mapping,
                            choice,
                            { ...base, paramIndex: [0, ci] },
                            { stripSpeakerPrefix: false }
                        );
                    });
                }
            });
        });
    });

    return { lines, mapping };
}

function insertMapTextBack(mapJson, newLines, mapping) {
    mapping.forEach((m, i) => {
        const text = newLines[i];
        if (typeof text !== "string") return;

        const ev = mapJson.events[m.eventId];
        if (!ev) return;

        const page = ev.pages[m.pageIndex];
        if (!page) return;

        const cmd = page.list[m.cmdIndex];
        if (!cmd) return;

        if (m.extractType) {
            const oldScript = cmd.parameters[0];
            if (typeof oldScript !== "string") return;

            let newScript = oldScript;
            const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const escapeQuotes = (str) => str.replace(/"/g, '\\"').replace(/'/g, "\\'");

            if (m.extractType === 'template') {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp('`' + escaped + '`', 'g'),
                    '`' + text + '`'
                );
            }
            else if (m.extractType === 'concat') {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp(escaped, 'g'),
                    '"' + escapeQuotes(text) + '"'
                );
            }
            else {
                const escaped = escapeRegex(m.originalText);
                newScript = newScript.replace(
                    new RegExp('(["\'])' + escaped + '\\1', 'g'),
                    (match, quote) => quote + escapeQuotes(text) + quote
                );
            }

            cmd.parameters[0] = newScript;
        } else {
            let finalText = text;
            if (m.speakerPrefix) {
                finalText = m.speakerPrefix + finalText;
            }

            if (Array.isArray(m.paramIndex)) {
                cmd.parameters[m.paramIndex[0]][m.paramIndex[1]] = finalText;
            } else {
                cmd.parameters[m.paramIndex] = finalText;
            }
        }
    });

    return mapJson;
}

/* ======================================================
   Ren'Py RPY Universal
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
            const quote = raw[0];  
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
   Tyranobuild KS Universal 
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

/* ======================================================
   Kirikiri-KAG KS Universal
====================================================== */

function extractKAGTextAndMapping(source) {
    const lines = source.split(/\r?\n/);
    const out = [];
    const mapping = [];

    let inIscript = false;
    let inMacro = false;
    let macroDialogs = [];

    const isGarbage = (txt) => {
        if (!txt) return true;
        const t = txt.trim();

        return (
            t === "" ||
            /^;+/.test(t) ||
            /^\*[a-zA-Z0-9_\|]+$/.test(t) ||
            /^\[(?!.*text=)[a-zA-Z0-9_]+(\s+[^\]]*)?(\s*\/)?]$/.test(t) ||
            /^[@].+/.test(t) ||
            /^【.*?】$/.test(t) ||
            /^「§」$/.test(t) ||
            /^§$/.test(t) ||
            /^[\[\]{}()]+$/.test(t) ||
            /^[=><+\-*\/!]+$/.test(t) ||
            /^#\d+$/.test(t) ||
            /^[0-9]+$/.test(t) ||
            /^(return|break|continue|if|else|elsif|while|for|function|var|const|let|true|false|null|undefined)$/i.test(t) ||
            /^\s*(var|const|let|if|else|elsif|switch|case|default|for|while|do|function)\s/i.test(t)
        );
    };

    const extractFromTag = (tag, lineIdx, originalLine) => {
        const textMatch = tag.match(/text=(["'])((?:(?!\1).)*)\1/);
        if (textMatch) {
            const text = textMatch[2];
            if (!isGarbage(text)) {
                out.push(text);
                mapping.push({
                    lineIndex: lineIdx,
                    original: originalLine,
                    extractType: 'tag_text',
                    quoteType: textMatch[1],
                    attributeName: 'text'
                });
                return true;
            }
        }

        const nameMatch = tag.match(/name=(["'])((?:(?!\1).)*)\1/);
        if (nameMatch) {
            const text = nameMatch[2];
            if (!isGarbage(text)) {
                out.push(text);
                mapping.push({
                    lineIndex: lineIdx,
                    original: originalLine,
                    extractType: 'tag_name',
                    quoteType: nameMatch[1],
                    attributeName: 'name'
                });
                return true;
            }
        }

        return false;
    };

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const t = raw.trim();
 
        if (/^\[iscript\]/i.test(t)) { 
            inIscript = true; 
            continue; 
        }
        if (/^\[endscript\]/i.test(t)) { 
            inIscript = false; 
            continue; 
        }
        if (inIscript) continue;
 
        if (/^\[macro\s/i.test(t)) { 
            inMacro = true; 
            macroDialogs = [];
            continue; 
        }
        if (/^\[endmacro\]/i.test(t)) { 
            inMacro = false;
            macroDialogs.forEach(item => {
                out.push(item.text);
                mapping.push(item.mapping);
            });
            macroDialogs = [];
            continue; 
        }

        if (isGarbage(t)) continue;

        let extracted = false;
 
        const evalMatch = t.match(/@eval\s+exp=(sf|tf|f)\.(name\w*|hnam\w*)=(["'])((?:(?!\3).)*)\3/);
        if (evalMatch) {
            const text = evalMatch[4];
            if (!isGarbage(text)) {
                const item = {
                    lineIndex: i,
                    original: raw,
                    extractType: 'eval_name',
                    quoteType: evalMatch[3],
                    varPath: `${evalMatch[1]}.${evalMatch[2]}`
                };
                
                if (inMacro) {
                    macroDialogs.push({ text, mapping: item });
                } else {
                    out.push(text);
                    mapping.push(item);
                }
                extracted = true;
            }
        }

        if (extracted) continue;
 
        const embMatch = t.match(/\[emb\s+exp=(["'])(sf|tf|f)\.(name\w*|hnam\w*)\1\]/);
        if (embMatch) {
            const afterEmb = t.replace(/\[emb[^\]]*\]/g, '').trim();
            if (!isGarbage(afterEmb)) {
                const item = {
                    lineIndex: i,
                    original: raw,
                    extractType: 'emb_with_text',
                    quoteType: '"'
                };
                
                if (inMacro) {
                    macroDialogs.push({ text: afterEmb, mapping: item });
                } else {
                    out.push(afterEmb);
                    mapping.push(item);
                }
                extracted = true;
            }
        }

        if (extracted) continue;
 
        const tagWithText = t.match(/^\[([a-zA-Z0-9_]+)(\s+[^\]]+)?\]/);
        if (tagWithText) {
            if (extractFromTag(t, i, raw)) {
                extracted = true;
            }
        }

        if (extracted) continue;
 
        const jpQuotes = [...t.matchAll(/「([^」]+)」/g)];
        if (jpQuotes.length > 0) {
            jpQuotes.forEach((match, idx) => {
                const text = match[1];
                if (!isGarbage(text)) {
                    const item = {
                        lineIndex: i,
                        original: raw,
                        extractType: 'jp_quote',
                        quoteType: '「',
                        quoteIndex: idx
                    };
                    
                    if (inMacro) {
                        macroDialogs.push({ text, mapping: item });
                    } else {
                        out.push(text);
                        mapping.push(item);
                    }
                }
            });
            extracted = true;
        }

        if (extracted) continue;
 
        if (/^\[cname\s/.test(t)) {
            const afterCname = t
                .replace(/^\[cname\s+[^\]]+\]/, '')
                .replace(/\[np\]/gi, '')
                .replace(/\[l\]/gi, '')
                .replace(/\[r\]/gi, '')
                .trim();
            
            if (!isGarbage(afterCname)) {
                const item = {
                    lineIndex: i,
                    original: raw,
                    extractType: 'cname_dialog',
                    quoteType: '"'
                };
                
                if (inMacro) {
                    macroDialogs.push({ text: afterCname, mapping: item });
                } else {
                    out.push(afterCname);
                    mapping.push(item);
                }
                extracted = true;
            }
        }

        if (extracted) continue;
 
        const plainText = t
            .replace(/\[l\]/gi, '')
            .replace(/\[r\]/gi, '')
            .replace(/\[np\]/gi, '')
            .replace(/\[cm\]/gi, '')
            .replace(/\[er\]/gi, '')
            .trim();

        if (plainText && 
            !/^\[/.test(plainText) &&
            !/^[@*;#]/.test(plainText) &&
            /[\u3000-\u9FFF\u3040-\u309F\u30A0-\u30FF]|[A-Za-z]{3,}/.test(plainText)) {
            
            if (!isGarbage(plainText)) {
                const item = {
                    lineIndex: i,
                    original: raw,
                    extractType: 'plain_dialog',
                    quoteType: '"'
                };
                
                if (inMacro) {
                    macroDialogs.push({ text: plainText, mapping: item });
                } else {
                    out.push(plainText);
                    mapping.push(item);
                }
            }
        }
    };

    return { lines: out, mapping };
}

function insertKAGTextBack(source, newLines, mapping) {
    const lines = source.split(/\r?\n/);

    mapping.forEach((m, idx) => {
        const newText = newLines[idx];
        if (typeof newText !== "string") return;

        const line = lines[m.lineIndex];
        if (line == null) return;

        switch (m.extractType) {
            case 'jp_quote': {
                let jpCount = 0;
                lines[m.lineIndex] = line.replace(/「([^」]+)」/g, (match) => {
                    if (jpCount === m.quoteIndex) {
                        jpCount++;
                        return `「${newText}」`;
                    }
                    jpCount++;
                    return match;
                });
                break;
            }
            case 'tag_text':
            case 'tag_name': {
                const attr = m.attributeName;
                const quote = m.quoteType;
                const attrRegex = new RegExp(`${attr}=${quote}[^${quote}]*${quote}`);
                lines[m.lineIndex] = line.replace(
                    attrRegex,
                    `${attr}=${quote}${newText}${quote}`
                );
                break;
            }
            case 'eval_name': {
                const varPath = m.varPath;
                const evalQuote = m.quoteType;
                const evalRegex = new RegExp(
                    `@eval\\s+exp=${varPath.replace('.', '\\.')}=${evalQuote}[^${evalQuote}]*${evalQuote}`
                );
                lines[m.lineIndex] = line.replace(
                    evalRegex,
                    `@eval exp=${varPath}=${evalQuote}${newText}${evalQuote}`
                );
                break;
            }
            case 'emb_with_text':
            case 'cname_dialog':
            case 'plain_dialog': {
                const leadingTags = line.match(/^(\s*(?:\[[^\]]+\]\s*)*)/);
                const prefix = leadingTags ? leadingTags[1] : '';
                const trailingTags = line.match(/(\s*(?:\[[^\]]+\]\s*)*)$/);
                const suffix = trailingTags ? trailingTags[1] : '';
                lines[m.lineIndex] = prefix + newText + suffix;
                break;
            }
        }
    });

    return lines.join('\n');
}

/* ======================================================
   UPLOAD — MAP + COMMON + RPY + TYRANO + KAG
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





