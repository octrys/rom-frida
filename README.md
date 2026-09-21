# rom-frida

frida tools and scripts for **ROM: Golden Age**. They run on the **Windows** box
with the game installed — frida injects locally.

Agents are [`frida-il2cpp-bridge`](https://github.com/vfsfitvnm/frida-il2cpp-bridge)
modules: `GameAssembly.dll` is Themida/WinLicense-packed, so the il2cpp
registration (field types, offsets, method RVAs) is only readable at **runtime**,
after Themida unpacks it in memory. Static dumping is out; these agents walk the
live, unpacked il2cpp domain instead.

Right now the repo ships a single agent — the full client dump. More will be
added here as they are built.

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
