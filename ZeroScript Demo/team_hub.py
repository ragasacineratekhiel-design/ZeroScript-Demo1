"""Bounded, in-memory agent mailboxes. No model calls and no invented AI replies.

All callers must be authenticated by bridge.py. A member represents one chat tab,
not a model API connection. Delivery means the extension acknowledged submission;
it does not prove that the model read or understood the message.

4.6.0 upgrades (brutal-honest, speed + features):
- Hard role permissions: only the coder may mutate Studio. Planner/checker
  mutation attempts are rejected with a redirect (send a plan / defect list via
  team_send instead). Enforced here so the bridge can reject them too, not
  just prompt text.
- Introduction-turn timeout: a stalled introduction turn auto-advances after
  INTRO_TIMEOUT seconds instead of deadlocking the whole team forever.
- Handoff tracking: planner->coder plans, coder->checker evidence and
  checker->coder defects are recorded and exposed in status() + console.
- Throttled expiry checks (at most once per second) instead of a full scan on
  every call — faster under heartbeat load.
- inbox() reports total pending so callers know when more is queued.
"""
import collections
import datetime
import secrets
import threading
import time

ROLES = ("planner", "coder", "checker")
ROLE_TASKS = {
    "planner": "Clarify the goal, inspect relevant context, propose a small implementation plan and hand it to the coder via team_send. NEVER call execute_luau/multi_edit or any Studio mutation — the extension and bridge reject them for planner. You plan; only the coder mutates Studio.",
    "coder": "Implement the agreed plan in small verified steps. You are the ONLY role allowed to mutate Studio (execute_luau/multi_edit). Coordinate shared files with the planner and send the actual changes and checks to the checker via team_send.",
    "checker": "Independently inspect the changes with read-only tools, run relevant checks, report reproducible defects to the coder via team_send, and return evidence. NEVER edit Studio yourself — only the coder mutates. Do not claim tests ran if they did not.",
}

# ── Role permissions (single source of truth, mirrored in config.js) ───────
# Mutating tools change Studio. Only the coder may call them.
MUTATING_TOOLS = frozenset({
    "execute_luau", "multi_edit", "generate_mesh", "generate_procedural_model",
    "insert_from_creator_store", "store_image", "script_write", "create_instance",
    "delete_instance", "set_property", "update_script",
})
READ_TOOLS = frozenset({
    "list_commands", "list_tools", "list_mcp_servers", "script_read",
    "script_search", "script_grep", "search_game_tree", "inspect_instance",
    "get_studio_state", "get_console_output", "search_creator_store",
    "list_roblox_studios", "verify_fact",
})
# start_stop_play changes Studio mode: planner may not use it at all; checker
# may use it only to Play-test (it is a check, not an edit).
PLAY_TOOLS = frozenset({"start_stop_play"})
TEAM_TOOLS = frozenset({"team_status", "team_read", "team_send", "verify_fact"})


def is_mutating(tool_name):
    """True if calling this tool would change Studio (coder-only)."""
    if not isinstance(tool_name, str):
        return False
    bare = tool_name.split("/")[-1]
    if bare in MUTATING_TOOLS:
        return True
    return bare.startswith(("generate_", "insert_", "create_", "delete_"))


def can_mutate(role, tool_name):
    """Only the coder may mutate Studio. Unknown roles may not."""
    return role == "coder"


def role_allows_tool(role, tool_name):
    """Full permission check for one role + tool. Returns (allowed, reason)."""
    if not isinstance(tool_name, str) or not tool_name:
        return False, "tool name required"
    bare = tool_name.split("/")[-1]
    if bare in TEAM_TOOLS or bare in READ_TOOLS:
        return True, ""
    if bare in PLAY_TOOLS:
        if role == "planner":
            return False, "planner may not start/stop Play — send the plan via team_send and let the coder test it"
        return True, ""
    if is_mutating(bare):
        if role == "coder":
            return True, ""
        if role == "planner":
            return False, "planner may not mutate Studio — send your plan to the coder via team_send; only the coder calls execute_luau/multi_edit"
        if role == "checker":
            return False, "checker may not mutate Studio — report defects to the coder via team_send; only the coder calls execute_luau/multi_edit"
        return False, "unknown role may not mutate Studio"
    # Unknown non-read tools: treat as mutating (fail closed for planner/checker).
    if role == "coder":
        return True, ""
    return False, f"{role} may only use read-only tools and team_send"


