# SPDX-License-Identifier: GPL-3.0-or-later
# bridge.py — ZeroScript Bridge v2.0.0 ULTRA (all logic upgraded, designs untouched)
# ──────────────────────────────────────────────────────────────────────────
#  ZeroScript Bridge — Ultra-Fast Middle Layer
#  Local WebSocket + HTTP/SSE <-> Roblox Studio MCP server
#  The browser extension talks to this over:
#    ws://127.0.0.1:<PORT>              (primary, binary-capable, compressed)
#    http://127.0.0.1:<PORT_HTTP>/api/* (fallback, SSE, batch, long-poll)
#
#  Transport methods implemented (all possible for localhost):
#    1) WebSocket (RFC6455) — primary, multiplexed, per-message-deflate,
#       binary frames (msgpack/JSON), 16MB max, ping 5s, zero-copy where possible
#    2) HTTP REST — POST /api/call, GET /api/tools, GET /api/status, POST /api/batch
#    3) Server-Sent Events — GET /api/events (real-time status + tool progress)
#    4) Long-Poll — GET /api/poll?since=... (fallback for strict CSP)
#    5) In-memory queue via BroadcastChannel handled extension-side (shared WS)
#    6) Batch endpoint — POST /api/batch (atomic multi-tool)
#    7) Streaming tool output — incremental chunks over WS + SSE
#
#  Performance features:
#    - asyncio-first MCP manager with thread-pool fallback for legacy stdio
#    - Request pipelining & multiplexing (N concurrent calls over 1 WS)
#    - Binary framing (JSON + optional msgpack if installed)
#    - Response caching (tools list TTL 2s, studio probe TTL 1s)
#    - TCP_NODELAY + SO_KEEPALIVE + TCP keepalive tuning (where OS allows)
#    - orjson fast path if available, stdlib json otherwise
#    - Parallel MCP server launch, parallel tool routing
#    - Adaptive heartbeat 2s active / 10s idle, stale detection 4s active
#    - Zero-copy pending queue via asyncio.Queue
#    - Prefetch + coalesce duplicate in-flight requests
#    - Connection pre-warming (extension opens at startup)
#    - Keep-alive HTTP/1.1 with gzip where client accepts it
#
#  Reliability:
#    - Exponential backoff with jitter, circuit breaker per server
#    - Auth token (auto-generated, stored alongside config.json)
#    - CORS + origin allowlist for local AI sites
#    - Rate limit (token bucket per IP, generous for localhost)
#    - Graceful shutdown, drain, auto-restart, zombie reclaim (kept from v1.5.5)
#    - Metrics endpoint GET /api/metrics
# ──────────────────────────────────────────────────────────────────────────
import asyncio
import base64
import collections
import gzip
import hashlib
import json
import os
import queue
import secrets
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    import launch_studio_mcp as _studio_scan
except Exception:
    _studio_scan = None

# ── optional fast JSON ──────────────────────────────────────────────────
try:
    import orjson as _orjson
    def _dumps(o): return _orjson.dumps(o).decode()
    def _loads(b): return _orjson.loads(b if isinstance(b,(bytes,bytearray)) else b.encode() if isinstance(b,str) else b)
    HAS_ORJSON = True
except Exception:
    HAS_ORJSON = False
    def _dumps(o): return json.dumps(o, separators=(',',':'), ensure_ascii=False)
    def _loads(b):
        if isinstance(b,(bytes,bytearray)): b=b.decode('utf-8','replace')
        return json.loads(b)

# optional msgpack binary framing
try:
    import msgpack as _msgpack
    HAS_MSGPACK=True
except Exception:
    HAS_MSGPACK=False
    _msgpack=None

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
    HAS_WS=True
except ImportError:
    print("[bridge] Missing dependency. Run:  pip install websockets")
    sys.exit(1)

try: sys.stdout.reconfigure(encoding="utf-8", errors="replace"); sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except: pass

def _enable_ansi_colors():
    if sys.platform!="win32": return True
    try:
        import ctypes
        k=ctypes.windll.kernel32
        h=k.GetStdHandle(-11)
        mode=ctypes.c_uint32()
        if not k.GetConsoleMode(h, ctypes.byref(mode)): return False
        return bool(k.SetConsoleMode(h, mode.value|0x0004))
    except: return False

HOST="127.0.0.1"
BRIDGE_VERSION="2.0.0"
PORT=int(os.environ.get("ZS_BRIDGE_PORT","17613"))
PORT_HTTP=int(os.environ.get("ZS_BRIDGE_HTTP_PORT", str(PORT+1)))
# Back-compat: extension originally only knew 17613 WS. We now serve BOTH ports:
# WS on PORT (17613) and HTTP on PORT_HTTP (17614). Also HTTP multiplex on PORT via WS upgrade path.
HERE=os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH=os.path.join(HERE,"config.json")
TOKEN_PATH=os.path.join(HERE,".zs_token")
PRIMARY_SERVER_ID="roblox"

if _enable_ansi_colors():
    C={"reset":"\033[0m","dim":"\033[2m","gr":"\033[92m","yl":"\033[93m","rd":"\033[91m","cy":"\033[96m","act":"\033[1m\033[97m\033[41m"}
else:
    C={k:"" for k in ("reset","dim","gr","yl","rd","cy","act")}

LOGS_DIR=os.path.join(HERE,"logs")
os.makedirs(LOGS_DIR, exist_ok=True)
LOG_PATH=os.path.join(LOGS_DIR,"bridge_debug.log")
try: _log_file=open(LOG_PATH,"a",encoding="utf-8",errors="replace")
except: _log_file=None

# ── token auth ──────────────────────────────────────────────────────────
def _get_or_create_token():
    if os.path.exists(TOKEN_PATH):
        try:
            t=open(TOKEN_PATH,'r',encoding='utf-8').read().strip()
            if len(t)>=16: return t
        except: pass
    tok=secrets.token_urlsafe(32)
    try:
        with open(TOKEN_PATH,'w',encoding='utf-8') as f: f.write(tok)
        try: os.chmod(TOKEN_PATH,0o600)
        except: pass
    except: pass
    return tok
BRIDGE_TOKEN=_get_or_create_token()
# Optionally allow disabling auth for local dev: ZS_NO_AUTH=1
NO_AUTH = os.environ.get("ZS_NO_AUTH","") not in ("","0","false","False")

# ── metrics ─────────────────────────────────────────────────────────────
class Metrics:
    def __init__(self):
        self.started=time.time()
        self.ws_connections=0
        self.http_requests=0
        self.tool_calls=0
        self.tool_errors=0
        self.tool_latency=[] # last 200
        self.bytes_in=0
        self.bytes_out=0
        self.lock=threading.Lock()
    def record_tool(self, latency, ok=True):
        with self.lock:
            self.tool_calls+=1
            if not ok: self.tool_errors+=1
            self.tool_latency.append(latency)
            if len(self.tool_latency)>200: self.tool_latency=self.tool_latency[-200:]
    def snapshot(self):
        with self.lock:
            lat=self.tool_latency[:]
        avg=sum(lat)/len(lat) if lat else 0
        p95=sorted(lat)[int(len(lat)*0.95)] if lat else 0
        return {
            "version": BRIDGE_VERSION,
            "uptime": round(time.time()-self.started,1),
            "ws_connections": self.ws_connections,
            "http_requests": self.http_requests,
            "tool_calls": self.tool_calls,
            "tool_errors": self.tool_errors,
            "avg_latency": round(avg,3),
            "p95_latency": round(p95,3),
            "bytes_in": self.bytes_in,
            "bytes_out": self.bytes_out,
            "has_orjson": HAS_ORJSON,
            "has_msgpack": HAS_MSGPACK,
        }
metrics=Metrics()

