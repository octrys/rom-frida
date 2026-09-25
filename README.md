# rom-frida

frida tools and scripts for **ROM: Golden Age**. They run on the **Windows** box
with the game installed — frida injects locally.

Agents are [`frida-il2cpp-bridge`](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
modules: `GameAssembly.dll` is Themida/WinLicense-packed, so the il2cpp
registration (field types, offsets, method RVAs) is only readable at **runtime**,
after Themida unpacks it in memory. Static dumping is out; these agents walk the
live, unpacked il2cpp domain instead.

Agents so far: the full client dump, a typed table dump, and a UI text trace.
More will be added here as they are built.

This repo only collects data from the running client. The offline analysis
that consumes it (table decoding, schema, field naming) lives in rom-tools'
`client/datatables/`.

## Setup

```bash
npm i -D frida-compile frida-il2cpp-bridge   # once (deps in package.json)
python spawn.py dump_client.js               # compiles + injects on Windows
```

`spawn.py` runs `frida-compile` on the source agent in `scripts/` (→ git-ignored
`agent.js`), then launches `ROMGoldenAge.exe -env=Real` and injects it — no
separate build step. Point it at the client dir via `$ROM_CLIENT` or a second
arg, and set `ROM_SKIP_COMPILE=1` to inject a prebuilt agent as-is:

```bash
set ROM_CLIENT=C:\path\to\client && python spawn.py dump_client.js
python spawn.py dump_client.js "C:\path\to\client"
```

Runs on the **Windows** box with the game installed — frida injects locally,
there is no frida-server and no `-U`.

## Agents

### `scripts/dump_client.js` — full client dump

Read-only. Walks the live (Themida-unpacked) il2cpp domain and writes to
`storage/`:

- `rom_dump.cs` — full typed C# dump: every class, fields WITH TYPES, method
  signatures + RVAs. Grep it by hand.
- `rom_dump.json` — machine-readable class index
  `{ns, name, full, parent, assembly, fields:[{name,type,offset,isStatic,isLiteral}]}`.

Dump once, then analyse the files offline (`grep`/`jq`/Python) — no re-injection.
The JSON indexes all ~26k classes by default; narrow `JSON_INCLUDE` in the agent
to slim it. The `.cs` dump is always complete.

```bash
python spawn.py dump_client.js
```

### `scripts/dump_tables.js` — typed table dump

Read-only. The game-data tables ship as a custom binary blob; their row structs
are in the client dump, but the on-wire field order is bespoke and not derivable
statically. This agent sidesteps that: it walks the live table database, reads
every parsed row straight from memory, and serialises it fully typed (structs,
enums, `List<T>`, arrays, strings) by the row's own field names. Writes to
`storage/tables_runtime.json`, keyed by table name. Field names stay obfuscated,
but the values and types are ground truth. rom-tools' `datatables infer`
learns the bundle's row layouts against it (together with `rom_dump.cs`, from
the same build).

```bash
python spawn.py dump_tables.js
```

Most tables are lazy-loaded, so the agent **force-loads every table** (it invokes
each table's getter, which loads it from the local bundle) right before dumping.
That means you can snapshot straight from the **title screen** — no in-game
navigation needed. The snapshot is manual: **press Enter** in `spawn.py`'s console
to force-load and dump; it writes the file and exits on its own. A 15-minute
safety cap dumps whatever is loaded if you never trigger it.

### `scripts/trace_ui_text.js` — UI text trace

Read-only. Records what the UI displays, to name obfuscated table fields by
correlation: every string set on a `TMP_Text` / `UI.Text`, with the GameObject
path (plaintext, e.g. `Btn_Field/Text_WorldLevel`), the caller's RVA and the
frame number, plus every table row read by key.

- **Row reads**: lazy tables (`LocalName`, and `Localization`, whose keys are
  the UI caption keys) go through the table getter. Eagerly loaded tables
  (`Map_Data`, `Item_Data`…) never do: the game looks rows up in the table's
  cache dictionary directly, so its lookups (`FindEntry` / `TryGetValue` /
  `get_Item` / `ContainsKey`) are hooked for every table with struct rows
  (123 of 125) — `Dictionary<int, struct>` is compiled per table, so each hook
  sees one table only. Reads include game logic, not just the UI; offline,
  only the rows read right before a text are its candidates. `meta` counts
  the hooks, `stats` the rows read per table.
- **Text entry points**: `set_text`, `SetText(string, bool)` and the
  `char[]` / `StringBuilder` overloads. The game formats in C# and calls the
  first two; the others are a safety net (0 calls so far). Only the outermost
  call is logged when one overload calls another.
- **Records**: a window fills its labels in one frame, so offline a record is
  the texts of one instance (a list cell, a map icon — else one GameObject)
  in one frame. A node whose name a sibling shares carries its sibling index
  in the path (`Slot(Clone)#3`, `WorldMapPointBase#12`), so each cell or icon
  is its own record. Uniquely named nodes stay bare, so a popup reordered on
  screen keeps its path.
- **Game state**: every 2 s, on the main thread, the live components that keep
  a table row in a field (`CMapManager.m_sMapData`, `CUIWorldMapWindow`,
  `CActorMonster`…, ~100 classes) are found with one
  `FindObjectsOfType(MonoBehaviour)`; each one's row scalars and plaintext
  fields (numbers, enums, `Vector2Int`, list counts, the text of its text
  components) are logged as a `state` event when they change. The row is
  known by its key, so offline this names columns after the game's own
  fields: `CMapManager.m_vMapSize` equals `Map_Data`'s size struct,
  `m_nMapID` its key. Variety is what counts — different maps, monsters,
  windows.
- **Self-describing**: the `meta` event lists how each entry point was hooked
  (`attached` / `missing`), and a `stats` event at stop counts
  calls and logged texts per entry point — which overloads the game really
  uses is in the trace itself (also printed on stop).
- **Repeats**: a label re-set to the same text within 1.5 s (sliding — a label
  refreshed every frame logs once) is dropped, unless a sibling label changed
  in between: then another item is on screen and the unchanged value is
  logged again for it.

```bash
python spawn.py trace_ui_text.js
```

Press **Enter** once to force-load the tables and start tracing, open the
windows whose tables you want named (item tooltips, skills, world map…) and
move around (maps, monsters, NPCs feed the game-state snapshots), then press
**Enter** again to stop. Each session writes its own
`storage/ui_trace_<UTC stamp>.jsonl`. The matching happens offline, in
rom-tools' `datatables uitrace`, which accumulates every trace you feed it.
Several distinct entries per window give the most evidence.

## Output — `storage/`

`spawn.py` creates `storage/` and posts its absolute path to the agent
(`{type:"config", outDir}` over frida's message channel — never baked into the
compiled bundle, whose `📦` header must stay first). Dumps land there. The folder
is tracked (`.gitkeep`) but its contents are git-ignored — they are large,
generated artifacts.

## Conventions

- Agents live in `scripts/`, are `frida-il2cpp-bridge` modules, and are compiled
  with `frida-compile` by `spawn.py`.
- `node_modules/`, compiled `agent.js`, and `storage/` contents are git-ignored.
