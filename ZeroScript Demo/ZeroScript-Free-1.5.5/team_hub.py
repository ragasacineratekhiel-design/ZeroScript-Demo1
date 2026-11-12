"""Bounded, in-memory agent mailboxes. No model calls and no invented AI replies.

All callers must be authenticated by bridge.py. A member represents one chat tab,
not a model API connection. Delivery means the extension acknowledged submission;
it does not prove that the model read or understood the message.

4.7.0 upgrades (brutal-honest, speed + features):
- TWO OR MORE agents form a team. The joined role set IS the team: a planner +
  coder pair is a valid team, and the introduction order is DERIVED from the
  roles that actually joined (planner -> coder -> checker) instead of a
  hardcoded three. One tab is still not a team.
- The chat is ACTIVE, not optional. The coordinator invites one role at a
  time, escalates when the invited role stays silent, and then drives the
  collaboration protocol with directed control messages:
      planner  -> coder    plan + reference code (ideas the coder can use)
      coder    -> checker  evidence of what actually changed
      checker  -> coder    defects + the exact fix (never an edit)
  The planner supplies ideas/reference code to the coder; the checker points
  the coder at fixes. Only the coder mutates Studio - unchanged, still enforced
  here and in the bridge.
- Every coordinator action reacts to a REAL event (a join, a real team_send).
  Nothing here invents an agent message, an acknowledgement, or a result.
- Bounded mailboxes, a bounded transcript and throttled expiry checks keep the
  hub fast under heartbeat load.
"""
import collections
import datetime
import secrets
import threading
import time

# The role vocabulary and the deterministic order ANY joined set is sorted by.
ROLES = ("planner", "coder", "checker")
ROLE_ORDER = {name: index for index, name in enumerate(ROLES)}
# A team needs at least two joined agents ("start all joined agents"). A single
# tab is a solo run, not a team - it has nobody to talk to.
MIN_TEAM_SIZE = 2
# checker -> coder -> checker loops are bounded so a team cannot ping-pong
# forever. Every round is recorded in the event log.
MAX_FIX_ROUNDS = 3

ROLE_TASKS = {
    "planner": "Clarify the goal, inspect relevant context, then SUPPLY THE CODER WITH IDEAS AND REFERENCE CODE: "
               "the ordered steps, the exact files/instances to touch, and a reference snippet the coder can adapt. "
               "Send it to the coder via team_send (to: \"coder\"). NEVER call execute_luau/multi_edit or any Studio "
               "mutation — the extension and bridge reject them for planner. You plan; only the coder mutates Studio.",
    "coder": "Implement the plan the planner sent you in small verified steps. You are the ONLY role allowed to mutate "
             "Studio (execute_luau/multi_edit). Send the checker the ACTUAL changed paths and checks via team_send "
             "(to: \"checker\"), and fix exactly what the checker reports. Coordinate before editing shared files.",
    "checker": "Independently inspect the changes with read-only tools, run relevant checks, then REPORT reproducible "
               "defects to the coder via team_send (to: \"coder\") together with the exact fix for each one. NEVER edit "
               "Studio yourself — only the coder mutates. Do not claim tests ran if they did not.",
}

