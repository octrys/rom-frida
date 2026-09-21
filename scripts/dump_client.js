/*
 * Full client dump — the reusable il2cpp snapshot every later step reads from.
 *
 * `GameAssembly.dll` is Themida/WinLicense-packed, so the il2cpp registration
 * (Il2CppMetadataRegistration->types[]) — the field TYPES, offsets and method
 * RVAs — is only readable at RUNTIME, after Themida unpacks it in memory. This
 * walks the LIVE (unpacked) il2cpp domain and writes two artifacts:
 *
 *   rom_dump.cs   full human-readable dump: every class, fields WITH TYPES,
 *                 method offsets. This is what you grep by hand.
 *   rom_dump.json machine-readable index of every class {namespace, name, full,
 *                 parent, fields:[{name,type,offset,isStatic,isLiteral}]} — what
 *                 later steps consume programmatically.
 *
 * Read-only: it dumps and changes nothing.
 *
 * Output lands in the repo's storage/ folder: spawn.py posts its absolute path
 * as a {type:"config", outDir} message (frida channel — NOT baked into the
 * compiled bundle, whose `📦` header must stay first). Run standalone without
 * spawn.py and it falls back to "." (the game process's working dir) after a
 * short wait. Both files are git-ignored.
 *
 * Build + run (local injection on Windows — NO frida-server; see README.md):
 *   python spawn.py dump_client.js
 *   python spawn.py dump_client.js "C:\path\to\client"
 */
import "frida-il2cpp-bridge";

// Namespace/name prefix filter for the JSON index. Empty = dump every class
// (~26k types). Narrow it (e.g. ["Protocol", "C2S_", "S2C_"]) to slim the file
// when a step only needs part of the tree; the .cs dump is always complete.
const JSON_INCLUDE = [];

function wantsInJson(namespace, name) {
    if (JSON_INCLUDE.length === 0) return true;
    const full = (namespace ? namespace + "." : "") + name;
    return JSON_INCLUDE.some((prefix) => namespace.startsWith(prefix) ||
        name.startsWith(prefix) || full.startsWith(prefix));
}

function runDump(outDir) {
  Il2Cpp.perform(() => {
    const OUT_DIR = outDir;
    console.log("[*] il2cpp ready. unityVersion=" + Il2Cpp.unityVersion);
    console.log("[*] output dir: " + OUT_DIR);

    // 1) Full typed C# dump — the canonical reference for every later step.
    try {
        Il2Cpp.dump("rom_dump.cs", OUT_DIR);
        console.log("[+] wrote " + OUT_DIR + "/rom_dump.cs");
    } catch (err) {
        console.log("[!] Il2Cpp.dump failed: " + err);
    }

    // 2) Structured JSON index of the classes (default: all of them).
    const out = [];
    for (const assembly of Il2Cpp.domain.assemblies) {
        for (const klass of assembly.image.classes) {
            const namespace = klass.namespace || "";
            const name = klass.name;
            if (!wantsInJson(namespace, name)) continue;
            let parent = null;
            try {
                parent = klass.parent ? klass.parent.type.name : null;
            } catch (_err) {
                parent = null;
            }
            const fields = klass.fields.map((field) => ({
                name: field.name,
                type: field.type.name,
                offset: field.offset,
                isStatic: field.isStatic,
                isLiteral: field.isLiteral,
            }));
            out.push({
                full: (namespace ? namespace + "." : "") + name,
                name: name,
                ns: namespace,
                parent: parent,
                assembly: assembly.name,
                fields: fields,
            });
        }
    }

    const handle = new File(OUT_DIR + "/rom_dump.json", "w");
    handle.write(JSON.stringify(out));
    handle.close();
    console.log("[+] wrote " + OUT_DIR + "/rom_dump.json (" + out.length + " classes)");
    console.log("[*] DONE. Files are in " + OUT_DIR + " (the repo's storage/ via spawn.py).");
  });
}

// Prefer the output dir spawn.py posts; fall back to "." if run standalone.
let started = false;
const start = (dir) => { if (!started) { started = true; runDump(dir); } };
recv("config", (msg) => start((msg && msg.outDir) || "."));
setTimeout(() => start("."), 1500);