# Introduction turn auto-advance: a tab that never sends its introduction must
# not block the other two forever. 90s is generous for a visible tab.
INTRO_TIMEOUT = 90.0
# Handoff history per team (bounded).
HANDOFF_MAX = 50


class TeamError(ValueError):
    pass


class TeamHub:
    def __init__(self, ttl=45, clock=time.monotonic, intro_timeout=INTRO_TIMEOUT):
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.clock = clock
        self.ttl = ttl
        self.intro_timeout = intro_timeout
        self.members = {}
        self.teams = {}
        self.events = collections.deque(maxlen=1000)
        self.seq = 0
        self.sent = collections.OrderedDict()
        self._last_expire_check = None

    def _event(self, kind, **data):
        self.seq += 1
        ev = {"seq": self.seq, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"), "kind": kind, **data}
        self.events.append(ev)
        self.cond.notify_all()
        return ev

    def _live(self, team):
        return [m for m in self.members.values() if m["team"] == team and self.clock() - m["seen"] <= self.ttl]

    def _expire_runs(self):
        # Throttled: skip redundant full scans inside a sub-TTL burst while
        # staying exact for short test TTLs and synthetic clocks.
        now = self.clock()
        min_gap = min(0.25, max(0.0, float(self.ttl) / 8.0))
        if self._last_expire_check is not None and 0.0 <= now - self._last_expire_check < min_gap:
            return
        self._last_expire_check = now
        # An active run cannot silently survive a missing required role. Stop it
        # before a heartbeat can revive an expired member with old readiness.
        for team,state in list(self.teams.items()):
            if state.get("active") and {m["role"] for m in self._live(team)} != set(ROLES):
                self.stop(team, "A required tab heartbeat expired. Rejoin missing tabs and explicitly restart.")
                self._event("expired", team=team, text="A required tab heartbeat expired. Team stopped; rejoin missing tabs and explicitly restart.")
            elif state.get("active") and state.get("turn"):
                # Introduction deadlock guard: advance a stalled turn.
                since = state.get("turn_since")
                if since is not None and now - since > self.intro_timeout:
                    stalled = state["turn"]
                    index = ROLES.index(stalled) + 1
                    state["turn"] = ROLES[index] if index < len(ROLES) else None
                    state["turn_since"] = now
                    self._event("turn_skipped", team=team, role=stalled,
                                text=f"Introduction turn for {stalled} timed out after {int(self.intro_timeout)}s; advanced to {state['turn'] or 'free chat'}. The stalled tab may still send later.")
                    if state["turn"]:
                        nxt = next((p for p in self._live(team) if p["role"] == state["turn"] and p["ready"]), None)
                        if nxt:
                            self._invite(nxt, state)

    def _member(self, member_id):
        self._expire_runs()
        if not isinstance(member_id,str): raise TeamError("Invalid member ID")
        m = self.members.get(member_id)
        if not m or self.clock() - m["seen"] > self.ttl:
            raise TeamError("Agent tab is offline or registration expired. Join the team again.")
        return m

    @staticmethod
    def _public(m):
        return {k: m[k] for k in ("id", "name", "role", "team", "ready")}

    # ── Role enforcement (used by bridge.py safe_call) ─────────────────────
    def can_mutate_studio(self, member_id):
        """Return True only when member_id belongs to a live coder in a team."""
        return self.role_of(member_id) == "coder"

    def record_violation(self, member_id, tool_name, reason=""):
        """Record a role-violation event on the bridge console and return it."""
        with self.lock:
            m = self.members.get(member_id)
            if not m:
                return None
            msg = f"{m['name']} ({m['role']}) attempted {tool_name}: rejected." + (f" {reason}" if reason else "")
            self._event("role_violation", team=m["team"], name=m["name"], role=m["role"], text=msg)
            return self.events[-1]

    def role_of(self, member_id):
        """Role for a live member, or None. Does not refresh heartbeat."""
        with self.lock:
            m = self.members.get(member_id) if isinstance(member_id, str) else None
            if not m or self.clock() - m["seen"] > self.ttl:
                return None
            return m["role"]

    def check_mutation(self, member_id, tool_name):
        """Raise TeamError if this member's role may not call this tool.

        Returns the role when allowed. Unknown/offline members are rejected
        for mutating tools (fail closed) but allowed for reads.
        """
        role = self.role_of(member_id)
        if role is None:
            if is_mutating(tool_name):
                raise TeamError("Unknown or offline team member may not mutate Studio. Rejoin the team first.")
            return None
        allowed, reason = role_allows_tool(role, tool_name)
        if not allowed:
            with self.lock:
                m = self.members.get(member_id)
                if m:
                    self._event("role_violation", team=m["team"], name=m["name"], role=role,
                                text=f"{m['name']} ({role}) attempted {tool_name}: rejected. {reason}")
            raise TeamError(reason)
        return role

    def register(self, member_id, name, role, team="studio"):
        if not isinstance(member_id, str) or not member_id or len(member_id) > 160:
            raise TeamError("Invalid member ID")
        if not isinstance(name, str) or not name.strip() or len(name) > 50:
            raise TeamError("Invalid AI name")
        if role not in ROLES:
            raise TeamError("Role must be planner, coder, or checker")
        if not isinstance(team, str) or not team.strip() or len(team) > 64:
            raise TeamError("Team name must contain 1–64 characters")
        with self.lock:
            self._expire_runs()
            old = self.members.get(member_id)
            if old and (old["team"], old["role"], old["name"]) == (team, role, name.strip()):
                old["seen"] = self.clock()
                return self.status(member_id)
            if old and old["team"] in self.teams and self.teams[old["team"]]["active"]:
                raise TeamError("Stop the old team before changing an agent's name, team, or role")
            if any(m["role"] == role and m["id"] != member_id for m in self._live(team)):
                raise TeamError("That role already has a live tab in this team")
            if len(self.members) >= 64 and member_id not in self.members:
                for key, m in list(self.members.items()):
                    if self.clock() - m["seen"] > self.ttl:
                        del self.members[key]
                if len(self.members) >= 64:
                    raise TeamError("Agent registration limit reached")
            self.members[member_id] = {"id": member_id, "name": name.strip(), "role": role, "team": team, "ready": False, "seen": self.clock(), "links": set(), "inbox": collections.deque()}
            self._event("joined", team=team, name=name.strip(), role=role, text="Tab registered; AI readiness not yet confirmed.")
            return self.status(member_id)

    def status(self, member_id):
        with self.lock:
            m = self._member(member_id)
            m["seen"] = self.clock()
            peers = [self._public(p) for p in self._live(m["team"]) if p["id"] != member_id]
            state = self.teams.get(m["team"], {})
            # Registration is NOT evidence of model-to-model communication.
            connected = state.get("active", False) and m["ready"] and any(p["ready"] for p in peers)
            names = ", ".join(p["name"] for p in peers if p["ready"] and p["id"] in m["links"])
            phrase = (f"I am communicating with {names} and ready to help in your code"
                      if connected and bool(names)
                      else "I am not directly communicating with the others try joining three open AI tabs as planner, coder, checker; start the team; keep each tab visible when delivering; check the bridge console for acknowledged messages")
            handoffs = list(state.get("handoffs", []))[-5:]
            phase = "idle"
            if state.get("active"):
                phase = "introducing" if state.get("turn") else (
                    "building" if any(h["kind"] == "plan" for h in state.get("handoffs", [])) else "chatting")
            return {"ok": True, "self": self._public(m), "peers": peers, "active": state.get("active", False), "run": state.get("run"), "stop_reason": state.get("stop_reason"), "introduction_turn": state.get("turn"), "phase": phase, "handoffs": handoffs, "communication_confirmed": connected and bool(names), "phrase": phrase, "role_instructions": ROLE_TASKS[m["role"]], "can_mutate": m["role"] == "coder"}

    def start(self, team):
        with self.lock:
            members = self._live(team)
            if sorted(m["role"] for m in members) != sorted(ROLES):
                raise TeamError("Join exactly one planner, one coder and one checker before starting")
            if self.teams.get(team, {}).get("active"):
                raise TeamError("Team is already active; stop it before starting a new run")
            # Keep old inactive room names bounded as well as members/events.
            if team not in self.teams and len(self.teams)>=128:
                for name,state in list(self.teams.items()):
                    if not state.get("active"):
                        del self.teams[name]
                        if len(self.teams)<128: break
                if len(self.teams)>=128: raise TeamError("Team history limit reached")
            run = secrets.token_hex(8)
            self.teams[team] = {"active": True, "run": run, "turn": "planner", "turn_since": self.clock(), "exchanged": False, "handoffs": []}
            for m in members:
                m["ready"] = False
                m["inbox"].clear()
                m["links"].clear()
            self._event("started", team=team, text="Starting tabs concurrently. Introduction order: planner → coder → checker. Waiting for real AI messages.")
            self._invite(next(m for m in members if m["role"]=="planner"), self.teams[team])
            return {"ok": True, "run": run, "members": [self._public(m) for m in members]}

    def ready(self, member_id):
        with self.lock:
            m = self._member(member_id)
            state = self.teams.get(m["team"], {})
            if not state.get("active"):
                raise TeamError("Team has not started")
            m["ready"] = True
            m["seen"] = self.clock()
            self._event("ready", team=m["team"], name=m["name"], role=m["role"], text="Extension submitted the role prompt; waiting for AI tool messages.")
            if m["role"] == state["turn"]:
                self._invite(m, state)
            return self.status(member_id)

    def _invite(self, m, state):
        if not any(e.get("control") == "introduce" for e in m["inbox"]):
            self._queue(m, {"from": "Bridge coordinator", "role": "control", "control": "introduce", "text": f"It is the {m['role']}'s introduction turn. Use team_send to all with your real name, role, a brief greeting, and your question or handoff. Do not invent other agents' answers.", "run": state["run"]})

    def _queue(self, member, message):
        if len(member["inbox"]) >= 100:
            raise TeamError("Recipient inbox full; no message sent")
        ev = self._event("queued", team=member["team"], name=message["from"], role=message["role"], recipient=member["name"], text=message["text"])
        member["inbox"].append({"id": ev["seq"], "timestamp": ev["timestamp"], **message})

    @staticmethod
    def _handoff_kind(sender_role, recipient):
        """Classify a team_send as a workflow handoff (for console/status)."""
        if sender_role == "planner" and recipient in ("coder", "all"):
            return "plan"
        if sender_role == "coder" and recipient in ("checker", "all"):
            return "evidence"
        if sender_role == "checker" and recipient in ("coder", "all"):
            return "defects"
        return "chat"

    def send(self, member_id, recipient, text, message_id):
        if not isinstance(text, str) or not text.strip() or len(text) > 12000:
            raise TeamError("Message must contain 1–12000 characters")
        if not isinstance(message_id, str) or not message_id or len(message_id) > 160:
            raise TeamError("A bounded message_id is required for safe retries")
        with self.lock:
            m = self._member(member_id)
            state = self.teams.get(m["team"], {})
            key = (member_id, state.get("run"), message_id)
            fingerprint = (recipient, text)
            if key in self.sent:
                old_fp, result = self.sent[key]
                if old_fp != fingerprint:
                    raise TeamError("message_id was already used for different content")
                return result
            if not state.get("active") or not m["ready"]:
                raise TeamError("Start the team and submit this tab's role prompt first")
            if state["turn"] and m["role"] != state["turn"]:
                raise TeamError(f"Wait: {state['turn']} introduces first. Do not send your introduction yet.")
            peers = [p for p in self._live(m["team"]) if p["id"] != member_id]
            targets = peers if recipient == "all" else [p for p in peers if recipient in (p["id"], p["role"], p["name"])]
            if not targets:
                raise TeamError("No live recipient matched. Use team_status for actual peers.")
            if any(len(p["inbox"]) >= 99 for p in targets):
                raise TeamError("Recipient inbox full; no message sent")
            kind = self._handoff_kind(m["role"], recipient)
            self._event("message", team=m["team"], name=m["name"], role=m["role"], recipient=recipient, handoff=kind, text=text)
            state.setdefault("handoffs", []).append({"kind": kind, "from": m["role"], "to": recipient, "text": text[:200], "at": self.clock()})
            if len(state["handoffs"]) > HANDOFF_MAX:
                state["handoffs"] = state["handoffs"][-HANDOFF_MAX:]
            for target in targets:
                self._queue(target, {"from": m["name"], "sender_id": member_id, "role": m["role"], "handoff": kind, "text": text, "run": state["run"]})
            if state["turn"]:
                index = ROLES.index(state["turn"]) + 1
                state["turn"] = ROLES[index] if index < len(ROLES) else None
                state["turn_since"] = self.clock()
                nxt = next((p for p in peers if p["role"] == state["turn"] and p["ready"]), None)
                if nxt:
                    self._invite(nxt, state)
            result = {"ok": True, "queued_for": [p["name"] for p in targets], "message_id": message_id, "handoff": kind, "note": "Queued, not yet acknowledged by recipient. Do not claim a reply was received."}
            self.sent[key] = (fingerprint, result)
            if len(self.sent) > 2000:
                self.sent.popitem(last=False)
            return result

    def inbox(self, member_id):
        with self.lock:
            m = self._member(member_id)
            m["seen"] = self.clock()
            total = len(m["inbox"])
            return {"ok": True, "messages": list(m["inbox"])[:8], "pending": total, "truncated": total > 8, "status": self.status(member_id)}

    def ack(self, member_id, ids):
        if not isinstance(ids, list) or len(ids) > 100 or any(type(i) is not int for i in ids):
            raise TeamError("ids must be a bounded list of integer message IDs")
        with self.lock:
            m = self._member(member_id)
            removed = [ev for ev in m["inbox"] if ev["id"] in ids]
            m["inbox"] = collections.deque(ev for ev in m["inbox"] if ev["id"] not in ids)
            state = self.teams.get(m["team"], {})
            for ev in removed:
                if ev.get("sender_id") and state.get("run") == ev.get("run"):
                    state["exchanged"] = True
                    sender=self.members.get(ev["sender_id"])
                    if sender:
                        sender["links"].add(member_id)
                        m["links"].add(sender["id"])
                self._event("delivered", team=m["team"], name=m["name"], role=m["role"], text=f"Submitted message {ev['id']} from {ev['from']} to chat input; model understanding is not verified.")
            return {"ok": True, "acknowledged": [e["id"] for e in removed]}

    def stop(self, team, reason=None):
        with self.lock:
            if team in self.teams:
                self.teams[team]["active"] = False
                self.teams[team]["stop_reason"] = reason
            for m in self.members.values():
                if m["team"] == team:
                    m["inbox"].clear()
                    m["ready"] = False
            self._event("stopped", team=team, text="Team stopped. Already-running Studio operations cannot be undone or cancelled by this relay.")
            return {"ok": True}

    def leave(self, member_id):
        with self.lock:
            member=self.members.pop(member_id,None)
            if member:
                self.stop(member["team"])
                self._event("left",team=member["team"],name=member["name"],role=member["role"],text="Tab left or navigated away. Rejoin all required roles before restarting.")
            return {"ok":True}

    def event_log(self, since=0):
        with self.lock:
            return {"ok": True, "events": [e for e in self.events if e["seq"] > since], "cursor": self.seq, "reset": since > self.seq, "truncated": bool(self.events and since and since < self.events[0]["seq"] - 1)}

    def wait_events(self, since=0, timeout=5.0):
        """Block until a new event arrives after `since` or `timeout` elapses (0ms wake)."""
        deadline = time.monotonic() + max(0.0, min(float(timeout), 25.0))
        with self.cond:
            while self.seq == since:
                rem = deadline - time.monotonic()
                if rem <= 0:
                    break
                self.cond.wait(timeout=rem)
            return self.event_log(since)

    def summary(self, team=None):
        """Read-only snapshot of all teams (or one team) and live members for CLI/diagnostics."""
        with self.lock:
            self._expire_runs()
            teams_out = {}
            all_names = set(self.teams.keys()) | {m["team"] for m in self.members.values()}
            if team:
                all_names = {n for n in all_names if n == team}
            for tname in sorted(all_names):
                st = self.teams.get(tname, {})
                live = [self._public(m) for m in self._live(tname)]
                teams_out[tname] = {
                    "active": bool(st.get("active", False)),
                    "run": st.get("run"),
                    "introduction_turn": st.get("turn"),
                    "exchanged": bool(st.get("exchanged", False)),
                    "handoffs": list(st.get("handoffs", []))[-5:],
                    "members": live,
                }
            return {"ok": True, "teams": teams_out, "cursor": self.seq}
