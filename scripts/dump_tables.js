/*
 * Typed table dump — reads every game-data table straight from memory, fully
 * parsed and typed, so we don't have to reverse the on-wire byte order offline.
 *
 * Why this exists: the tables ship as a custom binary blob (see the offline
 * extractor). The dump gives us each table's row STRUCT (field types + nesting
 * + enums) but NOT the serialization order, and that order is bespoke — it does
 * not match field declaration/offset order, and the method bodies that would
 * reveal it are not in an il2cpp dump (only signatures + RVAs) and sit behind
 * Themida packing. So we take the parsed rows from the live process instead.
 *
 * How: the class `EONGMLLJMOC` is the static table DB. Each static field is a
 * table singleton deriving from the generic base `KGCGOOOMCCB<TKey,TValue>`,
 * which exposes:
 *   - `HIHECLFHCPM` : Dictionary<TKey,TValue>  (the parsed rows)
 *   - a keys accessor returning List<TKey>
 *   - a get-by-key accessor returning TValue
 * We enumerate keys, fetch each row, and serialise it recursively (structs,
 * enums, List<T>, arrays, strings) by the row struct's own (obfuscated but
 * stable) field names. Field names stay obfuscated; the VALUES and TYPES are
 * ground truth — enough to bake an offline typed decoder and to map obfuscated
 * names to friendly ones by triangulation.
 *
 * Output: storage/tables_runtime.json — { "<RowClassFull>": { rows, key,
 * count }, ... }. Table names are mapped from row-class -> table name offline
 * (the DB carries the "<Name>" literal per class). Run standalone and it falls
 * back to "." after a short wait; spawn.py posts the storage path.
 *
 * Build + run (local injection on Windows — NO frida-server; see README.md):
 *   python spawn.py dump_tables.js
 *   python spawn.py dump_tables.js "C:\path\to\client"
 */
import "frida-il2cpp-bridge";

// The static table-database class and its generic table base.
const DB_CLASS = "EONGMLLJMOC";
const TABLE_BASE = "KGCGOOOMCCB"; // KGCGOOOMCCB<TKey,TValue>
const INDEX_FIELD = "GJBKMMLHEHP"; // Dictionary<TKey,{offset,length}> — every row's span
const CACHE_FIELD = "HIHECLFHCPM"; // Dictionary<TKey,TValue> — lazy cache of parsed rows
const GET_METHOD = "JKOHBGMGNJC"; // TValue get(TKey) — seeks the span and deserializes
const NAME_FIELD = "KFDPDJHNGHC"; // static literal: the table's real name

// 0 = every row. Set a small number for a quick calibration pass.
const MAX_ROWS_PER_TABLE = 0;
// Guard against pathological cycles in nested value graphs.
const MAX_DEPTH = 12;

// Before dumping, invoke every table getter so lazy tables load from the local
// bundle (see forceLoadAll). With this on you can snapshot straight from the
// title screen — no need to visit each screen in-game.
const FORCE_LOAD = true;

// The snapshot is triggered manually (press Enter). POLL_MS is how often the
// populated-table count is reported while you wait; SAFETY_CAP_MS dumps on its
// own if you never trigger it.
const POLL_MS = 3000;
const SAFETY_CAP_MS = 15 * 60 * 1000; // 15 min

function isTableClass(klass) {
    for (let k = klass; k; k = k.parent) {
        try {
            if (k.name && k.name.indexOf(TABLE_BASE) === 0) return true;
        } catch (_err) {
            return false;
        }
    }
    return false;
}

// Walk a managed Dictionary<K,V>'s `_entries[]` directly and hand each live
// slot to `fn(key, value)`. These dictionaries are load-once with no deletions,
// so every slot in [0,_count) is live — no free-list handling needed.
function forEachEntry(dict, fn) {
    if (!dict || dict.isNull()) return 0;
    const entries = safe(() => dict.field("_entries").value, null);
    const count = safe(() => dict.field("_count").value, 0);
    if (!entries) return 0;
    const limit = MAX_ROWS_PER_TABLE > 0 ? Math.min(count, MAX_ROWS_PER_TABLE) : count;
    for (let i = 0; i < limit; i++) {
        const entry = safe(() => entries.get(i), null);
        if (!entry) continue;
        fn(safe(() => entry.field("key").value, null), safe(() => entry.field("value").value, null));
    }
    return count;
}