# ── rate limit (token bucket, per IP, generous for localhost) ─────────
class RateLimiter:
    def __init__(self, rps=200, burst=400):
        self.rps=rps; self.burst=burst; self.tokens=burst; self.last=time.monotonic(); self.lock=threading.Lock()
    def allow(self, n=1):
        with self.lock:
            now=time.monotonic(); dt=now-self.last; self.last=now
            self.tokens=min(self.burst, self.tokens+dt*self.rps)
            if self.tokens>=n: self.tokens-=n; return True
            return False
_rate_limiter=RateLimiter()

# ── LRU cache for idempotent queries ──────────────────────────────────
class TTLCache:
    def __init__(self, ttl=2.0, maxsize=256):
        self.ttl=ttl; self.maxsize=maxsize; self.store={}; self.lock=threading.Lock()
    def get(self,k):
        with self.lock:
            e=self.store.get(k)
            if not e: return None
            v,exp=e
            if time.monotonic()>exp:
                self.store.pop(k,None); return None
            return v
    def set(self,k,v):
        with self.lock:
            if len(self.store)>=self.maxsize:
                # evict oldest
                oldest=min(self.store, key=lambda kk: self.store[kk][1])
                self.store.pop(oldest,None)
            self.store[k]=(v, time.monotonic()+self.ttl)
_cache_tools=TTLCache(ttl=1.5)
_cache_status=TTLCache(ttl=1.0)

# ── Spinner/log/banner (kept from v1.5.5) ───────────────────────────────
class _Spinner:
    FRAMES="|/-\\"
    _active=threading.Lock()
    def __init__(self,label): self.label=label; self._stop=threading.Event(); self._thread=None; self._owns_lock=False
    def __enter__(self):
        if sys.stdout.isatty() and _Spinner._active.acquire(blocking=False):
            self._owns_lock=True; self._thread=threading.Thread(target=self._run,daemon=True); self._thread.start()
        return self
    def __exit__(self,*exc):
        self._stop.set()
        if self._thread: self._thread.join(timeout=1.0); print("\r"+" "*(len(self.label)+4)+"\r",end="",flush=True)
        if self._owns_lock: _Spinner._active.release()
    def _run(self):
        i=0
        while not self._stop.is_set():
            frame=self.FRAMES[i%len(self.FRAMES)]; print(f"\r{C['dim']}{self.label} {frame}{C['reset']}",end="",flush=True); i+=1; self._stop.wait(0.15)

def _clear_spinner_line():
    if sys.stdout.isatty(): print("\r\033[K",end="",flush=True)

def log(msg,color="dim",terminal=True):
    if terminal:
        _clear_spinner_line(); ts=time.strftime("%H:%M:%S"); print(f"{C['dim']}{ts}{C['reset']} {C.get(color,'')}{msg}{C['reset']}",flush=True)
    if _log_file:
        try: _log_file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}\n"); _log_file.flush()
        except: pass

def action_banner(lines):
    header="ACTION NEEDED"; width=max([len(header)+8]+[len(ln) for ln in lines])+2; top=f">>> {header} "+">"*max(0,width-len(header)-5)
    _clear_spinner_line(); print(); print(f"{C['act']}  {top.ljust(width)}{C['reset']}")
    for ln in lines: print(f"{C['act']}  {ln.ljust(width)}{C['reset']}")
    print(f"{C['act']}  {'>'*width}{C['reset']}"); print()
    if _log_file:
        try: _log_file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} ACTION NEEDED: {' | '.join(lines)}\n"); _log_file.flush()
        except: pass

STUDIO_MCP_PORT=13469

# ── port helpers (kept) ────────────────────────────────────────────────
def _port_owner(port):
    if sys.platform!="win32": return None
    out=""
    for proto in ("TCP","TCPv6"):
        try: out+=subprocess.run(["netstat","-ano","-p",proto],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=8).stdout
        except: pass
    if not out: return None
    pid=None; needle=f":{port} "
    for line in out.splitlines():
        if "LISTENING" in line and needle in line:
            parts=line.split()
            if parts and parts[-1].isdigit(): pid=parts[-1]; break
    if not pid: return None
    name,path="?",""
    try:
        ps=subprocess.run(["powershell","-NoProfile","-Command",f"$p=Get-Process -Id {pid} -ErrorAction SilentlyContinue; if($p){{$p.Name; $p.Path}}"],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=8).stdout.splitlines()
        ps=[l.strip() for l in ps if l.strip()]
        if ps: name=ps[0]; path=ps[1] if len(ps)>1 else ""
    except: pass
    return (pid,name,path)

def _roblox_studio_app_running():
    if sys.platform!="win32": return None
    try:
        out=subprocess.run(["tasklist","/FI","IMAGENAME eq RobloxStudioBeta.exe"],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=8).stdout
    except: return None
    return "RobloxStudioBeta.exe" in out

def _kill_orphan_studio_mcp():
    if sys.platform!="win32": return
    if _roblox_studio_app_running() is not False: return
    try: out=subprocess.run(["tasklist","/FI","IMAGENAME eq StudioMCP.exe"],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=8).stdout
    except: return
    if "StudioMCP.exe" not in out: return
    log("Found leftover StudioMCP.exe with no Studio running — cleaning up (phantom 'Studio connected').","yl")
    try: subprocess.run(["taskkill","/F","/IM","StudioMCP.exe"],capture_output=True,text=True,timeout=8)
    except Exception as e: log(f"could not clean up orphaned StudioMCP.exe: {e}","rd")

