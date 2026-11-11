"""Bounded, in-memory agent mailboxes. No model calls and no invented AI replies.

All callers must be authenticated by bridge.py. A member represents one chat tab,
not a model API connection. Delivery means the extension acknowledged submission;
it does not prove that the model read or understood the message.
"""
import collections
import datetime
import secrets
import threading
import time

ROLES = ("planner", "coder", "checker")
ROLE_TASKS = {
    "planner": "Clarify the goal, inspect relevant context, propose a small implementation plan and hand it to the coder. Do not modify Studio unless explicitly asked.",
    "coder": "Implement the agreed plan in small verified steps. Coordinate shared files with the planner and send the actual changes and checks to the checker.",
    "checker": "Independently inspect the changes, run relevant checks, report reproducible defects, and return evidence. Do not claim tests ran if they did not.",
}


class TeamError(ValueError):
    pass


class TeamHub:
    def __init__(self, ttl=45, clock=time.monotonic):
        self.lock = threading.RLock()
        self.clock = clock
        self.ttl = ttl
        self.members = {}
        self.teams = {}
        self.events = collections.deque(maxlen=1000)
        self.seq = 0
        self.sent = collections.OrderedDict()

    def _event(self, kind, **data):
        self.seq += 1
        ev = {"seq": self.seq, "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds"), "kind": kind, **data}
        self.events.append(ev)
        return ev

    def _live(self, team):
        return [m for m in self.members.values() if m["team"] == team and self.clock() - m["seen"] <= self.ttl]

    def _member(self, member_id):
        m = self.members.get(member_id)
        if not m or self.clock() - m["seen"] > self.ttl:
            raise TeamError("Agent tab is offline or registration expired. Join the team again.")
        return m

    @staticmethod
    def _public(m):
        return {k: m[k] for k in ("id", "name", "role", "team", "ready")}

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
            return {"ok": True, "self": self._public(m), "peers": peers, "active": state.get("active", False), "run": state.get("run"), "introduction_turn": state.get("turn"), "communication_confirmed": connected and bool(names), "phrase": phrase, "role_instructions": ROLE_TASKS[m["role"]]}

    def start(self, team):
        with self.lock:
            members = self._live(team)
            if sorted(m["role"] for m in members) != sorted(ROLES):
                raise TeamError("Join exactly one planner, one coder and one checker before starting")
            if self.teams.get(team, {}).get("active"):
                raise TeamError("Team is already active; stop it before starting a new run")
            run = secrets.token_hex(8)
            self.teams[team] = {"active": True, "run": run, "turn": "planner", "exchanged": False}
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
            self._event("message", team=m["team"], name=m["name"], role=m["role"], recipient=recipient, text=text)
            for target in targets:
                self._queue(target, {"from": m["name"], "sender_id": member_id, "role": m["role"], "text": text, "run": state["run"]})
            if state["turn"]:
                index = ROLES.index(state["turn"]) + 1
                state["turn"] = ROLES[index] if index < len(ROLES) else None
                nxt = next((p for p in peers if p["role"] == state["turn"] and p["ready"]), None)
                if nxt:
                    self._invite(nxt, state)
            result = {"ok": True, "queued_for": [p["name"] for p in targets], "message_id": message_id, "note": "Queued, not yet acknowledged by recipient. Do not claim a reply was received."}
            self.sent[key] = (fingerprint, result)
            if len(self.sent) > 2000:
                self.sent.popitem(last=False)
            return result

    def inbox(self, member_id):
        with self.lock:
            m = self._member(member_id)
            m["seen"] = self.clock()
            return {"ok": True, "messages": list(m["inbox"])[:8], "status": self.status(member_id)}

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

    def stop(self, team):
        with self.lock:
            if team in self.teams:
                self.teams[team]["active"] = False
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
