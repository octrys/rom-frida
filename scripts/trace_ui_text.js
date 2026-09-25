/*
 * UI text trace — records what the UI displays and which table rows it read,
 * so table columns can be named offline by value correlation.
 *
 * Why: table field names are obfuscated (random per build), but the UI is not
 * — GameObject names in the UI prefabs are plaintext (`Txt_CoolTime`), and so
 * are Localization keys (`Item_Weight`). When the item tooltip shows "1.166"
 * next to a label, and the row it just read holds 1.166 in field FOOBARBAZQX,
 * that field is the cooltime. Correlation happens offline; this agent only logs.
 *
 * One JSON object per line in storage/ui_trace_<UTC stamp>.jsonl:
 *   {"t":0,"e":"meta","tables":{...hook counts},"hooks":{"<entry point>":"attached|missing|..."}}
 *   {"t":ms,"f":frame,"e":"get","tb":"<Table>","k":<key>}   a table row was read by key
 *   {"t":ms,"f":frame,"e":"txt","p":"<GameObject path>","v":"<text>","c":"<caller RVA>"}
 *   {"t":ms,"f":frame,"e":"state","cls":"CMapManager","fld":"m_sMapData","tb":"Map_Data",
 *    "row":{<row scalars>},"v":{"m_vMapSize":{"m_X":300,"m_Y":300},"m_nMapID":20,...}}
 *       a live component holding a table row, with its plaintext fields (see
 *       "game state"); logged when it changes, checked every STATE_MS
 *   {"t":ms,"e":"stats","calls":{"<entry point>":{"calls":n,"logged":n}},"reads":{"<Table>":n}}   at stop
 * `f` is Time.frameCount: a window fills its labels in one frame, so offline a
 * record is (frame, parent path). In the path, a node whose name a sibling
 * shares carries its sibling index (`Slot(Clone)#3`, `WorldMapPointBase#12`),
 * so list cells and map icons are separate records.
 * Hooks:
 *   - KGCGOOOMCCB<TKey,TValue>.JKOHBGMGNJC(key) — the table row getter. Only
 *     lazy tables go through it (LocalName, Localization — whose keys are the
 *     UI caption keys). `this` maps the call to its table, so shared generic
 *     code is hooked once.
 *   - The row cache (KGCGOOOMCCB.HIHECLFHCPM, Dictionary<TKey,Row>, created on
 *     the table's first use — its class comes from the field type) lookups:
 *     FindEntry / TryGetValue / get_Item / ContainsKey. Eagerly loaded tables
 *     (Map_Data, Warp_Data, ...) never call the getter; the game reads their
 *     cache directly. Only struct rows (123 of 125 tables): Dictionary<K,struct>
 *     is its own instantiation, while a class row would share the code of
 *     every Dictionary<K,object> in the game. These reads include game logic
 *     (combat, quests), not only what the UI shows — offline, the rows read
 *     just before a record are candidates, and precision sorts them out.
 *   - The text entry points: TMP_Text.set_text, SetText(string[, bool]),
 *     SetText/SetCharArray(char[][, start, len]), SetText(StringBuilder[,
 *     start, len]) and UI.Text.set_text. Only the outermost call is logged
 *     (one overload may call another). In practice the game formats in C# and
 *     calls set_text / SetText(string, bool); the others are a safety net and
 *     show 0 calls in `stats`. TMP's SetText(format, float...) is not hooked:
 *     never called, and its floats (XMM registers) would need Interceptor.replace.
 * Repeats are dropped: a component re-set to the same text within REPEAT_MS
 * of its previous set (sliding, so a label refreshed every frame logs once),
 * unless a sibling label changed since — then a new item is being shown and
 * the unchanged value belongs to it too. A table row read again within
 * GET_REPEAT_MS is dropped as well.
 *
 * Run (local injection on Windows — see README.md):
 *   python spawn.py trace_ui_text.js
 *   1st Enter (title screen or later): force-load tables + install the hooks
 *   ... open the windows whose tables you want named (tooltips, skills, ...)
 *   2nd Enter: flush and exit
 */
import "frida-il2cpp-bridge";