// Rows come from the INDEX dictionary (every key -> span). Each row is
// deserialized on demand via GET_METHOD, which seeks the span and returns a
// typed TValue. If the index is empty but the lazy cache already holds rows
// (eagerly-loaded tables), fall back to reading the cache directly.
function readRows(singleton, serializeRow) {
    const index = safe(() => singleton.field(INDEX_FIELD).value, null);
    const rows = [];

    const indexCount = forEachEntry(index, (key) => {
        const value = safe(() => singleton.method(GET_METHOD).invoke(key), null);
        rows.push({ key: serializeRow(key, 0), row: serializeRow(value, 0) });
    });
    if (indexCount > 0) return { count: indexCount, rows };

    const cache = safe(() => singleton.field(CACHE_FIELD).value, null);
    const cacheCount = forEachEntry(cache, (key, value) => {
        rows.push({ key: serializeRow(key, 0), row: serializeRow(value, 0) });
    });
    if (cacheCount > 0 || (cache && !cache.isNull())) return { count: cacheCount, rows };

    return null;
}

function safe(fn, fallback) {
    try {
        return fn();
    } catch (_err) {
        return fallback;
    }
}

function serialize(value, depth) {
    if (value === null || value === undefined) return null;
    const t = typeof value;
    if (t === "number" || t === "boolean" || t === "string") return value;
    if (t === "bigint") return value.toString();

    if (value instanceof Il2Cpp.String) return value.content;

    if (value instanceof Il2Cpp.Array) {
        if (depth >= MAX_DEPTH) return "<max-depth>";
        const out = [];
        const length = safe(() => value.length, 0);
        for (let i = 0; i < length; i++) {
            out.push(serialize(safe(() => value.get(i), null), depth + 1));
        }
        return out;
    }

    // Reference or value object: figure out its class.
    const klass = safe(() => value.class) || safe(() => value.type && value.type.class);
    if (!klass) return String(value);

    // Enum -> keep the numeric value (member names are resolved offline).
    if (safe(() => klass.isEnum)) {
        return safe(() => value.field("value__").value, null);
    }

    // List<T>: read its backing array.
    if (klass.name && klass.name.indexOf("List") === 0) {
        if (depth >= MAX_DEPTH) return "<max-depth>";
        const items = safe(() => value.field("_items").value, null);
        const size = safe(() => value.field("_size").value, 0);
        const out = [];
        for (let i = 0; i < size; i++) {
            out.push(serialize(safe(() => items.get(i), null), depth + 1));
        }
        return out;
    }

    if (depth >= MAX_DEPTH) return "<max-depth>";

    // Plain struct / object: serialise instance fields by name.
    const out = {};
    const fields = safe(() => klass.fields, []);
    for (const field of fields) {
        if (safe(() => field.isStatic) || safe(() => field.isLiteral)) continue;
        out[field.name] = serialize(safe(() => value.field(field.name).value, null), depth + 1);
    }
    return out;
}

function dumpTable(singleton) {
    const klass = singleton.class;
    const read = readRows(singleton, serialize);
    if (!read) return null;

    // The table's real name is a static literal on the table class.
    let name = null;
    for (let k = klass; k && !name; k = k.parent) {
        name = safe(() => {
            const nf = k.field(NAME_FIELD);
            return nf ? nf.value.content : null;
        }, null);
    }

    return {
        name: name,
        rowClass: safe(() => klass.type.name, klass.name),
        count: read.count,
        dumped: read.rows.length,
        rows: read.rows,
    };
}

function tableSingletons(db) {
    const out = [];
    for (const field of db.fields) {
        if (!field.isStatic) continue;
        const fieldClass = safe(() => field.type.class, null);
        if (!fieldClass || !isTableClass(fieldClass)) continue;
        out.push(field);
    }
    return out;
}

// Most tables are lazy: their static singleton stays null until something asks
// for them. The DB exposes a 0-arg static getter per table (e.g. Map_Data's
// getter loads from the tablecrypto bundle and caches it). Invoking every such
// getter force-loads all tables from the local bundle, so we don't have to
// visit each in-game screen. Getters are matched by shape (static, 0 args,
// returns a KGCGOOOMCCB-derived table), not by name.
function forceLoadAll(db) {
    let getters = 0;
    let loaded = 0;
    let failed = 0;
    const errors = [];
    for (const method of db.methods) {
        if (!method.isStatic || method.parameterCount !== 0) continue;
        const retClass = safe(() => method.returnType.class, null);
        if (!retClass || !isTableClass(retClass)) continue;
        getters++;
        try {
            method.invoke();
            loaded++;
        } catch (err) {
            failed++;
            if (errors.length < 5) errors.push(method.name + ": " + err);
        }
    }
    console.log("[*] table getters found: " + getters + " | invoked ok: " + loaded +
        " | failed: " + failed);
    for (const e of errors) console.log("    [err] " + e);

    // Probe a few known lazy targets right after force-load.
    for (const probe of ["Map_Data", "Dungeon", "Tower"]) {
        let hit = null;
        for (const field of tableSingletons(db)) {
            const s = safe(() => field.value, null);
            if (!s || s.isNull()) continue;
            let nm = null;
            for (let k = s.class; k && !nm; k = k.parent) {
                nm = safe(() => { const nf = k.field(NAME_FIELD); return nf ? nf.value.content : null; }, null);
            }
            if (nm === probe) {
                const idx = safe(() => s.field(INDEX_FIELD).value, null);
                const cnt = safe(() => idx && idx.method("get_Count").invoke(), "no-index");
                hit = "loaded, index rows=" + cnt;
                break;
            }
        }
        console.log("    [probe] " + probe + ": " + (hit || "still null after force-load"));
    }
}

