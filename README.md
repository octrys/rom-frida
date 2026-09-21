# rom-frida

frida tools and scripts for **ROM: Golden Age**. They run on the **Windows** box
with the game installed — frida injects locally.

Agents are [`frida-il2cpp-bridge`](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
modules: `GameAssembly.dll` is Themida/WinLicense-packed, so the il2cpp
registration (field types, offsets, method RVAs) is only readable at **runtime**,
after Themida unpacks it in memory. Static dumping is out; these agents walk the
live, unpacked il2cpp domain instead.

Agents so far: the full client dump, and a typed table dump. More will be added
here as they are built.

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
but the values and types are ground truth — enough to build an offline typed
decoder for the bundle extractor.

```bash
python spawn.py dump_tables.js
```

Most tables are lazy-loaded, so the agent **force-loads every table** (it invokes
each table's getter, which loads it from the local bundle) right before dumping.
That means you can snapshot straight from the **title screen** — no in-game
navigation needed. The snapshot is manual: **press Enter** in `spawn.py`'s console
to force-load and dump; it writes the file and exits on its own. A 15-minute
safety cap dumps whatever is loaded if you never trigger it.

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