const DB_CLASS = "EONGMLLJMOC";
const TABLE_BASE = "KGCGOOOMCCB"; // KGCGOOOMCCB<TKey,TValue>
const NAME_FIELD = "KFDPDJHNGHC"; // static literal: the table's real name
const GET_METHOD = "JKOHBGMGNJC"; // TValue get(TKey)
const CACHE_FIELD = "HIHECLFHCPM"; // Dictionary<TKey,TValue>: the loaded rows
// Row cache lookups by key (Mono BCL: TryGetValue/get_Item/ContainsKey -> FindEntry).
const REFRESH_MS = 50; // a lookup on an unknown dictionary re-reads the row caches at most this often
const CACHE_LOOKUPS = [["FindEntry", 1], ["TryGetValue", 2], ["get_Item", 1], ["ContainsKey", 1]];

const PATH_DEPTH = 6; // transform names kept, leaf upwards
const GET_REPEAT_MS = 1000; // drop re-reads of the same row within this window
const REPEAT_MS = 1500; // drop a label re-set to the same text within this window (sliding)
const FLUSH_MS = 2000;
const MAX_TEXT = 300; // longer texts are truncated
const MAX_CACHE = 50000; // per-component caches are reset past this size
const ARRAY_DATA = 0x20; // Il2CppArray: klass, monitor, bounds, max_length, then the elements
const ARRAY_LENGTH = 0x18;
const CLOCK_RE = /^[\d\s:]+$/; // a ticking clock is not "a new item shown"

let outputDir = ".";
let outputPath = null;
let out = null;
let buffer = [];
let t0 = 0;
let installed = false;
// Time.frameCount, read only on the thread the UI setters run on (Unity's
// main thread): tables can be read from loader threads, whose events reuse
// the last value.
let frame = -1;
let getFrameCount = null; // NativeFunction, set up in install()
let mainThread = null; // set by the first UI setter call
const lastRead = new Map(); // "table:key" -> t of its last get event
let readStats = () => ({});
let refreshCaches = () => {};
const counts = { get: 0, txt: 0 };
const hooks = {}; // entry point -> "attached" | "missing" | "same body as ..."
const calls = {}; // entry point -> {calls, logged}

function safe(fn, fallback) {
    try {
        return fn();
    } catch (_err) {
        return fallback;
    }
}

function now() {
    return Date.now() - t0;
}

function currentFrame() {
    if (getFrameCount && Process.getCurrentThreadId() === mainThread) frame = getFrameCount(NULL);
    return frame;
}

function emit(event) {
    buffer.push(JSON.stringify(event));
}

function flush() {
    if (!out || buffer.length === 0) return;
    out.write(buffer.join("\n") + "\n");
    out.flush();
    buffer = [];
}

function readString(ptr) {
    return ptr.isNull() ? null : new Il2Cpp.String(ptr).content;
}

// char[] -> string; `length` < 0 reads to the end. Buffers are often padded with NULs.
function readChars(array, start, length) {
    if (array.isNull()) return null;
    const total = array.add(ARRAY_LENGTH).readU32();
    const n = length < 0 ? total - start : Math.min(length, total - start);
    if (start < 0 || n <= 0) return null;
    const text = array.add(ARRAY_DATA + 2 * start).readUtf16String(n);
    const end = text.indexOf("\0");
    return end < 0 ? text : text.slice(0, end);
}

// ---------------------------------------------------------------- tables

function isTableClass(klass) {
    for (let k = klass; k; k = k.parent) {
        if (safe(() => k.name.indexOf(TABLE_BASE) === 0, false)) return true;
    }
    return false;
}

// The getter is declared on the generic base, not on the table class itself.
function findMethod(klass, name, parameterCount) {
    for (let k = klass; k; k = k.parent) {
        const method = safe(() => k.tryMethod(name, parameterCount), null);
        if (method) return method;
    }
    return null;
}

function tableName(singleton) {
    for (let k = singleton.class; k; k = k.parent) {
        const name = safe(() => k.field(NAME_FIELD).value.content, null);
        if (name) return name;
    }
    return null;
}

// Lazy tables stay null until first use; the DB's 0-arg static getters load
// them from the local bundle. Load all so every singleton can be mapped.
function forceLoadAll(db) {
    for (const method of db.methods) {
        if (!method.isStatic || method.parameterCount !== 0) continue;
        const ret = safe(() => method.returnType.class, null);
        if (ret && isTableClass(ret)) safe(() => method.invoke(), null);
    }
}

function readKey(keyType, arg) {
    if (keyType === "System.Int32") return arg.toInt32();
    if (keyType === "System.String") return safe(() => readString(arg), null);
    if (keyType === "System.Int64") return arg.toString();
    return undefined;
}