// How many table singletons are loaded (their row index is populated) — a
// progress signal while you wait to snapshot.
function populatedCount(db) {
    let populated = 0;
    for (const field of tableSingletons(db)) {
        const singleton = safe(() => field.value, null);
        if (!singleton || singleton.isNull()) continue;
        const index = safe(() => singleton.field(INDEX_FIELD).value, null);
        const count = safe(() => index && index.method("get_Count").invoke(), 0);
        if (count > 0) populated++;
    }
    return populated;
}

function runDump(outDir, db) {
    const result = {};
    let tableCount = 0;
    let rowTotal = 0;

    for (const field of tableSingletons(db)) {
        const singleton = safe(() => field.value, null);
        if (!singleton || singleton.isNull()) continue;

        const table = safe(() => dumpTable(singleton), null);
        if (!table) {
            console.log("[!] skipped (no accessors): " + safe(() => field.type.class.type.name, field.name));
            continue;
        }
        const label = table.name || table.rowClass;
        result[label] = table;
        tableCount++;
        rowTotal += table.dumped;
        console.log("[+] " + label + ": " + table.dumped + "/" + table.count + " rows");
    }

    const handle = new File(outDir + "/tables_runtime.json", "w");
    handle.write(JSON.stringify(result));
    handle.close();
    console.log("[*] DONE. " + tableCount + " tables, " + rowTotal +
        " rows -> " + outDir + "/tables_runtime.json");
    // Let spawn.py exit on its own once the snapshot is written.
    send({ type: "done", tables: tableCount, rows: rowTotal });
}

// The DB fills progressively (title -> lobby -> world), with long lulls between
// load bursts that auto-detection can't tell apart from "done". So the snapshot
// is MANUAL: navigate wherever you need in-game, then press Enter in spawn.py's
// console to trigger it. A background poll just reports how many tables are
// populated so you know when it is worth snapshotting; a long safety cap dumps
// on its own if the trigger is never sent.
let outputDir = ".";
let snapshotted = false;

function snapshot() {
    if (snapshotted) return;
    snapshotted = true;
    Il2Cpp.perform(() => {
        const db = Il2Cpp.domain.assembly("Assembly-CSharp").image.class(DB_CLASS);
        if (FORCE_LOAD) forceLoadAll(db);
        runDump(outputDir, db);
    });
}

function poll(tick) {
    if (snapshotted) return;
    Il2Cpp.perform(() => {
        const db = Il2Cpp.domain.assembly("Assembly-CSharp").image.class(DB_CLASS);
        if (tick === 0) {
            console.log("[*] il2cpp ready. unityVersion=" + Il2Cpp.unityVersion);
            console.log("[*] output dir: " + outputDir);
            console.log("[*] table DB class: " + db.type.name);
            console.log("[*] Press Enter in this console to force-load every table and");
            console.log("[*] snapshot (the title screen is enough; no in-game navigation needed).");
        }
        const populated = populatedCount(db);
        console.log("[*] populated tables: " + populated + "/" + tableSingletons(db).length +
            " (tick " + tick + ") — press Enter to snapshot");
    });
    if (tick * POLL_MS >= SAFETY_CAP_MS) {
        console.log("[*] safety cap reached — snapshotting whatever is loaded");
        snapshot();
        return;
    }
    setTimeout(() => poll(tick + 1), POLL_MS);
}

let started = false;
const start = (dir) => {
    if (started) return;
    started = true;
    outputDir = dir;
    poll(0);
};
// spawn.py posts the storage path (config) and, when you press Enter, {type:"dump"}.
recv("config", (msg) => start((msg && msg.outDir) || "."));
recv("dump", () => snapshot());
setTimeout(() => start("."), 2000);