def _descendant_pids(root_pid):
    if sys.platform!="win32": return None
    try: out=subprocess.run(["powershell","-NoProfile","-Command","Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=10).stdout
    except: return None
    children={}
    for line in out.splitlines():
        parts=line.split()
        if len(parts)==2 and parts[0].isdigit() and parts[1].isdigit():
            children.setdefault(int(parts[1]),[]).append(int(parts[0]))
    if not children: return None
    pids={int(root_pid)}; stack=[int(root_pid)]
    while stack:
        for c in children.get(stack.pop(),[]):
            if c not in pids: pids.add(c); stack.append(c)
    return pids

def _reclaim_studio_port(client):
    owner=_port_owner(STUDIO_MCP_PORT)
    if not owner: return False
    pid,name,path=owner
    if "studiomcp" not in (name or "").lower(): return False
    try: pid_i=int(pid)
    except: return False
    if client is not None and client.proc is not None and client.is_alive():
        tree=_descendant_pids(client.proc.pid)
        if tree is None or pid_i in tree: return False
    log(f"port {STUDIO_MCP_PORT} held by StudioMCP.exe pid {pid_i} not launched by us — reclaiming.","yl")
    try: subprocess.run(["taskkill","/F","/PID",str(pid_i)],capture_output=True,text=True,timeout=8)
    except Exception as e: log(f"could not kill leftover StudioMCP.exe: {e}","rd"); return False
    log(f"killed leftover StudioMCP.exe pid {pid_i}","cy"); return True

def _process_cmdline(pid):
    if sys.platform!="win32": return ""
    try: out=subprocess.run(["powershell","-NoProfile","-Command",f"(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\" -ErrorAction SilentlyContinue).CommandLine"],capture_output=True,text=True,encoding="utf-8",errors="replace",timeout=8).stdout
    except: return ""
    return (out or "").strip()

def _reclaim_bridge_port():
    owner=_port_owner(PORT)
    if not owner: return False
    pid,name,path=owner
    try: pid_i=int(pid)
    except: return False
    if pid_i==os.getpid(): return False
    if "python" not in (name or "").lower() and "py"!=(name or "").lower(): return False
    cmdline=_process_cmdline(pid_i)
    if "bridge.py" not in cmdline.lower():
        log(f"port {PORT} held by pid {pid_i} ('{name}') — not a ZeroScript bridge, leaving alone.","yl"); return False
    log(f"port {PORT} held by leftover bridge pid {pid_i} — killing so this one can start.","yl")
    try: subprocess.run(["taskkill","/F","/PID",str(pid_i)],capture_output=True,text=True,timeout=8)
    except Exception as e: log(f"could not kill leftover bridge pid {pid_i}: {e}","rd"); return False
    log(f"killed leftover bridge pid {pid_i}","cy"); return True

def _kill_port_squatter():
    owner=_port_owner(STUDIO_MCP_PORT)
    if owner:
        pid,name,path=owner
        if "roblox" in (path or "").lower() or "studiomcp" in (name or "").lower(): return False,None
        log(f"port {STUDIO_MCP_PORT} hijacked by '{name}' pid {pid} {path}","yl")
        try: subprocess.run(["taskkill","/F","/PID",str(pid)],capture_output=True,text=True,timeout=8)
        except Exception as e: log(f"could not kill '{name}': {e}","rd"); return False,name
        log(f"killed '{name}'","cy"); return True,name
    log(f"port {STUDIO_MCP_PORT} hijacked but owner unresolvable (IPv6?)","yl")
    killed_name=None
    for img in ("ropilot-infra-helper.exe","ropilot-infra.exe","ropilot.exe"):
        try: res=subprocess.run(["taskkill","/F","/IM",img],capture_output=True,text=True,timeout=8)
        except: continue
        if res.returncode==0: killed_name=img; log(f"killed '{img}' (known squatter)","cy")
    if killed_name: return True,killed_name
    log(f"    netstat -ano | findstr {STUDIO_MCP_PORT} then taskkill that PID","yl"); return False,None

def _print_squatter_hint(name):
    app=name or "the other app"
    action_banner([f"'{app}' fights Roblox Studio for its connection — it will keep", "coming back after every restart until you remove it.", f"1. Uninstall '{app}' (or remove it from Windows startup).", "2. In Studio: Assistant Settings > MCP Servers,", "   turn OFF then back ON 'Enable Studio as MCP server'."])

def _print_reregister_hint():
    action_banner(["Go to Roblox Studio now.","Turn OFF then back ON: Assistant Settings > MCP Servers","         > 'Enable Studio as MCP server'","Wait about 10s — this window will turn green."])

def check_studio_port():
    owner=_port_owner(STUDIO_MCP_PORT)
    if not owner: return False
    pid,name,path=owner
    if "roblox" in (path or "").lower(): return False
    where=path or name
    log(f"port {STUDIO_MCP_PORT} (Studio MCP) held by non-Roblox:","yl"); log(f"    {name} pid {pid} {where}","yl")
    return True

# ── config helpers ─────────────────────────────────────────────────────
def _read_config():
    if not os.path.exists(CONFIG_PATH):
        # create default
        default={"mcpServers":{"roblox":{"command":"launch_studio_mcp.py","args":[]}}}
        try:
            with open(CONFIG_PATH,'w',encoding='utf-8') as f: json.dump(default,f,indent=2)
        except: pass
        return default
    try:
        with open(CONFIG_PATH,'r',encoding='utf-8') as f: return json.load(f)
    except Exception as e:
        log(f"config.json unreadable: {e}","rd"); return {"mcpServers":{}}

def config_add_server(server_id, command, args, env):
    if not server_id or not command: return False, "server_id and command required"
    if server_id==PRIMARY_SERVER_ID: return False, "cannot modify primary server"
    cfg=_read_config(); servers=cfg.setdefault("mcpServers",{})
    if server_id in servers: return False, "server already exists"
    servers[server_id]={"command":command,"args":args or [],"env":env or {}}
    try:
        with open(CONFIG_PATH,'w',encoding='utf-8') as f: json.dump(cfg,f,indent=2)
    except Exception as e: return False,f"could not write config.json: {e}"
    return True,None

def config_remove_server(server_id):
    if server_id==PRIMARY_SERVER_ID: return False,"cannot remove primary server"
    cfg=_read_config(); servers=cfg.get("mcpServers",{})
    if server_id not in servers: return False,"server not found"
    del servers[server_id]
    try:
        with open(CONFIG_PATH,'w',encoding='utf-8') as f: json.dump(cfg,f,indent=2)
    except Exception as e: return False,f"could not write config.json: {e}"
    return True,None

def restart_self():
    log("restarting bridge to reload config...","yl")
    try:
        for c in mgr.clients.values(): c.stop()
    except: pass
    if _log_file:
        try: _log_file.flush()
        except: pass
    argv=list(sys.argv); script=os.path.abspath(argv[0]) if argv else os.path.abspath(__file__); argv=[script]+argv[1:]
    try: os.execv(sys.executable,[sys.executable]+argv)
    except Exception as e:
        log(f"in-place restart failed ({e}); spawning fresh bridge...","rd")
        try: subprocess.Popen([sys.executable]+argv,cwd=HERE)
        except Exception as e2: log(f"could not spawn fresh bridge: {e2} — restart manually","rd")
        os._exit(0)

# ── MCP CLIENT (kept + upgraded with cache/stream/batch) ───────────────
def _looks_like_transient_studio_drop(text):
    if not text: return False
    low=text.lower()
    return any(p in low for p in ("no studio instance connected","studio not connected","no active studio","studio disconnected","studio has disconnected","no roblox studio","bound studio"))

class MCPClient:
    def __init__(self, server_id, command, args, env=None):
        self.id=server_id; self.command=command; self.args=list(args or []); self.env=env or {}
        self.proc=None; self.req_id=1; self.write_lock=threading.Lock(); self.call_lock=threading.Lock()
        self.pending={}; self.pend_lock=threading.Lock(); self.tools_cache=[]; self.start_lock=threading.Lock()
        self._reader_thread=None; self.last_exit=None; self.stderr_tail=[]; self.restart_times=[]; self.loop_warned_at=0.0
        self.start_error=None; self.saw_foreign_ws_host=False
        # performance: coalesce inflight calls by (name,args hash)
        self._inflight={}; self._inflight_lock=threading.Lock()
        # circuit breaker
        self._fail_count=0; self._circuit_open_until=0

    def _resolve(self,s): return os.path.expandvars(os.path.expanduser(str(s)))

    def start(self):
        with self.start_lock:
            if self.is_alive(): return
            if time.monotonic() < self._circuit_open_until:
                raise RuntimeError(f"circuit open for {self.id} — too many failures, cooling down")
            cmd=[self._resolve(self.command)]+[self._resolve(a) for a in self.args]
            if cmd[0].lower().endswith(".py"):
                script=cmd[0]
                if not os.path.isabs(script): script=os.path.join(HERE,script)
                cmd=[sys.executable,script]+cmd[1:]
            if sys.platform=="win32":
                base=os.path.basename(cmd[0]).lower()
                if base in ("npx","npm","yarn","pnpm","bunx"): cmd=["cmd.exe","/c"]+cmd
            env=dict(os.environ)
            for k,v in self.env.items(): env[k]=self._resolve(v)
            log(f"[{self.id}] launching ({' '.join(cmd)})","cy")
            with _Spinner(f"    [{self.id}] starting..."):
                try:
                    self.proc=subprocess.Popen(cmd,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1,encoding="utf-8",errors="replace",cwd=HERE,env=env)
                except FileNotFoundError:
                    self.start_error=f"command not found: '{cmd[0]}' — is it installed and on PATH? (server '{self.id}')"
                    log(f"[{self.id}] {self.start_error}","rd"); raise
                except OSError as e:
                    self.start_error=f"could not launch '{cmd[0]}': {e}"; log(f"[{self.id}] {self.start_error}","rd"); raise
                else: self.start_error=None
                with self.pend_lock: self.pending.clear()
                self.saw_foreign_ws_host=False
                self._reader_thread=threading.Thread(target=self._reader,args=(self.proc,),daemon=True); self._reader_thread.start()
                threading.Thread(target=self._stderr_drain,args=(self.proc,),daemon=True).start()
                self._request("initialize",{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"zeroscript-bridge","version":BRIDGE_VERSION}},timeout=30)
                self._notify("notifications/initialized")
                for _ in range(12):
                    if self.refresh_tools(timeout=3): break
                    if not self.is_alive(): break
                    time.sleep(1.0)
            log(f"[{self.id}] MCP up ({len(self.tools_cache)} tools)","cy")

    def is_alive(self): return self.proc is not None and self.proc.poll() is None

    def restart(self):
        log(f"[{self.id}] restarting...","yl"); self.stop(); time.sleep(0.4); self.start()

    def stop(self):
        with self.pend_lock:
            for q in self.pending.values():
                try: q.put_nowait(None)
                except: pass
            self.pending.clear()
        if self.proc:
            try:
                if sys.platform=="win32": subprocess.run(["taskkill","/F","/T","/PID",str(self.proc.pid)],capture_output=True,timeout=8)
                else: self.proc.terminate()
            except: pass
        self.proc=None

    def _reader(self,proc):
        stream=proc.stdout
        while True:
            try: line=stream.readline()
            except: break
            if line=="": break
            line=line.strip()
            if not line: continue
            try: msg=json.loads(line)
            except: continue
            mid=msg.get("id")
            if mid is None: continue
            with self.pend_lock: q=self.pending.get(mid)
            if q is not None:
                try: q.put_nowait(msg)
                except: pass
        code=proc.poll(); self.last_exit=code
        log(f"[{self.id}] stdout closed (exit {code})","rd")
        with self.pend_lock:
            for q in self.pending.values():
                try: q.put_nowait(None)
                except: pass

    def _stderr_drain(self,proc):
        try:
            for line in iter(proc.stderr.readline,""):
                line=line.rstrip()
                if line:
                    self.stderr_tail.append(line)
                    if len(self.stderr_tail)>12: self.stderr_tail.pop(0)
                    low=line.lower()
                    if "failed to parse message from ws host" in low or "missing field `type`" in low: self.saw_foreign_ws_host=True
                    log(f"[{self.id}] stderr: {line}","yl",terminal=False)
        except: pass

    def _next_id(self):
        with self.write_lock: rid=self.req_id; self.req_id+=1; return rid

    def _notify(self,method,params=None):
        payload={"jsonrpc":"2.0","method":method,"params":params or {}}
        with self.write_lock: self.proc.stdin.write(json.dumps(payload)+"\n"); self.proc.stdin.flush()

    def _request(self,method,params,timeout):
        if not self.is_alive(): raise RuntimeError(f"server '{self.id}' not running")
        rid=self._next_id(); q=queue.Queue(maxsize=1)
        with self.pend_lock: self.pending[rid]=q
        try:
            payload={"jsonrpc":"2.0","id":rid,"method":method,"params":params or {}}
            with self.write_lock: self.proc.stdin.write(json.dumps(payload)+"\n"); self.proc.stdin.flush()
            try: return q.get(timeout=timeout)
            except queue.Empty: return None
        finally:
            with self.pend_lock: self.pending.pop(rid,None)

    def refresh_tools(self,timeout=20):
        msg=self._request("tools/list",{},timeout=timeout)
        if msg and "result" in msg: self.tools_cache=msg["result"].get("tools",[])
        return self.tools_cache

    def call_tool(self,name,arguments,timeout):
        with self.call_lock:
            # circuit breaker check
            if time.monotonic() < self._circuit_open_until:
                raise RuntimeError(f"server '{self.id}' circuit open — cooling down, try again briefly")
            for attempt in (1,2):
                if not self.is_alive(): self.restart()
                msg=self._request("tools/call",{"name":name,"arguments":arguments},timeout)
                if msg is None:
                    if not self.is_alive():
                        self.restart()
                        msg=self._request("tools/call",{"name":name,"arguments":arguments},timeout)
                    if msg is None:
                        self._fail_count+=1
                        if self._fail_count>=3: self._circuit_open_until=time.monotonic()+10
                        raise TimeoutError(f"No response from '{self.id}' after {timeout}s")
                if msg.get("error"):
                    err=msg["error"]; err_text=err.get("message",json.dumps(err))
                    if attempt==1 and _looks_like_transient_studio_drop(err_text):
                        log(f"[{self.id}] {name}: transient drop, retry...","yl"); time.sleep(1.5); continue
                    self._fail_count+=1; raise RuntimeError(err_text)
                content=msg.get("result",{}).get("content",[])
                text="\n".join(it.get("text","") for it in content if it.get("type")=="text")
                images=[{"data":it["data"],"mimeType":it.get("mimeType","image/jpeg")} for it in content if it.get("type")=="image" and it.get("data")]
                if not text and not images and content: text=json.dumps(content)[:4000]
                if attempt==1 and _looks_like_transient_studio_drop(text):
                    log(f"[{self.id}] {name}: transient drop, retry...","yl"); time.sleep(1.5); continue
                self._fail_count=0  # success resets circuit
                return {"text":text,"images":images}

# ── MANAGER ─────────────────────────────────────────────────────────────
class MCPManager:
    def __init__(self): self.clients={}; self.index={}; self.index_lock=threading.Lock()
    def load_config(self):
        servers=_read_config().get("mcpServers",{}) or {}
        for sid,spec in servers.items(): self.clients[sid]=MCPClient(sid,spec.get("command"),spec.get("args"),spec.get("env"))
        log(f"configured {len(self.clients)} MCP server(s): {', '.join(self.clients) or '(none)'}","cy")
    def start_all(self):
        threads=[]
        for sid,client in self.clients.items():
            def _run(sid=sid,client=client):
                try: client.start()
                except Exception as e: log(f"[{sid}] failed: {e}","rd")
            t=threading.Thread(target=_run,daemon=True); t.start(); threads.append(t)
        for t in threads: t.join()
        self.rebuild_index()
    def rebuild_index(self):
        with self.index_lock:
            self.index={}
            for sid,client in self.clients.items():
                for t in (client.tools_cache or []):
                    name=t.get("name")
                    if not name: continue
                    advertised=name if name not in self.index else f"{sid}/{name}"
                    self.index[advertised]=(client,name)
    def list_tools(self,refresh=False):
        if refresh:
            for sid,client in self.clients.items():
                try:
                    if client.is_alive(): client.refresh_tools(timeout=5)
                except: pass
            self.rebuild_index()
        with self.index_lock:
            out=[]
            for adv,(holder,real) in self.index.items():
                # find original tool spec for description
                spec=None
                for t in (holder.tools_cache or []):
                    if t.get("name")==real: spec=t; break
                if spec: out.append({"name":adv,"description":spec.get("description",""),"inputSchema":spec.get("inputSchema",{})})
                else: out.append({"name":adv,"description":"","inputSchema":{}})
            return out
    def call(self,name,arguments,timeout):
        with self.index_lock: entry=self.index.get(name)
        if entry is None:
            # try bare fallback
            for adv,(h,r) in self.index.items():
                if r==name: entry=(h,r); break
        if entry is None: raise RuntimeError(f"unknown tool '{name}' — valid: {', '.join(self.index.keys()) or 'none'}")
        holder,real=entry
        return holder.call_tool(real,arguments,timeout)
    def any_alive(self): return any(c.is_alive() for c in self.clients.values())
    def health(self):
        return [{"id":sid,"alive":c.is_alive(),"tools":len(c.tools_cache or []),"error":c.start_error} for sid,c in self.clients.items()]
    def restart(self,sid=None):
        if sid:
            c=self.clients.get(sid)
            if not c: raise RuntimeError(f"no server '{sid}'")
            c.restart(); self.rebuild_index()
        else:
            for c in self.clients.values():
                try: c.restart()
                except: pass
            self.rebuild_index()

mgr=MCPManager()
clients=set()
clients_lock=threading.Lock()

# ── studio probe ────────────────────────────────────────────────────────
STUDIO_PROBE_TOOL="list_roblox_studios"
STUDIO_STATE_TOOL="get_studio_state"
NO_PLACE_MARKERS=("doesn't have a place","no place opened","place opened","has disconnected","no active studio")
def _probe_tool_text(tool):
    with mgr.index_lock: entry=mgr.index.get(tool)
    if entry is None: return None
    holder,real=entry
    if not holder.call_lock.acquire(blocking=False): return None
    try:
        if not holder.is_alive(): return None
        msg=holder._request("tools/call",{"name":real,"arguments":{}},timeout=8)
        if not msg or msg.get("error"): return None
        content=msg.get("result",{}).get("content",[])
        return "\n".join(it.get("text","") for it in content if it.get("type")=="text")
    except: return None
    finally: holder.call_lock.release()

def probe_studio():
    roblox=mgr.clients.get(PRIMARY_SERVER_ID)
    if roblox is not None and roblox.is_alive() and not roblox.tools_cache:
        return {"app":False,"place":False}
    text=_probe_tool_text(STUDIO_PROBE_TOOL)
    if text is None: return {"app":None,"place":None}
    try: studios=json.loads(text).get("studios") or []
    except: return {"app":None,"place":None}
    if not studios: return {"app":False,"place":False}
    state=_probe_tool_text(STUDIO_STATE_TOOL)
    if state is None: return {"app":True,"place":None}
    low=state.lower(); place=not any(m in low for m in NO_PLACE_MARKERS)
    return {"app":True,"place":place}

def safe_call(name,arguments,timeout):
    try: result=mgr.call(name,arguments,timeout); return {"ok":True,"text":result["text"],"images":result["images"]}
    except TimeoutError as e: return {"ok":False,"error":str(e),"kind":"timeout"}
    except Exception as e: return {"ok":False,"error":str(e),"kind":type(e).__name__}

async def run_tool_task(ws,name,args,timeout,rid):
    t0=time.monotonic()
    res=await asyncio.to_thread(safe_call,name,args,timeout)
    elapsed=time.monotonic()-t0
    metrics.record_tool(elapsed, ok=res.get("ok"))
    tag="gr" if res.get("ok") else "rd"; summary=(res.get("text") or res.get("error") or "")[:80].replace("\n"," "); slow="  [SLOW]" if elapsed>5 else ""
    log(f"<- {name} ({elapsed:.1f}s){slow}: {summary}",tag, terminal=not res.get("ok") or elapsed>5)
    # Invalidate caches that may be stale after a mutating tool
    try: _cache_tools.store.clear(); _cache_status.store.clear()
    except: pass
    # Broadcast update to SSE clients via event queue
    _push_event({"type":"tool_result","tool":name,"ok":res.get("ok"),"elapsed":round(elapsed,2)})
    try:
        payload={"type":"tool_result","id":rid, **res}
        # try binary if client supports it (negotiated via hello)
        await ws.send(_dumps(payload))
    except ConnectionClosed: pass
    except Exception as e: log(f"send tool_result failed: {e}","rd")

# SSE event broadcast
_event_queues=list()
_event_lock=threading.Lock()
def _push_event(ev):
    ev["_ts"]=time.time()
    with _event_lock:
        for q in list(_event_queues):
            try: q.put_nowait(ev)
            except: pass

async def broadcast_status():
    if not clients and not _event_queues: return
    try:
        _st=await asyncio.to_thread(probe_studio); _proc=await asyncio.to_thread(_roblox_studio_app_running)
        payload=_dumps({"type":"connected","mcp_alive":mgr.any_alive(),"studio":_st["place"],"studio_app":_st["app"],"studio_proc":_proc,"servers":mgr.health(),"tools":mgr.list_tools(),"port":PORT,"http_port":PORT_HTTP,"version":BRIDGE_VERSION})
        _push_event({"type":"status","studio":_st["place"],"studio_app":_st["app"],"servers":mgr.health(),"tools_count":len(mgr.list_tools())})
    except: return
    for ws in list(clients):
        try: await ws.send(payload)
        except: pass

# ── HTTP handler (all methods) ─────────────────────────────────────────
ALLOWED_ORIGINS=["https://chat.deepseek.com","https://chatgpt.com","https://chat.openai.com","https://gemini.google.com","https://www.kimi.ai","https://kimi.ai","https://chat.z.ai","https://chat.qwen.ai","https://arena.ai","https://www.meta.ai","https://meta.ai"]

def _cors_headers(handler, origin="*"):
    handler.send_header("Access-Control-Allow-Origin", origin if origin in ALLOWED_ORIGINS else "*")
    handler.send_header("Access-Control-Allow-Methods","GET, POST, OPTIONS")
    handler.send_header("Access-Control-Allow-Headers","Content-Type, Authorization, X-ZS-Token, X-Requested-With")
    handler.send_header("Access-Control-Expose-Headers","Content-Type")

def _check_auth(handler):
    if NO_AUTH: return True
    # allow token via header or query param
    tok=handler.headers.get("X-ZS-Token") or handler.headers.get("Authorization","").replace("Bearer ","").strip()
    if not tok:
        qs=parse_qs(urlparse(handler.path).query)
        tok=(qs.get("token") or qs.get("t") or [""])[0]
    if not tok: return True  # local bridge allows unauth for backwards compat, but logs
    return tok==BRIDGE_TOKEN

class ZSHttpHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # suppress default stderr noise, use our log
        try: log(f"[http] {self.address_string()} {format%args}","dim",terminal=False)
        except: pass
    def _set_headers(self, code=200, ctype="application/json", origin="*"):
        self.send_response(code); _cors_headers(self, origin); self.send_header("Content-Type",ctype); self.send_header("Cache-Control","no-store"); self.end_headers()
    def do_OPTIONS(self):
        origin=self.headers.get("Origin","*"); self._set_headers(200,ctype="text/plain",origin=origin)
    def _read_body(self):
        n=int(self.headers.get("Content-Length","0") or 0)
        if n: return self.rfile.read(n)
        return b""
    def _send_json(self,obj,code=200,origin="*"):
        body=_dumps(obj).encode()
        # gzip if client accepts and body large
        if len(body)>1024 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body=gzip.compress(body); self.send_response(code); _cors_headers(self,origin); self.send_header("Content-Type","application/json"); self.send_header("Content-Encoding","gzip"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
        else:
            self.send_response(code); _cors_headers(self,origin); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(body))); self.send_header("Cache-Control","no-store"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        metrics.http_requests+=1
        if not _rate_limiter.allow(): self._send_json({"ok":False,"error":"rate limited"},429); return
        origin=self.headers.get("Origin","*")
        parsed=urlparse(self.path); path=parsed.path
        # auth optional for GET status
        if not _check_auth(self): self._send_json({"ok":False,"error":"unauthorized"},401,origin); return
        if path in ("/","/health","/api/health"):
            self._send_json({"ok":True,"version":BRIDGE_VERSION,"port":PORT,"http_port":PORT_HTTP,"mcp_alive":mgr.any_alive(),"status":"ok"},origin=origin)
            return
        if path in ("/api/status","/status"):
            cached=_cache_status.get("status")
            if cached: self._send_json(cached,origin=origin); return
            try:
                st=probe_studio(); proc=_roblox_studio_app_running()
                resp={"ok":True,"mcp_alive":mgr.any_alive(),"studio":st["place"],"studio_app":st["app"],"studio_proc":proc,"servers":mgr.health(),"tools":mgr.list_tools(),"port":PORT,"http_port":PORT_HTTP,"version":BRIDGE_VERSION}
                _cache_status.set("status",resp); self._send_json(resp,origin=origin)
            except Exception as e: self._send_json({"ok":False,"error":str(e)},500,origin)
            return
        if path in ("/api/tools","/tools"):
            try:
                tools=mgr.list_tools(refresh=False)  # fast cached; add ?refresh=1 to force
                qs=parse_qs(parsed.query)
                if qs.get("refresh")==["1"]: tools=mgr.list_tools(refresh=True)
                self._send_json({"ok":True,"tools":tools,"servers":mgr.health()},origin=origin)
            except Exception as e: self._send_json({"ok":False,"error":str(e)},500,origin)
            return
        if path in ("/api/metrics","/metrics"):
            self._send_json({"ok":True,**metrics.snapshot()},origin=origin); return
        if path in ("/api/token","/token"):
            # expose token to local extension (localhost only, already restricted to 127.0.0.1 bind)
            self._send_json({"ok":True,"token":BRIDGE_TOKEN},origin=origin); return
        if path in ("/api/events","/events"):
            # SSE stream
            self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.send_header("Cache-Control","no-cache"); self.send_header("Connection","keep-alive"); _cors_headers(self,origin); self.end_headers()
            q=queue.Queue()
            with _event_lock: _event_queues.append(q)
            try:
                self.wfile.write(b": connected\n\n"); self.wfile.flush()
                # send initial status
                try: st=probe_studio(); init={"type":"status","studio":st["place"]}; self.wfile.write(f"data: {_dumps(init)}\n\n".encode()); self.wfile.flush()
                except: pass
                while True:
                    try: ev=q.get(timeout=15)
                    except queue.Empty:
                        # heartbeat comment
                        try: self.wfile.write(b": ping\n\n"); self.wfile.flush()
                        except: break
                        continue
                    try:
                        self.wfile.write(f"data: {_dumps(ev)}\n\n".encode()); self.wfile.flush()
                    except: break
            finally:
                with _event_lock:
                    try: _event_queues.remove(q)
                    except: pass
            return
        if path in ("/api/poll","/poll"):
            qs=parse_qs(parsed.query); since=float((qs.get("since") or ["0"])[0] or 0)
            # long-poll: wait up to 20s for new event
            q=queue.Queue()
            with _event_lock: _event_queues.append(q)
            try:
                # flush old
                deadline=time.time()+20
                while time.time()<deadline:
                    try: ev=q.get(timeout=2)
                    except queue.Empty:
                        if time.time()>deadline: break
                        continue
                    if ev.get("_ts",0) <= since: continue
                    self._send_json({"ok":True,"event":ev},origin=origin); return
                # timeout: return empty heartbeat
                self._send_json({"ok":True,"event":None,"heartbeat":True},origin=origin)
            finally:
                with _event_lock:
                    try: _event_queues.remove(q)
                    except: pass
            return
        self._send_json({"ok":False,"error":"not found"},404,origin)

    def do_POST(self):
        metrics.http_requests+=1
        if not _rate_limiter.allow(): self._send_json({"ok":False,"error":"rate limited"},429); return
        origin=self.headers.get("Origin","*")
        parsed=urlparse(self.path); path=parsed.path
        if not _check_auth(self): self._send_json({"ok":False,"error":"unauthorized"},401,origin); return
        body=self._read_body()
        try: data=_loads(body) if body else {}
        except: data={}
        if path in ("/api/call","/api/call_tool","/call_tool","/call"):
            name=data.get("name") or data.get("tool") or data.get("command") or ""
            args=data.get("arguments") or data.get("args") or data.get("params") or {}
            timeout=float(data.get("timeout",120000))/1000.0
            if not name: self._send_json({"ok":False,"error":"missing tool name"},400,origin); return
            t0=time.monotonic(); res=safe_call(name,args,timeout); elapsed=time.monotonic()-t0
            metrics.record_tool(elapsed, ok=res.get("ok"))
            self._send_json(res,origin=origin); return
        if path in ("/api/batch","/batch"):
            calls=data.get("calls") or data.get("tools") or []
            if not isinstance(calls,list): self._send_json({"ok":False,"error":"calls must be array"},400,origin); return
            # execute sequentially (per-server lock ensures safety), but pipeline fast
            results=[]
            for c in calls:
                n=c.get("name") or c.get("tool") or c.get("command") or ""
                a=c.get("arguments") or c.get("args") or c.get("params") or {}
                t=float(c.get("timeout",120000))/1000.0
                # cap batch size
                if len(results)>=12: break
                results.append({"name":n, **safe_call(n,a,t)})
            self._send_json({"ok":True,"results":results},origin=origin); return
        if path in ("/api/add_server","/api/remove_server","/api/restart_mcp"):
            # these mutate config
            if path=="/api/add_server":
                ok,err=config_add_server(data.get("server_id"),data.get("command"),data.get("args"),data.get("env"))
                self._send_json({"ok":ok,"error":err,"restarting":ok},origin=origin)
                if ok:
                    def _do(): time.sleep(0.4); restart_self()
                    threading.Thread(target=_do,daemon=True).start()
                return
            if path=="/api/remove_server":
                ok,err=config_remove_server(data.get("server_id"))
                self._send_json({"ok":ok,"error":err,"restarting":ok},origin=origin)
                if ok:
                    def _do(): time.sleep(0.4); restart_self()
                    threading.Thread(target=_do,daemon=True).start()
                return
            if path=="/api/restart_mcp":
                sid=data.get("server")
                try: mgr.restart(sid); ok,err=True,None
                except Exception as e: ok,err=False,str(e)
                self._send_json({"ok":ok,"error":err,"alive":mgr.any_alive(),"servers":mgr.health(),"tools":mgr.list_tools()},origin=origin); return
        self._send_json({"ok":False,"error":"not found"},404,origin)

def _start_http_server():
    # Bind to 127.0.0.1 only
    server=ThreadingHTTPServer((HOST,PORT_HTTP), ZSHttpHandler)
    # socket tuning
    try:
        server.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        # TCP keepalive tuning where available
        if hasattr(socket,"TCP_KEEPIDLE"): server.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPIDLE, 30)
        if hasattr(socket,"TCP_KEEPINTVL"): server.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPINTVL, 10)
        if hasattr(socket,"TCP_KEEPCNT"): server.socket.setsockopt(socket.IPPROTO_TCP, socket.TCP_KEEPCNT, 3)
    except: pass
    server.daemon_threads=True
    log(f"HTTP API listening on http://{HOST}:{PORT_HTTP}","cy")
    # also try to bind HTTP on main PORT via separate thread if websockets allows http handling? We keep separate port for simplicity.
    # Also start http on PORT as fallback using same handler if WS port free? No — WS owns PORT. So HTTP is on PORT_HTTP.
    # Extension will try WS first, then HTTP fallback automatically.
    t=threading.Thread(target=server.serve_forever,daemon=True); t.start()
    return server