// The table's row cache field (Dictionary<TKey,TValue>), declared on the
// generic base. The dictionary itself is created on the table's first use,
// so its class comes from the field's (inflated) type, not from an instance.
function rowCacheField(singleton) {
    for (let k = singleton.class; k; k = k.parent) {
        const field = safe(() => k.tryField(CACHE_FIELD), null);
        if (field) return field;
    }
    return null;
}

// A row read by key: through the table getter (lazy tables) or straight from
// the row cache (eager tables). The same row again within GET_REPEAT_MS is
// dropped — that also folds nested lookups (TryGetValue -> FindEntry).
function emitGet(table, key) {
    const t = now();
    const id = table.name + ":" + key;
    if (t - (lastRead.get(id) ?? -GET_REPEAT_MS) < GET_REPEAT_MS) return;
    if (lastRead.size > MAX_CACHE) lastRead.clear();
    lastRead.set(id, t);
    counts.get++;
    table.logged++;
    emit({ t, f: currentFrame(), e: "get", tb: table.name, k: key });
}

function hookTables(db) {
    const tables = new Map(); // singleton handle -> {name, keyType, logged}
    const cacheStatus = {}; // table -> how its row cache is hooked, or why not
    const owners = []; // {singleton, offset, table}: where each row cache lives
    const caches = new Map(); // row cache handle -> table
    const lookups = new Map(); // cache lookup address -> {method, tables}
    const hooked = new Set(); // getter addresses already attached
    for (const field of db.fields) {
        if (!field.isStatic) continue;
        const fieldClass = safe(() => field.type.class, null);
        if (!fieldClass || !isTableClass(fieldClass)) continue;
        const singleton = safe(() => field.value, null);
        if (!singleton || singleton.isNull()) continue;
        const getter = findMethod(singleton.class, GET_METHOD, 1);
        if (!getter) continue;
        const table = { name: tableName(singleton) || singleton.class.name, keyType: getter.parameters[0].type.name, logged: 0 };
        tables.set(singleton.handle.toString(), table);
        const rowClass = safe(() => getter.returnType.class, null);
        if (rowClass && rowClass.isValueType) rowTables.set(rowClass.handle.toString(), table.name);

        // Eager tables never call the getter: their rows are looked up in the
        // cache directly. A struct row type makes Dictionary<TKey,Row> its own
        // instantiation, with its own code; a class row type would share
        // Dictionary<TKey,__Canon> with the whole game, so it is left out.
        // Per table, why it has cache hooks or not (written to `meta`): a
        // lookup method without code was never compiled for this row type —
        // the game doesn't look that table up by key.
        const rowIsStruct = safe(() => getter.returnType.class.isValueType, false);
        const cacheField = rowIsStruct ? rowCacheField(singleton) : null;
        const cacheClass = cacheField ? safe(() => cacheField.type.class, null) : null;
        if (!rowIsStruct) cacheStatus[table.name] = "class rows";
        else if (!cacheClass) cacheStatus[table.name] = "no row cache field";
        else {
            owners.push({ singleton: singleton.handle, offset: cacheField.offset, table });
            const found = [], noCode = [];
            for (const [name, argc] of CACHE_LOOKUPS) {
                const method = safe(() => cacheClass.tryMethod(name, argc), null);
                if (!method) continue;
                if (method.virtualAddress.isNull()) {
                    noCode.push(name);
                    continue;
                }
                found.push(name);
                const address = method.virtualAddress.toString();
                if (!lookups.has(address)) lookups.set(address, { method: name, tables: [] });
                lookups.get(address).tables.push(table);
            }
            cacheStatus[table.name] = found.length ? "hooked " + found.join(",")
                : noCode.length ? "no code: " + noCode.join(",") : "no lookup methods";
        }

        const address = getter.virtualAddress;
        if (address.isNull() || hooked.has(address.toString())) continue;
        hooked.add(address.toString());
        Interceptor.attach(address, {
            onEnter(args) {
                const table = tables.get(args[0].toString());
                if (!table) return;
                const key = readKey(table.keyType, args[1]);
                if (key !== undefined) emitGet(table, key);
            },
        });
    }

    // `this` is the dictionary, and the only way to tell the table: the
    // linker folds identical code, so one body serves every Dictionary<int,
    // struct> whose entries have the same size — other tables' and the game's
    // own dictionaries alike (a body "owned" by one table saw 230k foreign
    // lookups). Row caches appear as tables get used: re-read them on every
    // flush, and at once (rate-limited) when an unknown dictionary shows up.
    refreshCaches = () => {
        for (const { singleton, offset, table } of owners) {
            const handle = safe(() => singleton.add(offset).readPointer(), NULL);
            if (!handle.isNull()) caches.set(handle.toString(), table);
        }
    };
    refreshCaches();
    let lastRefresh = 0;
    let shared = 0;
    for (const [address, entry] of lookups) {
        if (entry.tables.length > 1) shared++;
        Interceptor.attach(ptr(address), {
            onEnter(args) {
                const self = args[0].toString();
                let table = caches.get(self);
                if (!table && Date.now() - lastRefresh > REFRESH_MS) {
                    // maybe a cache created since the last refresh — the
                    // first reads of a table are the ones its window makes
                    lastRefresh = Date.now();
                    refreshCaches();
                    table = caches.get(self);
                }
                if (!table) return;
                const key = readKey(table.keyType, args[1]);
                if (key !== undefined) emitGet(table, key);
            },
        });
    }
    const cached = new Set([...lookups.values()].flatMap((e) => e.tables.map((t) => t.name)));
    console.log("[*] tables mapped: " + tables.size + ", getter hooks: " + hooked.size +
        ", row-cache hooks: " + lookups.size + " (" + cached.size + " tables, " + shared + " shared bodies)");
    readStats = () => Object.fromEntries([...tables.values()].filter((t) => t.logged).map((t) => [t.name, t.logged]));
    return { tables: tables.size, cacheTables: cached.size, cacheHooks: lookups.size, sharedBodies: shared,
        cache: cacheStatus };
}

