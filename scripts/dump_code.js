/*
 * Game code dump — the unpacked GameAssembly.dll image, plus what each of its
 * il2cpp metadata slots refers to. Input for rom-tools' `datatables xref`,
 * which finds, in the code, where each table column is read.
 *
 * `GameAssembly.dll` is Themida-packed on disk; its code is only readable once
 * unpacked in memory. By the time the il2cpp runtime is up it is, and this
 * agent writes, to storage/:
 *
 *   gameassembly.bin         the module's mapped image, byte for byte at its
 *                            RVA (file offset == RVA), so rom_dump.cs's method
 *                            RVAs (same build) point straight into it.
 *                            Unreadable pages stay zero.
 *   gameassembly_slots.json  {base, size, init, slots: {"0x<rva>": {u, …}}}
 *
 * Metadata slots: il2cpp (v31) code reaches classes, methods, fields and
 * string literals through globals that start out holding an encoded token
 * ((usage << 29) | (index << 1) | 1) and are filled in lazily by
 * il2cpp_codegen_initialize_runtime_metadata(&slot) on a method's first run.
 * Offline, a disassembly sees only the slot's address. Every slot appears in
 * code as `lea rcx, [rip+slot]; call init`, and init is by far the most
 * called target of that pair — so the agent finds both by scanning the code,
 * calls init on each slot (the call the game itself makes) and records what
 * the slot then points to:
 *   1 TypeInfo -> {c: class}            2 Il2CppType -> {t: type}
 *   3 MethodDef / 6 MethodRef -> {c, m, sig, rva}  (inflated generic methods
 *     included — their code has no entry in rom_dump.cs)
 *   4 FieldInfo -> {c, f, off, st}      5 StringLiteral -> {s: string}
 *
 * Read-only apart from resolving those slots. Finishes on its own.
 *
 *   python spawn.py dump_code.js
 */
import "frida-il2cpp-bridge";

const CHUNK = 0x100000;
const SCAN_CHUNK = 0x1000000;
// lea rcx, [rip+rel32] ; call rel32
const SLOT_INIT_PATTERN = "48 8d 0d ?? ?? ?? ?? e8";

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function hex(n) {
  return "0x" + n.toString(16);
}

function dumpImage(mod, path) {
  const out = new File(path, "wb");
  let unreadable = 0;
  for (let off = 0; off < mod.size; off += CHUNK) {
    const len = Math.min(CHUNK, mod.size - off);
    let buf;
    try {
      buf = mod.base.add(off).readByteArray(len);
    } catch (_err) {
      // Mixed readability inside the chunk: copy page by page.
      const parts = new Uint8Array(len);
      for (let p = 0; p < len; p += Process.pageSize) {
        try {
          parts.set(new Uint8Array(mod.base.add(off + p).readByteArray(Math.min(Process.pageSize, len - p))), p);
        } catch (_e) {
          unreadable++; // stays zero
        }
      }
      buf = parts.buffer;
    }
    out.write(buf);
  }
  out.close();
  return unreadable;
}

// Every `lea rcx,[rip+slot]; call target` in the module's code, chunk by
// chunk (one scan of the whole image returns millions of matches at once).
function scanSlotCalls(mod, visit) {
  const modEnd = mod.base.add(mod.size);
  const code = Process.enumerateRanges({ protection: "r-x", coalesce: true })
    .filter((r) => r.base.compare(mod.base) >= 0 && r.base.compare(modEnd) < 0);
  for (const range of code) {
    const end = range.base.add(range.size).compare(modEnd) > 0 ? modEnd : range.base.add(range.size);
    for (let at = range.base; at.compare(end) < 0; at = at.add(SCAN_CHUNK)) {
      const size = Math.min(SCAN_CHUNK + 11, end.sub(at).toUInt32());
      for (const match of Memory.scanSync(at, size, SLOT_INIT_PATTERN)) {
        const p = match.address;
        if (p.compare(at.add(SCAN_CHUNK)) >= 0) continue; // the overlap belongs to the next chunk
        const slot = p.add(7).add(p.add(3).readS32()).sub(mod.base).toUInt32();
        const target = p.add(12).add(p.add(8).readS32()).sub(mod.base).toUInt32();
        visit(slot, target);
      }
    }
  }
}

function describe(usage, value, base) {
  switch (usage) {
    case 1:
      return { u: 1, c: new Il2Cpp.Class(value).type.name };
    case 2:
      return { u: 2, t: new Il2Cpp.Type(value).name };
    case 3:
    case 6: {
      const m = new Il2Cpp.Method(value);
      const va = m.virtualAddress;
      return {
        u: usage,
        c: m.class.type.name,
        m: m.name,
        sig: safe(() => m.toString().replace(/ \/\/.*$/, ""), m.name),
        rva: va.isNull() ? null : hex(va.sub(base).toUInt32()),
      };
    }
    case 4: {
      const f = new Il2Cpp.Field(value);
      return { u: 4, c: f.class.type.name, f: f.name, off: f.isStatic ? null : f.offset, st: f.isStatic };
    }
    case 5:
      return { u: 5, s: new Il2Cpp.String(value).content };
    default:
      return { u: usage };
  }
}

function resolveSlots(mod) {
  const counts = new Map();
  scanSlotCalls(mod, (_slot, target) => counts.set(target, (counts.get(target) || 0) + 1));
  let init = null;
  for (const [target, n] of counts) if (init === null || n > counts.get(init)) init = target;
  console.log(`[*] metadata init = ${hex(init)} (${counts.get(init)} calls)`);

  const slots = new Set();
  scanSlotCalls(mod, (slot, target) => { if (target === init) slots.add(slot); });
  const initFn = new NativeFunction(mod.base.add(init), "void", ["pointer"]);
  const out = {};
  let failed = 0;
  for (const rva of slots) {
    const slot = mod.base.add(rva);
    const token = slot.readU64();
    // Already resolved (the game ran that code): the usage kind went with the token.
    if (!token.and(1).equals(1)) {
      failed++;
      continue;
    }
    const usage = token.shr(29).and(7).toNumber();
    safe(() => initFn(slot), null);
    const value = slot.readPointer();
    const entry = value.isNull() || value.and(1).equals(1) ? null : safe(() => describe(usage, value, mod.base), null);
    if (entry) out[hex(rva)] = entry;
    else failed++;
  }
  console.log(`[*] ${slots.size} slots, ${Object.keys(out).length} resolved, ${failed} not`);
  return { init: hex(init), slots: out };
}

function run(outDir) {
  Il2Cpp.perform(() => {
    const mod = Process.getModuleByName("GameAssembly.dll");
    console.log(`[*] GameAssembly.dll base=${mod.base} size=${hex(mod.size)}`);
    const unreadable = dumpImage(mod, `${outDir}/gameassembly.bin`);
    console.log(`[+] wrote ${outDir}/gameassembly.bin (${unreadable} unreadable pages)`);

    const { init, slots } = resolveSlots(mod);
    const file = new File(`${outDir}/gameassembly_slots.json`, "w");
    file.write(JSON.stringify({ base: mod.base.toString(), size: mod.size, unreadablePages: unreadable, init, slots }));
    file.close();
    console.log(`[+] wrote ${outDir}/gameassembly_slots.json`);
    send({ type: "done" });
  });
}

let started = false;
const start = (dir) => { if (!started) { started = true; run(dir); } };
recv("config", (msg) => start((msg && msg.outDir) || "."));
setTimeout(() => start("."), 1500);