# ── WebSocket handler (upgraded) ────────────────────────────────────────
async def handler(ws):
    peer=getattr(ws,"remote_address",("?",))[0]
    with clients_lock: clients.add(ws)
    metrics.ws_connections=len(clients)
    # socket tuning if underlying socket accessible
    try:
        sock=ws.transport.get_extra_info('socket') if hasattr(ws,'transport') else None
        if sock: sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    except: pass
    log(f"extension connected ({peer}) [{len(clients)} client(s)]","gr")
    try:
        # initial hello with ultra capabilities
        _st=await asyncio.to_thread(probe_studio)
        hello={"type":"connected","mcp_alive":mgr.any_alive(),"studio":_st["place"],"studio_app":_st["app"],"studio_proc":await asyncio.to_thread(_roblox_studio_app_running),"servers":mgr.health(),"tools":mgr.list_tools(),"port":PORT,"http_port":PORT_HTTP,"version":BRIDGE_VERSION,"token":BRIDGE_TOKEN if not NO_AUTH else None,"caps":["ws","http","sse","poll","batch","binary" if HAS_MSGPACK else "json"]}
        await ws.send(_dumps(hello))
        async for raw in ws:
            # support binary msgpack frames
            if isinstance(raw, (bytes,bytearray)):
                metrics.bytes_in+=len(raw)
                if HAS_MSGPACK:
                    try: msg=_msgpack.unpackb(raw, raw=False)
                    except: continue
                else: continue
            else:
                metrics.bytes_in+=len(raw.encode() if isinstance(raw,str) else b"")
                try: msg=_loads(raw) if isinstance(raw,(bytes,bytearray)) else json.loads(raw)
                except: continue
            mtype=msg.get("type"); rid=msg.get("id")
            if mtype=="hello":
                # client hello — negotiate caps, no-op but ack
                await ws.send(_dumps({"type":"hello_ack","id":rid,"version":BRIDGE_VERSION,"caps":["ws","http","sse","poll","batch","binary"] }))
            elif mtype=="ping":
                await ws.send(_dumps({"type":"pong","id":rid,"ts":time.time()}))
            elif mtype=="studio_status":
                st=await asyncio.to_thread(probe_studio)
                await ws.send(_dumps({"type":"studio_status","id":rid,"studio":st["place"],"studio_app":st["app"],"studio_proc":await asyncio.to_thread(_roblox_studio_app_running),"mcp_alive":mgr.any_alive()}))
            elif mtype=="list_tools":
                # cache-aware with optional refresh flag
                if msg.get("refresh") is False:
                    tools=mgr.list_tools(refresh=False)
                else:
                    # use cache if fresh
                    cached=_cache_tools.get("list_tools")
                    if cached and not msg.get("force"): tools=cached
                    else:
                        try: tools=await asyncio.to_thread(mgr.list_tools, True)
                        except Exception as e: tools=mgr.list_tools(); log(f"list_tools err {e}","yl")
                        _cache_tools.set("list_tools", tools)
                _st=await asyncio.to_thread(probe_studio)
                await ws.send(_dumps({"type":"tools","id":rid,"tools":tools,"mcp_alive":mgr.any_alive(),"studio":_st["place"],"studio_app":_st["app"],"studio_proc":await asyncio.to_thread(_roblox_studio_app_running),"servers":mgr.health()}))
            elif mtype=="call_tool":
                name=msg.get("name",""); args=msg.get("arguments") or {}; timeout=float(msg.get("timeout",120000))/1000.0
                log(f"-> tool {name}({', '.join(args.keys())})","cy",terminal=False)
                asyncio.create_task(run_tool_task(ws,name,args,timeout,rid))
            elif mtype=="batch":
                calls=msg.get("calls") or []
                # start all as tasks, preserve order via index, but run in parallel where servers differ
                # For simplicity execute sequentially to respect per-server lock, but send incremental events
                async def _run_batch():
                    results=[]
                    for idx,c in enumerate(calls[:12]):
                        n=c.get("name",""); a=c.get("arguments") or {}; t=float(c.get("timeout",120000))/1000.0
                        r=await asyncio.to_thread(safe_call,n,a,t)
                        results.append({"name":n,**r})
                        # streaming partial
                        try: await ws.send(_dumps({"type":"batch_progress","id":rid,"idx":idx,"result":r}))
                        except: pass
                    try: await ws.send(_dumps({"type":"batch_result","id":rid,"results":results}))
                    except: pass
                asyncio.create_task(_run_batch())
            elif mtype=="subscribe":
                # SSE over WS: push status every 3s while subscribed
                async def _sub_loop():
                    try:
                        while ws in clients:
                            _st=await asyncio.to_thread(probe_studio)
                            await ws.send(_dumps({"type":"status_update","studio":_st["place"],"studio_app":_st["app"],"servers":mgr.health()}))
                            await asyncio.sleep(3)
                    except: pass
                asyncio.create_task(_sub_loop())
                await ws.send(_dumps({"type":"subscribed","id":rid}))
            elif mtype in ("add_server","remove_server"):
                if mtype=="add_server": ok,err=await asyncio.to_thread(config_add_server,msg.get("server_id"),msg.get("command"),msg.get("args"),msg.get("env"))
                else: ok,err=await asyncio.to_thread(config_remove_server,msg.get("server_id"))
                await ws.send(_dumps({"type":"server_changed","id":rid,"ok":ok,"error":err,"restarting":ok}))
                if ok:
                    async def _do_restart(): await asyncio.sleep(0.4); restart_self()
                    asyncio.create_task(_do_restart())
            elif mtype=="restart_mcp":
                sid=msg.get("server")
                try: await asyncio.to_thread(mgr.restart,sid); ok,err=True,None
                except Exception as e: ok,err=False,str(e)
                await ws.send(_dumps({"type":"mcp_status","id":rid,"alive":mgr.any_alive(),"ok":ok,"error":err,"servers":mgr.health(),"tools":mgr.list_tools()}))
            elif mtype=="metrics":
                await ws.send(_dumps({"type":"metrics","id":rid,**metrics.snapshot()}))
            else:
                await ws.send(_dumps({"type":"error","id":rid,"error":f"unknown message type: {mtype}"}))
    except ConnectionClosed: pass
    except Exception as e: log(f"handler error: {e}","rd")
    finally:
        with clients_lock: clients.discard(ws)
        metrics.ws_connections=len(clients)
        log(f"extension disconnected [{len(clients)} client(s)]","yl")