// ---------------------------------------------------------------- game state

// Components that keep a table row in a field (CMapManager.m_sMapData, the
// world map window, monster/NPC actors...) usually keep plaintext-named
// fields next to it: m_vMapSize, m_fRealScale, the text components they fill
// (m_txtTitle). Every STATE_MS, on the main thread, the live ones are found
// and each one's row (its scalar fields, to find the key offline) and
// plaintext values are logged when they changed. Offline, a value equal to a
// column of that exact row names the column after the game's own field.
const STATE_MS = 2000;
const MAX_STATE_EVENTS = 200; // per tick
const OBFUSCATED = /^[A-P]{11}$/;
const UNITY_BASES = new Set(["MonoBehaviour", "Behaviour", "Component", "Object"]);
const NUMBER_READERS = {
    "System.Int32": (p) => p.readS32(),
    "System.UInt32": (p) => p.readU32(),
    "System.Int16": (p) => p.readS16(),
    "System.UInt16": (p) => p.readU16(),
    "System.Byte": (p) => p.readU8(),
    "System.SByte": (p) => p.readS8(),
    "System.Int64": (p) => Number(p.readS64()),
    "System.Single": (p) => +p.readFloat().toFixed(6),
    "System.Double": (p) => +p.readDouble().toFixed(6),
};
const rowTables = new Map(); // row struct class handle -> table name (set by hookTables)
const stateCounts = {}; // holder class -> state events
let stateTick = () => {};
let stateInfo = {};

