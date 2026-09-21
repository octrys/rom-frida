"""Compile a frida agent, spawn ROMGoldenAge.exe with -env=Real, and inject it.

Local injection on Windows — NO frida-server, NO `-U`. Using this wrapper
instead of the frida CLI avoids its arg-parsing choking on `-env=...`, and it
runs `frida-compile` for you so there is no separate build step.

Run it from the repo root (where node_modules lives). Agent names are looked up
in scripts/, and the compiled bundle is written to the repo root as agent.js.

Usage (deps installed once with `npm i -D frida-compile frida-il2cpp-bridge`):
    python spawn.py dump_client.js                     # compile + inject
    python spawn.py dump_client.js "C:\\path\\to\\client"  # override client dir

The source agent is compiled with `npx frida-compile` to `agent.js` (git-ignored)
and that bundle is injected. Set ROM_SKIP_COMPILE=1 to inject the given file
as-is (an already-bundled agent, or when node/npx is unavailable).

The client dir defaults to $ROM_CLIENT, else the placeholder below — set it to
wherever ROMGoldenAge.exe lives on the Windows box.
"""

import os
import shutil
import subprocess
import sys
import threading

import frida

DEFAULT_BASE = r"C:\redlabgames\ROMGoldenAge\client"

REPO_ROOT = os.path.dirname(os.path.abspath(__file__))  # node_modules lives here
SCRIPTS_DIR = os.path.join(REPO_ROOT, "scripts")  # agents live here
COMPILED = os.path.join(REPO_ROOT, "agent.js")  # git-ignored build output
STORAGE_DIR = os.path.join(REPO_ROOT, "storage")  # dump output (agents read __ROM_OUT_DIR__)


def resolve_agent(name: str) -> str:
    """Accept a bare agent name (looked up in scripts/) or an explicit path."""
    if os.path.isfile(name):
        return name
    candidate = os.path.join(SCRIPTS_DIR, name)
    if os.path.isfile(candidate):
        return candidate
    sys.exit(f"[!] agent not found: {name} (looked in cwd and {SCRIPTS_DIR})")


source_agent = resolve_agent(sys.argv[1] if len(sys.argv) > 1 else "dump_client.js")
base = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("ROM_CLIENT", DEFAULT_BASE)
exe = os.path.join(base, "ROMGoldenAge.exe")


def compile_agent(src: str, out: str) -> str:
    """Bundle `src` to `out` with frida-compile; return the file to inject."""
    if os.environ.get("ROM_SKIP_COMPILE"):
        print(f"[*] ROM_SKIP_COMPILE set — injecting {src} without compiling")
        return src
    npx = shutil.which("npx") or "npx"
    cmd = [npx, "frida-compile", src, "-o", out]
    print(f"[*] compiling: {' '.join(cmd)}")
    try:
        subprocess.run(cmd, check=True)
    except FileNotFoundError:
        sys.exit("[!] npx not found — install Node.js, or set ROM_SKIP_COMPILE=1 to inject a prebuilt agent")
    except subprocess.CalledProcessError as err:
        sys.exit(f"[!] frida-compile failed (exit {err.returncode})")
    print(f"[+] compiled -> {out}")
    return out


agent_path = compile_agent(source_agent, COMPILED)

device = frida.get_local_device()
pid = device.spawn([exe, "-env=Real"], cwd=base)
print(f"[*] spawned pid={pid} ({exe})")

session = device.attach(pid)
with open(agent_path, "r", encoding="utf-8") as handle:
    source = handle.read()

done = threading.Event()


def on_message(msg, _data):
    payload = msg.get("payload", msg)
    print(payload)
    # Agents that finish on their own (e.g. dump_tables.js) send {type:"done"};
    # let the wrapper exit instead of idling forever.
    if isinstance(payload, dict) and payload.get("type") == "done":
        done.set()


script = session.create_script(source)
script.on("message", on_message)
script.load()

# Tell file-writing agents (e.g. dump_client.js) where to dump — over frida's
# message channel, NOT by editing the compiled bundle (its `📦` header must stay
# first). Sent after load so the agent's recv() handler is already registered.
os.makedirs(STORAGE_DIR, exist_ok=True)
script.post({"type": "config", "outDir": STORAGE_DIR})

device.resume(pid)
print("[*] injected + resumed. Some agents write on load; others wait for you to")
print("[*] reach a screen (login/world) and press Enter here to trigger a snapshot.")


def watch_stdin() -> None:
    """Forward each Enter/line as a {type:"dump"} trigger to the agent."""
    for _line in sys.stdin:
        if done.is_set():
            return
        print("[*] snapshot trigger sent")
        script.post({"type": "dump"})


# Daemon so it never blocks exit once the agent signals done.
threading.Thread(target=watch_stdin, daemon=True).start()

# Stay alive so agent output keeps streaming. Exit on its own once an agent
# signals completion (done event); otherwise wait until Ctrl+C.
try:
    done.wait()
    print("[*] agent signalled done — detaching.")
except KeyboardInterrupt:
    pass