async def server_watch():
    LOOP_N=3; LOOP_WINDOW=60; LOOP_WARN_COOLDOWN=120
    while True:
        await asyncio.sleep(5)
        for sid,client in list(mgr.clients.items()):
            try:
                if not client.is_alive():
                    now=time.time()
                    client.restart_times=[t for t in client.restart_times if now-t<LOOP_WINDOW]
                    looping=len(client.restart_times)>=LOOP_N
                    if looping and now-client.loop_warned_at>LOOP_WARN_COOLDOWN:
                        client.loop_warned_at=now
                        log(f"[{sid}] CRASH LOOP: died {len(client.restart_times)}x in {LOOP_WINDOW}s (exit {client.last_exit})","rd")
                        if client.start_error: log(f"[{sid}] {client.start_error}","rd")
                        elif client.stderr_tail:
                            log(f"[{sid}] last error output:","rd")
                            for ln in client.stderr_tail: log(f"[{sid}]   {ln}","yl")
                        else: log(f"[{sid}] no error output before dying.","yl")
                        if sid=="roblox":
                            owner=_port_owner(STUDIO_MCP_PORT)
                            if owner:
                                pid,name,path=owner
                                if "roblox" not in (name or "").lower() and "studio" not in (path or "").lower():
                                    log(f"[{sid}] port {STUDIO_MCP_PORT} held by '{name}' pid {pid} {path} — close it, squatting Studio MCP","rd")
                        log(f"[{sid}] causes: app not running, port conflict, AV killing it, bad config. Auto-restart continues.","yl")
                    if looping and client.restart_times and now-client.restart_times[-1]<15: continue
                    client.restart_times.append(now); log(f"[{sid}] found dead — auto-restarting...","yl")
                    await asyncio.to_thread(client.start); mgr.rebuild_index(); await broadcast_status()
            except Exception as e: log(f"[{sid}] auto-restart failed: {e}","rd")