function setupState(core) {
    const assembly = Il2Cpp.domain.assembly("Assembly-CSharp").image;
    const tmp = Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Text");
    const uiText = Il2Cpp.domain.assembly("UnityEngine.UI").image.class("UnityEngine.UI.Text");
    const textOf = (klass, getter) => new NativeFunction(klass.method(getter, 0).virtualAddress, "pointer", ["pointer", "pointer"]);
    const tmpText = textOf(tmp, "get_text");
    const uiTextText = textOf(uiText, "get_text");
    const findObjects = core.class("UnityEngine.Object").methods.find((m) => m.name === "FindObjectsOfType" &&
        m.parameterCount === 2 && m.parameters[0].type.name === "System.Type");
    const find = new NativeFunction(findObjects.virtualAddress, "pointer", ["pointer", "bool", "pointer"]);
    const monoType = core.class("UnityEngine.MonoBehaviour").type.object.handle;

    // A reader turns a field's memory into a value, or undefined (not logged).
    function readerFor(type, depth) {
        const name = type.name;
        if (NUMBER_READERS[name]) return NUMBER_READERS[name];
        if (name === "System.String") return (p) => readString(p.readPointer()) || undefined;
        if (name.endsWith("[]")) return (p) => {
            const a = p.readPointer();
            return a.isNull() ? undefined : a.add(ARRAY_LENGTH).readU32();
        };
        const klass = safe(() => type.class, null);
        if (!klass) return null;
        if (klass.isEnum) {
            const base = safe(() => klass.baseType.name, "System.Int32");
            return NUMBER_READERS[base] || null;
        }
        if (name.startsWith("System.Collections.Generic.List<")) return (p) => {
            const list = p.readPointer();
            return list.isNull() ? undefined : safe(() => new Il2Cpp.Object(list).field("_size").value, undefined);
        };
        if (safe(() => klass.isSubclassOf(tmp, false) || klass.handle.equals(tmp.handle), false)) {
            return (p) => {
                const c = p.readPointer();
                return c.isNull() ? undefined : safe(() => readString(tmpText(c, NULL)), undefined) || undefined;
            };
        }
        if (safe(() => klass.isSubclassOf(uiText, false) || klass.handle.equals(uiText.handle), false)) {
            return (p) => {
                const c = p.readPointer();
                return c.isNull() ? undefined : safe(() => readString(uiTextText(c, NULL)), undefined) || undefined;
            };
        }
        // Small all-number structs (Vector2Int, Vector3Int...): one value per
        // member. Float vectors are positions — they change every frame.
        if (klass.isValueType && depth < 1 && /Int$/.test(klass.name)) {
            const parts = klass.fields.filter((f) => !f.isStatic)
                .map((f) => ({ name: f.name, offset: f.offset - 0x10, read: NUMBER_READERS[f.type.name] }));
            if (parts.length && parts.length <= 4 && parts.every((x) => x.read)) {
                return (p) => Object.fromEntries(parts.map((x) => [x.name, x.read(p.add(x.offset))]));
            }
        }
        return null;
    }

    // Per holder class: the row fields and the plaintext values, own and inherited.
    const infos = new Map(); // class handle -> info | null
    function infoOf(handle) {
        const key = handle.toString();
        if (infos.has(key)) return infos.get(key);
        const klass = new Il2Cpp.Class(handle);
        let holds = false;
        for (let k = klass; k && !holds; k = k.parent) holds = declared.has(k.handle.toString());
        if (!holds) {
            infos.set(key, null);
            return null;
        }
        const rows = [], values = [];
        for (let k = klass; k && !UNITY_BASES.has(k.name); k = k.parent) {
            for (const field of safe(() => k.fields, [])) {
                if (field.isStatic || field.name.startsWith("<")) continue;
                const table = safe(() => rowTables.get(field.type.class.handle.toString()), undefined);
                if (table) {
                    const rowClass = field.type.class;
                    const scalars = rowClass.fields.filter((f) => !f.isStatic)
                        .map((f) => ({ name: f.name, offset: f.offset - 0x10, read: safe(() => readerFor(f.type, 1), null) }))
                        .filter((f) => f.read);
                    rows.push({ name: field.name, offset: field.offset, table, scalars });
                } else if (!OBFUSCATED.test(field.name)) {
                    const read = safe(() => readerFor(field.type, 0), null);
                    if (read) values.push({ name: field.name, offset: field.offset, read });
                }
            }
        }
        const info = rows.length ? { name: klass.name, rows, values } : null;
        infos.set(key, info);
        return info;
    }

    // Holders reachable without a scene search: static fields of their own type.
    const singletons = [];
    const declared = new Set(); // classes declaring a row field
    for (const klass of assembly.classes) {
        const own = safe(() => klass.fields, []);
        if (!own.some((f) => !f.isStatic && safe(() => rowTables.has(f.type.class.handle.toString()), false))) continue;
        declared.add(klass.handle.toString());
        for (const f of own) {
            if (f.isStatic && safe(() => f.type.class.handle.equals(klass.handle), false)) singletons.push(f);
        }
    }

    const last = new Map(); // instance:row field -> signature of its last event
    function snapshot(obj, info, t, budget) {
        let emitted = 0;
        for (const row of info.rows) {
            if (emitted >= budget) break;
            const base = obj.add(row.offset);
            const rowValues = {};
            for (const s of row.scalars) {
                const v = safe(() => s.read(base.add(s.offset)), undefined);
                if (v !== undefined && typeof v !== "object") rowValues[s.name] = v;
            }
            if (!Object.values(rowValues).some((v) => v)) continue; // an unset row
            const values = {};
            for (const v of info.values) {
                const value = safe(() => v.read(obj.add(v.offset)), undefined);
                if (value !== undefined && value !== null) values[v.name] = value;
            }
            const signature = JSON.stringify([rowValues, values]);
            const id = obj.toString() + ":" + row.name;
            if (last.get(id) === signature) continue;
            if (last.size > MAX_CACHE) last.clear();
            last.set(id, signature);
            emit({ t, f: frame, e: "state", cls: info.name, fld: row.name, tb: row.table, row: rowValues, v: values });
            stateCounts[info.name] = (stateCounts[info.name] || 0) + 1;
            emitted++;
        }
        return emitted;
    }

    let lastTick = 0;
    stateTick = () => {
        const t = now();
        if (t - lastTick < STATE_MS) return;
        lastTick = t;
        let budget = MAX_STATE_EVENTS;
        const array = find(monoType, 0, NULL);
        if (!array.isNull()) {
            const n = array.add(ARRAY_LENGTH).readU32();
            for (let i = 0; i < n && budget > 0; i++) {
                const obj = array.add(ARRAY_DATA + i * Process.pointerSize).readPointer();
                if (obj.isNull()) continue;
                const info = safe(() => infoOf(obj.readPointer()), null);
                if (info) budget -= snapshot(obj, info, t, budget);
            }
        }
        for (const field of singletons) {
            const obj = safe(() => field.value.handle, NULL);
            const info = obj.isNull() ? null : safe(() => infoOf(obj.readPointer()), null);
            if (info && budget > 0) budget -= snapshot(obj, info, t, budget);
        }
    };
    stateInfo = { holders: declared.size, singletons: singletons.length };
    console.log("[*] game state: " + declared.size + " classes hold a table row, " + singletons.length + " singleton fields");
}