# Directed coordinator steps. Each one is queued to ONE role as a control
# message, so the recipient is told what to do next instead of guessing.
COLLAB_CONTROL = {
    "plan": {
        "to": "planner",
        "text": "Introductions are done. You are the PLANNER: send the coder your implementation plan NOW via "
                "team_send (to: \"coder\") — the goal, the files/instances to touch, the ordered steps, and a "
                "reference code snippet the coder can adapt. Do not edit Studio yourself and do not wait for a "
                "second invitation.",
    },
    "plan_only": {
        "to": "planner",
        "text": "Introductions are done. There is no coder in this team, so send your plan to everyone via team_send "
                "(to: \"all\") — the goal, the steps, and a reference snippet — so the other agent can review it.",
    },
    "build": {
        "to": "coder",
        "text": "Introductions are done. There is no planner in this team, so you own the implementation: send one "
                "team_send (to: \"all\") stating what you will build and how the other agent should verify it, then "
                "wait for the task.",
    },
    "implement": {
        "to": "coder",
        "text": "The planner sent you a plan (with reference code). Implement it now with execute_luau / multi_edit, "
                "then send the checker what you ACTUALLY changed via team_send (to: \"checker\"). If you disagree "
                "with the plan, reply to the planner first — do not silently ignore it.",
    },
    "review": {
        "to": "checker",
        "text": "The coder sent evidence of what changed. Verify it NOW with read-only tools (get_studio_state / "
                "script_read / inspect_instance), then send the coder a defect list via team_send (to: \"coder\") with "
                "the exact fix for every defect. If nothing is broken, send that verdict to the coder explicitly. "
                "NEVER edit Studio yourself.",
    },
    "fix": {
        "to": "coder",
        "text": "The checker reported defects. Fix exactly those defects now with execute_luau / multi_edit, then send "
                "the checker the fix summary via team_send (to: \"checker\"). If you believe a defect report is wrong, "
                "reply to the checker with your evidence instead of silently skipping it.",
    },
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

# Handoff kinds the hub understands. "chat" is the default for anything the
# coordinator does not recognise; "request" is the user's own task relayed by
# the extension, which is NOT an agent introduction.
SEND_KINDS = frozenset({"chat", "plan", "evidence", "defects", "intro", "request"})


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
# not block the other agents forever. 90s is generous for a visible tab.
INTRO_TIMEOUT = 90.0
# The coordinator re-asks a silent tab before it gives up on it.
INTRO_RETRY = 40.0
# Handoff history per team (bounded).
HANDOFF_MAX = 50


class TeamError(ValueError):
    pass


class TeamHub:
    def __init__(self, ttl=45, clock=time.monotonic, intro_timeout=INTRO_TIMEOUT, intro_retry=INTRO_RETRY):
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.clock = clock
        self.ttl = ttl
        self.intro_timeout = intro_timeout
        self.intro_retry = intro_retry
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

    @staticmethod
    def _ordered_roles(members):
        """Deterministic role order for ANY joined set: canonical first."""
        present = {m["role"] for m in members}
        ordered = [r for r in ROLES if r in present]
        return ordered + sorted(present - set(ROLES))

    def _expire_runs(self):
        # Throttled: skip redundant full scans inside a sub-TTL burst while
        # staying exact for short test TTLs and synthetic clocks.
        now = self.clock()
        min_gap = min(0.25, max(0.0, float(self.ttl) / 8.0))
        if self._last_expire_check is not None and 0.0 <= now - self._last_expire_check < min_gap:
            return
        self._last_expire_check = now
        for team, state in list(self.teams.items()):
            if not state.get("active"):
                continue
            # An active run cannot silently survive a missing joined role. Stop
            # it before a heartbeat can revive an expired member with old
            # readiness. The joined role set is the contract - not a fixed trio.
            joined = list(state.get("roles") or ())
            live_roles = {m["role"] for m in self._live(team)}
            missing = [r for r in joined if r not in live_roles]
            if missing:
                reason = "A required tab heartbeat expired (" + ", ".join(missing) + "). Rejoin the missing tabs and explicitly restart."
                self.stop(team, reason)
                self._event("expired", team=team, text=reason)
                continue
            if state.get("turn"):
                self._advance_stalled_turn(team, state, now)

    def _advance_stalled_turn(self, team, state, now):
        """Re-ask a silent tab, then move the introduction on."""
        started = state.get("turn_started")
        since = state.get("turn_since")
        if since is None:
            return
        stalled = state["turn"]
        member = next((p for p in self._live(team) if p["role"] == stalled), None)
        attempts = state.get("turn_attempts", 0)
        if started is not None and (now - started) > self.intro_timeout:
            state.setdefault("skipped", []).append(stalled)
            self._event("turn_skipped", team=team, role=stalled,
                        text=f"Introduction turn for {stalled} timed out after {int(self.intro_timeout)}s. The team "
                             f"moves on; that tab may still send later as an ordinary message.")
            self._advance_turn(team, state, now)
            return
        if member is not None and attempts < 2 and (now - since) > self.intro_retry:
            state["turn_attempts"] = attempts + 1
            state["turn_since"] = now
            self._event("intro_nudge", team=team, name=member["name"], role=stalled,
                        text=f"The {stalled} was invited to introduce {int(self.intro_retry)}s ago and has not sent "
                             f"anything yet. The coordinator is asking that tab again.")
            self._queue(member, {
                "from": "Bridge coordinator", "role": "control", "control": "introduce",
                "text": f"Still your introduction turn ({stalled}) and nobody has heard from you. Reply NOW with one "
                        f"team_send command to \"all\" containing your real name, your role, a one-line greeting and "
                        f"the handoff you propose. Do not write plain prose and do not wait for another invitation.",
                "run": state["run"],
            })

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
            self._event("joined", team=team, name=name.strip(), role=role,
                        text=f"{name.strip()} ({role}) joined team {team}. AI readiness is not confirmed yet.")
            # A tab that joins a RUNNING team extends the team: the new role
            # joins the introduction order and is invited to speak.
            state = self.teams.get(team)
            if state and state.get("active") and role not in (state.get("roles") or ()):
                state["roles"] = self._ordered_roles(self._live(team))
                member = self.members[member_id]
                self._event("joined", team=team, name=name.strip(), role=role,
                            text=f"{name.strip()} ({role}) joined the running team; introduction order is now "
                                 f"{' → '.join(state['roles'])}.")
                if not state.get("turn"):
                    self._invite(member, state)
            return self.status(member_id)

    def status(self, member_id):
        with self.lock:
            m = self._member(member_id)
            m["seen"] = self.clock()
            peers = [self._public(p) for p in self._live(m["team"]) if p["id"] != member_id]
            state = self.teams.get(m["team"], {})
            roles = list(state.get("roles") or ()) or self._ordered_roles(self._live(m["team"]))
            # Registration is NOT evidence of model-to-model communication.
            connected = state.get("active", False) and m["ready"] and any(p["ready"] for p in peers)
            names = ", ".join(p["name"] for p in peers if p["ready"] and p["id"] in m["links"])
            phrase = (f"I am communicating with {names} and ready to help in your code"
                      if connected and bool(names)
                      else "I am not directly communicating with the others try joining the other open AI tabs as planner, coder, checker (at least two tabs); start all joined agents; keep each tab visible when delivering; check the bridge console for acknowledged messages")
            handoffs = list(state.get("handoffs", []))[-5:]
            phase = state.get("phase") or "idle"
            if state.get("active") and state.get("turn"):
                phase = "introducing"
            spoken = state.get("spoken") or ()
            return {"ok": True, "self": self._public(m), "peers": peers, "active": state.get("active", False),
                    "run": state.get("run"), "stop_reason": state.get("stop_reason"),
                    "introduction_turn": state.get("turn"), "phase": phase, "handoffs": handoffs,
                    "team_roles": roles, "introduction_order": roles,
                    "introduced": m["id"] in spoken,
                    "communication_confirmed": connected and bool(names), "phrase": phrase,
                    "role_instructions": ROLE_TASKS[m["role"]], "can_mutate": m["role"] == "coder",
                    "min_team_size": MIN_TEAM_SIZE}

    def start(self, team):
        with self.lock:
            members = self._live(team)
            roles = self._ordered_roles(members)
            if len(members) < MIN_TEAM_SIZE:
                joined = ", ".join(f"{r} ({m['name']})" for r, m in
                                   sorted(((m["role"], m) for m in members), key=lambda pair: ROLE_ORDER.get(pair[0], 99)))
                raise TeamError(
                    f"A team needs at least {MIN_TEAM_SIZE} joined agents - start all joined agents. "
                    f"Joined so far: {joined or 'none'}.")
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
            now = self.clock()
            self.teams[team] = {"active": True, "run": run, "roles": roles,
                                "turn": roles[0] if roles else None,
                                "turn_since": now, "turn_started": now, "turn_attempts": 0,
                                "exchanged": False, "handoffs": [], "spoken": set(),
                                "phase": "introducing", "rounds": 0}
            for m in members:
                m["ready"] = False
                m["inbox"].clear()
                m["links"].clear()
            order = " → ".join(roles)
            self._event("started", team=team,
                        text=f"Starting {len(members)} joined tabs concurrently ({order}). Introduction order: {order}. "
                             f"Waiting for real AI messages.")
            first = next((m for m in members if m["role"] == roles[0]), None)
            if first:
                self._invite(first, self.teams[team])
            return {"ok": True, "run": run, "members": [self._public(m) for m in members],
                    "roles": roles, "introduction_order": roles, "min_team_size": MIN_TEAM_SIZE}

    def ready(self, member_id):
        with self.lock:
            m = self._member(member_id)
            state = self.teams.get(m["team"], {})
            if not state.get("active"):
                raise TeamError("Team has not started")
            m["ready"] = True
            m["seen"] = self.clock()
            self._event("ready", team=m["team"], name=m["name"], role=m["role"], text="Extension submitted the role prompt; waiting for AI tool messages.")
            if m["role"] == state.get("turn"):
                self._invite(m, state)
            return self.status(member_id)

    def _invite(self, m, state):
        if not any(e.get("control") == "introduce" for e in m["inbox"]):
            order = " → ".join(state.get("roles") or ())
            self._queue(m, {"from": "Bridge coordinator", "role": "control", "control": "introduce",
                            "text": f"It is the {m['role']}'s introduction turn (order: {order}). Use team_send to "
                                    f"\"all\" with your real name, your role, a brief greeting, and the handoff you "
                                    f"propose. Do not invent other agents' answers.",
                            "run": state["run"]})

    def _queue(self, member, message):
        if len(member["inbox"]) >= 100:
            raise TeamError("Recipient inbox full; no message sent")
        ev = self._event("queued", team=member["team"], name=message["from"], role=message["role"], recipient=member["name"], text=message["text"])
        member["inbox"].append({"id": ev["seq"], "timestamp": ev["timestamp"], **message})

    def _control(self, team, state, name):
        """Queue a directed coordinator step to exactly one role."""
        spec = COLLAB_CONTROL.get(name)
        if not spec:
            return None
        target = next((p for p in self._live(team) if p["role"] == spec["to"]), None)
        if target is None:
            return None
        self._queue(target, {"from": "Bridge coordinator", "role": "control", "control": name,
                             "text": spec["text"], "run": state["run"]})
        self._event("collab", team=team, name=target["name"], role=spec["to"],
                    text=f"Coordinator moved the team to the '{name}' step for the {spec['to']}.")
        return target

    def _begin_collaboration(self, team, state):
        """Introductions are over: start the ordered collaboration."""
        if state.get("phase") != "introducing":
            return
        roles = state.get("roles") or []
        if "planner" in roles and "coder" in roles:
            state["phase"] = "plan"
            self._control(team, state, "plan")
        elif "planner" in roles:
            state["phase"] = "plan_only"
            self._control(team, state, "plan_only")
        elif "coder" in roles:
            state["phase"] = "build"
            self._control(team, state, "build")
        else:
            state["phase"] = "chat"

    def _advance_turn(self, team, state, now=None):
        """Move the introduction to the next joined role (or into collaboration)."""
        now = self.clock() if now is None else now
        roles = list(state.get("roles") or ())
        current = state.get("turn")
        if current in roles:
            index = roles.index(current) + 1
            state["turn"] = roles[index] if index < len(roles) else None
        else:
            state["turn"] = None
        state["turn_since"] = now
        state["turn_started"] = now
        state["turn_attempts"] = 0
        if state["turn"]:
            nxt = next((p for p in self._live(team) if p["role"] == state["turn"] and p["ready"]), None)
            if nxt:
                self._invite(nxt, state)
        else:
            self._begin_collaboration(team, state)

    def _on_handoff(self, team, state, kind):
        """Real handoff -> next directed coordinator step."""
        if state.get("phase") == "introducing":
            # Introductions run first; the collaboration steps start afterwards.
            return
        roles = state.get("roles") or []
        if kind == "plan" and "coder" in roles:
            state["phase"] = "implement"
            self._control(team, state, "implement")
        elif kind == "evidence" and "checker" in roles:
            state["phase"] = "review"
            self._control(team, state, "review")
        elif kind == "defects" and "coder" in roles:
            rounds = state.get("rounds", 0) + 1
            state["rounds"] = rounds
            if rounds <= MAX_FIX_ROUNDS:
                state["phase"] = "fix"
                self._control(team, state, "fix")
            else:
                state["phase"] = "done"
                self._event("collab", team=team,
                            text=f"Fix rounds exhausted ({MAX_FIX_ROUNDS}). The coordinator stops escalating; the "
                                 f"agents may still talk freely.")

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

    def send(self, member_id, recipient, text, message_id, kind=None):
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
            explicit = kind if isinstance(kind, str) and kind in SEND_KINDS else None
            skipped = state.get("skipped") or ()
            introducing = state.get("phase") == "introducing" and state.get("turn") == m["role"]
            if (state.get("turn") and m["role"] != state["turn"]
                    and explicit != "request" and m["role"] not in skipped):
                raise TeamError(f"Wait: {state['turn']} introduces first. Do not send your introduction yet.")
            peers = [p for p in self._live(m["team"]) if p["id"] != member_id]
            targets = peers if recipient == "all" else [p for p in peers if recipient in (p["id"], p["role"], p["name"])]
            if not targets:
                raise TeamError("No live recipient matched. Use team_status for actual peers.")
            if any(len(p["inbox"]) >= 99 for p in targets):
                raise TeamError("Recipient inbox full; no message sent")
            if explicit:
                handoff = explicit
            elif introducing:
                # The first message of an introduction turn IS the introduction.
                handoff = "intro"
            else:
                handoff = self._handoff_kind(m["role"], recipient)
            self._event("message", team=m["team"], name=m["name"], role=m["role"], recipient=recipient, handoff=handoff, text=text)
            state.setdefault("handoffs", []).append({"kind": handoff, "from": m["role"], "to": recipient, "text": text[:200], "at": self.clock()})
            if len(state["handoffs"]) > HANDOFF_MAX:
                state["handoffs"] = state["handoffs"][-HANDOFF_MAX:]
            state.setdefault("spoken", set()).add(member_id)
            for target in targets:
                self._queue(target, {"from": m["name"], "sender_id": member_id, "role": m["role"], "handoff": handoff, "text": text, "run": state["run"]})
            if state.get("turn") and introducing and handoff != "request":
                self._advance_turn(m["team"], state)
            self._on_handoff(m["team"], state, handoff)
            result = {"ok": True, "queued_for": [p["name"] for p in targets], "message_id": message_id, "handoff": handoff, "note": "Queued, not yet acknowledged by recipient. Do not claim a reply was received."}
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
                self.teams[team]["turn"] = None
                self.teams[team]["phase"] = "stopped"
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
                self._event("left",team=member["team"],name=member["name"],role=member["role"],text="Tab left or navigated away. Rejoin the missing roles before restarting.")
            return {"ok":True}

    def event_log(self, since=0):
        with self.lock:
            return {"ok": True, "events": [e for e in self.events if e["seq"] > since], "cursor": self.seq, "reset": since > self.seq, "truncated": bool(self.events and since and since < self.events[0]["seq"] - 1)}

    def chat(self, team=None, limit=50):
        """The bare chat transcript: the real messages agents sent, nothing else."""
        with self.lock:
            self._expire_runs()
            try:
                limit = max(1, min(int(limit), 500))
            except (TypeError, ValueError):
                limit = 50
            messages = [e for e in self.events if e.get("kind") == "message" and (not team or e.get("team") == team)]
            members = {}
            for member in self._live(team) if team else list(self.members.values()):
                members.setdefault(member["team"], []).append(self._public(member))
            for name in members:
                members[name].sort(key=lambda m: ROLE_ORDER.get(m.get("role"), 99))
            return {"ok": True, "messages": messages[-limit:], "members": members, "cursor": self.seq}

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
                    "introduction_order": list(st.get("roles") or ()) or self._ordered_roles(live),
                    "phase": st.get("phase") or "idle",
                    "exchanged": bool(st.get("exchanged", False)),
                    "handoffs": list(st.get("handoffs", []))[-5:],
                    "members": live,
                }
            return {"ok": True, "teams": teams_out, "cursor": self.seq, "min_team_size": MIN_TEAM_SIZE}