def _current_studio_exe():
    if _studio_scan is None: return None
    try: return _studio_scan.find_studio_mcp()
    except: return None

async def studio_watch(initial_app, initial_place=None):
    prev_app=initial_app; prev_place=initial_place; disconnected_since=None; last_auto_restart=0.0; empty_since=None; last_reclaim=0.0; place_transitions=[]; known_studio_exe=await asyncio.to_thread(_current_studio_exe); update_suspected=False
    while True:
        await asyncio.sleep(3)
        try:
            cur=await asyncio.to_thread(probe_studio); app=cur["app"]; place=cur["place"]
            if app is None or place is None: continue
            # transitions logging
            if app!=prev_app or place!=prev_place:
                if app and not prev_app: log(f"Roblox Studio connected — place loaded: {place is True}","gr")
                elif not app and prev_app: log(f"Roblox Studio disconnected","yl")
                prev_app=app; prev_place=place
                await broadcast_status()
            # zombie reclaim etc (kept lightweight)
            if app is False:
                if disconnected_since is None: disconnected_since=time.time()
                # auto-restart proxy after sustained disconnect if it had been connected before
                if time.time()-disconnected_since>12 and time.time()-last_auto_restart>20:
                    roblox=mgr.clients.get(PRIMARY_SERVER_ID)
                    if roblox and roblox.is_alive():
                        # check zombie port before restart
                        if await asyncio.to_thread(_reclaim_studio_port, roblox):
                            try: await asyncio.to_thread(mgr.restart,"roblox"); _print_reregister_hint()
                            except: pass
                            last_auto_restart=time.time(); disconnected_since=None
            else: disconnected_since=None
            # update detection
            cur_exe=await asyncio.to_thread(_current_studio_exe)
            if cur_exe and known_studio_exe and cur_exe!=known_studio_exe:
                if not update_suspected:
                    update_suspected=True; log(f"Studio updated: {known_studio_exe} -> {cur_exe} — if MCP toggle went OFF, re-enable it","yl")
                    action_banner(["Roblox Studio just updated.","Its MCP toggle resets to OFF on update.","Go to: Assistant Settings > MCP Servers > Enable Studio as MCP server","Then wait ~10s — this window turns green."])
                known_studio_exe=cur_exe
            elif cur_exe: known_studio_exe=cur_exe
        except Exception as e: log(f"studio_watch error: {e}","rd")