// ---------------------------------------------------------------- UI text

function hookText(gameAssembly) {
    const core = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image;
    // Called straight through their native entry points: (this, ..., MethodInfo*).
    const native = (klass, name, ret, params, count) =>
        new NativeFunction(klass.method(name, count ?? params.length).virtualAddress, ret, [...params, "pointer"]);
    const getTransform = native(core.class("UnityEngine.Component"), "get_transform", "pointer", ["pointer"], 0);
    const getParent = native(core.class("UnityEngine.Transform"), "get_parent", "pointer", ["pointer"], 0);
    const getSiblingIndex = native(core.class("UnityEngine.Transform"), "GetSiblingIndex", "int", ["pointer"], 0);
    const getChildCount = native(core.class("UnityEngine.Transform"), "get_childCount", "int", ["pointer"], 0);
    const getChild = native(core.class("UnityEngine.Transform"), "GetChild", "pointer", ["pointer", "int"], 1);
    const getName = native(core.class("UnityEngine.Object"), "get_name", "pointer", ["pointer"], 0);
    const builder = Il2Cpp.corlib.class("System.Text.StringBuilder");
    const builderString = new NativeFunction(builder.method("ToString", 0).virtualAddress, "pointer",
        ["pointer", "pointer"]);
    const builderRange = new NativeFunction(builder.method("ToString", 2).virtualAddress, "pointer",
        ["pointer", "int", "int", "pointer"]);

    const paths = new Map(); // component handle -> transform path
    const twins = new Map(); // transform handle -> shares its name with a sibling
    const lastText = new Map(); // component handle -> {text, seen, gen}
    const generations = new Map(); // parent path -> labels changed under it so far
    const depth = new Map(); // thread id -> {frame, n}: nesting of hooked setters

    // Only a name shared with a sibling is ambiguous (list cells, map icons);
    // other nodes keep a bare name, so a popup reordered with SetAsLastSibling
    // keeps its path.
    function hasTwin(t, parent, name) {
        const key = t.toString();
        let twin = twins.get(key);
        if (twin !== undefined) return twin;
        twin = false;
        if (!parent.isNull()) {
            const n = getChildCount(parent, NULL);
            for (let i = 0, same = 0; i < n && !twin; i++) {
                if (safe(() => readString(getName(getChild(parent, i, NULL), NULL)), null) === name) twin = ++same > 1;
            }
        }
        if (twins.size > MAX_CACHE) twins.clear();
        twins.set(key, twin);
        return twin;
    }

    function pathOf(component) {
        const cached = paths.get(component);
        if (cached !== undefined) return cached;
        const names = [];
        let t = getTransform(ptr(component), NULL);
        for (let i = 0; i < PATH_DEPTH && !t.isNull(); i++) {
            const parent = getParent(t, NULL);
            let name = safe(() => readString(getName(t, NULL)), "?");
            if (name && hasTwin(t, parent, name)) name += "#" + getSiblingIndex(t, NULL);
            names.unshift(name);
            t = parent;
        }
        const path = names.join("/");
        if (paths.size > MAX_CACHE) paths.clear();
        paths.set(component, path);
        return path;
    }

    // Outermost hooked setter only. Scoped to the frame, so a setter that
    // unwinds by exception (onLeave never runs) can't mute its thread for good.
    function enter() {
        const tid = Process.getCurrentThreadId();
        mainThread = tid;
        frame = getFrameCount(NULL);
        const d = depth.get(tid);
        const n = d && d.frame === frame ? d.n : 0;
        depth.set(tid, { frame, n: n + 1 });
        return n === 0;
    }

    function leave() {
        const d = depth.get(Process.getCurrentThreadId());
        if (d && d.n > 0) d.n--;
    }

    // -> true when the text was logged (not a repeat).
    function record(component, text, returnAddress) {
        if (!text || !text.trim()) return false;
        const t = now();
        const path = safe(() => pathOf(component), "?");
        const parent = path.slice(0, path.lastIndexOf("/") + 1);
        const gen = generations.get(parent) ?? 0;
        const last = lastText.get(component);
        if (last && last.text === text) {
            const fresh = t - last.seen < REPEAT_MS && last.gen === gen;
            last.seen = t;
            if (fresh) return false;
        }
        let next = gen;
        if (!(last && last.text === text) && !CLOCK_RE.test(text)) generations.set(parent, (next = gen + 1));
        if (lastText.size > MAX_CACHE) lastText.clear();
        if (generations.size > MAX_CACHE) generations.clear();
        lastText.set(component, { text, seen: t, gen: next });
        const event = { t, f: frame, e: "txt", p: path, v: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text };
        if (returnAddress) event.c = returnAddress.sub(gameAssembly.base).toString();
        counts.txt++;
        emit(event);
        return true;
    }

    // Per entry point: how the hook went in, outermost calls, texts logged.
    // Written to the trace (meta at start, stats at stop), so a trace tells by
    // itself which overloads the game actually uses.
    function track(label, how) {
        hooks[label] = how;
        if (how !== "missing") calls[label] = { calls: 0, logged: 0 };
        console.log((how === "missing" ? "[!] not found: " : "[*] " + how + " ") + label);
        return calls[label];
    }

    function attach(label, method, read) {
        if (!method) return track(label, "missing");
        const address = method.virtualAddress.toString();
        if (hooked.has(address)) return track(label, "same body as " + hooked.get(address));
        hooked.set(address, label); // SetText(char[]) and SetCharArray(char[]) share one body
        const stat = track(label, "attached");
        Interceptor.attach(method.virtualAddress, {
            onEnter(args) {
                this.hooked = true;
                if (!safe(enter, false)) return;
                stat.calls++;
                const text = safe(() => read(args), null);
                if (safe(() => record(args[0].toString(), text, this.returnAddress), false)) stat.logged++;
                safe(stateTick, null); // main thread: the only place Unity's scene can be searched
            },
            onLeave() {
                if (this.hooked) leave();
            },
        });
    }

    const hooked = new Map(); // address -> label of the hook on it
    const tmp = Il2Cpp.domain.assembly("Unity.TextMeshPro").image.class("TMPro.TMP_Text");
    const uiText = Il2Cpp.domain.assembly("UnityEngine.UI").image.class("UnityEngine.UI.Text");
    const overload = (klass, name, ...types) => klass.methods.find((m) => m.name === name &&
        m.parameterCount === types.length && m.parameters.every((p, i) => p.type.name === types[i]));
    const S = "System.String", B = "System.Boolean", I = "System.Int32";
    const CHARS = "System.Char[]", SB = "System.Text.StringBuilder";
    const str = (args) => readString(args[1]);
    const chars = (args) => readChars(args[1], 0, -1);
    const charRange = (args) => readChars(args[1], args[2].toInt32(), args[3].toInt32());
    const sb = (args) => (args[1].isNull() ? null : readString(builderString(args[1], NULL)));
    const sbRange = (args) => (args[1].isNull() ? null
        : readString(builderRange(args[1], args[2].toInt32(), args[3].toInt32(), NULL)));

    attach("TMP_Text.set_text", tmp.method("set_text", 1), str);
    attach("TMP_Text.SetText(string)", overload(tmp, "SetText", S), str);
    attach("TMP_Text.SetText(string, bool)", overload(tmp, "SetText", S, B), str);
    attach("TMP_Text.SetText(StringBuilder)", overload(tmp, "SetText", SB), sb);
    attach("TMP_Text.SetText(StringBuilder, int, int)", overload(tmp, "SetText", SB, I, I), sbRange);
    attach("TMP_Text.SetText(char[])", overload(tmp, "SetText", CHARS), chars);
    attach("TMP_Text.SetCharArray(char[])", overload(tmp, "SetCharArray", CHARS), chars);
    attach("TMP_Text.SetText(char[], int, int)", overload(tmp, "SetText", CHARS, I, I), charRange);
    attach("TMP_Text.SetCharArray(char[], int, int)", overload(tmp, "SetCharArray", CHARS, I, I), charRange);
    attach("UI.Text.set_text", uiText.method("set_text", 1), str);
}

// ---------------------------------------------------------------- control

function install() {
    installed = true;
    Il2Cpp.perform(() => {
        const gameAssembly = Process.getModuleByName("GameAssembly.dll");
        const db = Il2Cpp.domain.assembly("Assembly-CSharp").image.class(DB_CLASS);
        forceLoadAll(db);
        // One file per session (they accumulate: rom-tools' `datatables uitrace` analyses all of them).
        const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").slice(0, 15);
        outputPath = outputDir + "/ui_trace_" + stamp + ".jsonl";
        out = new File(outputPath, "w");
        t0 = Date.now();
        const time = Il2Cpp.domain.assembly("UnityEngine.CoreModule").image.class("UnityEngine.Time");
        getFrameCount = new NativeFunction(time.method("get_frameCount", 0).virtualAddress, "int", ["pointer"]);
        const tables = hookTables(db);
        hookText(gameAssembly);
        try {
            setupState(Il2Cpp.domain.assembly("UnityEngine.CoreModule").image);
        } catch (err) {
            console.log("[!] game state disabled: " + err.message);
        }
        emit({ t: 0, e: "meta", gameAssembly: gameAssembly.base.toString(), tables, hooks, state: stateInfo });
        flush();
        console.log("[*] tracing -> " + outputPath);
        console.log("[*] open the windows to name (item tooltip, skills, buffs, ...); press Enter to stop.");
        setInterval(() => {
            flush();
            console.log("[*] rows read: " + counts.get + " | texts: " + counts.txt);
        }, FLUSH_MS * 5);
        setInterval(() => {
            safe(refreshCaches, null);
            flush();
        }, FLUSH_MS);
    });
}