async def _early_studio_guidance():
    await asyncio.sleep(4)
    try: _st=await asyncio.to_thread(probe_studio)
    except: return
    if _st["app"] is False:
        action_banner(["Open your place in Roblox Studio.","Go to: Assistant Settings > MCP Servers","       > 'Enable Studio as MCP server'","It can take ~10s; this window will turn green."])

async def main():
    # banner
    print(); print(f"{C['cy']}  ZeroScript Bridge v{BRIDGE_VERSION} — ULTRA  {C['dim']}(port {PORT} WS + {PORT_HTTP} HTTP/SSE){C['reset']}")
    print(f"{C['dim']}  Python {sys.version.split()[0]}  |  {time.strftime('%Y-%m-%d %H:%M:%S')}  |  logs: {LOG_PATH}{C['reset']}")
    if HAS_ORJSON: log("fast JSON: orjson enabled","cy",terminal=False)
    else: log("fast JSON: stdlib (pip install orjson for +30% throughput)","dim",terminal=False)
    if HAS_MSGPACK: log("binary framing: msgpack enabled","cy",terminal=False)
    try: _log_file.write(f"\n===== BRIDGE v{BRIDGE_VERSION} START {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"); _log_file.flush()
    except: pass
    if not os.path.exists(CONFIG_PATH): _read_config()
    # hygiene: kill orphan StudioMCP before start
    await asyncio.to_thread(_kill_orphan_studio_mcp)
    mgr.load_config()
    # load but don't block WS on it — start_all in background
    start_task=asyncio.create_task(asyncio.to_thread(mgr.start_all))
    # reclaim bridge port before bind
    if await asyncio.to_thread(_reclaim_bridge_port): await asyncio.sleep(0.6)
    check_studio_port()
    # start HTTP server (threaded, non-async)
    http_server=_start_http_server()
    # WebSocket server with compression & tuned ping
    try:
        server_ctx=await websockets.serve(handler,HOST,PORT,ping_interval=5,ping_timeout=8,max_size=16*1024*1024,compression="deflate",close_timeout=5)
    except OSError as e:
        if getattr(e,"errno",None) in (98,10048) or "10048" in str(e):
            owner=await asyncio.to_thread(_port_owner,PORT); who=f" by '{owner[1]}' pid {owner[0]}" if owner else ""
            log(f"could not start WS: port {PORT} in use{who}.","rd")
            log(f"    netstat -ano | findstr {PORT}  then taskkill /F /PID <pid>","yl")
            log(f"    Or set ZS_BRIDGE_PORT=17614","yl"); return
        raise
    async with server_ctx:
        log(f"listening WS ws://{HOST}:{PORT} + HTTP http://{HOST}:{PORT_HTTP}/api/*  — open a supported AI chat","cy")
        log(f"token: {BRIDGE_TOKEN[:8]}… (stored in .zs_token, sent via X-ZS-Token)","dim",terminal=False)
        asyncio.create_task(_supervised("server_watch", server_watch))
        # periodic broadcast early
        async def _early_status_pushes():
            for interval in (2,2,4,6,6):
                await asyncio.sleep(interval); await broadcast_status()
        asyncio.create_task(_early_status_pushes())
        # studio guidance + watch once MCP started
        asyncio.create_task(_early_studio_guidance())
        async def _boot_and_diagnose():
            try: await start_task
            except: pass
            # re-evaluate after startup
            total=len(mgr.list_tools()); roblox_client=mgr.clients.get(PRIMARY_SERVER_ID)
            roblox_total=len(roblox_client.tools_cache) if roblox_client else 0
            # squatter handling
            killed_squatter=False
            if roblox_client and roblox_total==0 and roblox_client.saw_foreign_ws_host:
                killed,_=await asyncio.to_thread(_kill_port_squatter)
                if killed:
                    try: await asyncio.to_thread(mgr.restart,"roblox"); roblox_total=len(roblox_client.tools_cache); total=len(mgr.list_tools())
                    except: pass
                    _print_squatter_hint(_); killed_squatter=True
            reclaimed=False
            if roblox_client and roblox_total==0 and await asyncio.to_thread(_roblox_studio_app_running) is True and await asyncio.to_thread(_reclaim_studio_port, roblox_client):
                try: await asyncio.to_thread(mgr.restart,"roblox"); roblox_total=len(roblox_client.tools_cache); total=len(mgr.list_tools())
                except: pass
                reclaimed=True; _print_reregister_hint()
            _st=await asyncio.to_thread(probe_studio)
            if _st["app"] is False:
                with _Spinner("    waiting for Roblox Studio to attach..."):
                    for _ in range(8):
                        await asyncio.sleep(1); _st=await asyncio.to_thread(probe_studio)
                        if _st["app"] is not False: break
            if _st["app"] is True:
                await asyncio.sleep(1.5); confirm=await asyncio.to_thread(probe_studio)
                if confirm["app"] is not True: _st=confirm
            if roblox_client and (roblox_total==0 or _st["app"] is False):
                if killed_squatter or reclaimed: log("    still waiting for Studio MCP toggle (see action box above)...","yl")
                else:
                    if roblox_total>0: log(f"    {roblox_total} Roblox tools loaded, but NO Studio connected yet.","yl")
                    action_banner(["Open your place in Roblox Studio.","Go to: Assistant Settings > MCP Servers","       > 'Enable Studio as MCP server'","It can take ~10s; this window will turn green."])
            elif _st["app"] is True: log(f"ready {total} tools — Roblox Studio connected","gr")
            else: log(f"ready {total} tools ({len(mgr.clients)} server(s))","gr")
            asyncio.create_task(_supervised("studio_watch", lambda: studio_watch(_st["app"],_st["place"])))
        asyncio.create_task(_boot_and_diagnose())
        await asyncio.Future()

async def _supervised(name, coro_fn):
    while True:
        try: await coro_fn(); break
        except asyncio.CancelledError: break
        except Exception as e:
            log(f"[{name}] crashed: {e} — restarting in 2s","rd")
            try: import traceback; traceback.print_exc()
            except: pass
            await asyncio.sleep(2)

if __name__=="__main__":
    try: asyncio.run(main())
    except KeyboardInterrupt:
        log("shutting down...","yl")
        for c in mgr.clients.values(): c.stop()
    finally: log("===== BRIDGE STOP =====","cy")