function stop() {
    emit({ t: now(), f: frame, e: "stats", rows: counts.get, texts: counts.txt, calls, reads: readStats(), state: stateCounts });
    flush();
    for (const [label, s] of Object.entries(calls)) {
        if (s.calls) console.log("    " + label + ": " + s.calls + " calls, " + s.logged + " logged");
    }
    const reads = Object.entries(readStats()).sort((a, b) => b[1] - a[1]);
    console.log("    rows read by table: " + reads.slice(0, 15).map(([name, n]) => name + " " + n).join(", ") +
        (reads.length > 15 ? ", ... (" + reads.length + " tables)" : ""));
    console.log("    state snapshots: " + (Object.entries(stateCounts).map(([k, n]) => k + " " + n).join(", ") || "none"));
    if (out) out.close();
    out = null;
    console.log("[*] DONE. rows read: " + counts.get + ", texts: " + counts.txt + " -> " + outputPath);
    send({ type: "done", rows: counts.get, texts: counts.txt });
}

// spawn.py posts the storage path (config); each Enter posts {type:"dump"}.
function onTrigger() {
    if (!installed) install();
    else {
        stop();
        return;
    }
    recv("dump", onTrigger);
}

recv("config", (msg) => {
    outputDir = (msg && msg.outDir) || ".";
    Il2Cpp.perform(() => {
        console.log("[*] il2cpp ready. Press Enter (title screen or later) to start tracing.");
    });
});
recv("dump", onTrigger);
