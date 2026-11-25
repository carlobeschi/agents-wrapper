"""
title: Desk
description: Lets a model in Open WebUI read and add to the shared task desk (desk.js): the board, new tasks, comments and reviews.
version: 0.1.0
license: GPL-3.0-only
"""

# Paste this file in Open WebUI: Workspace > Tools > + (new tool), then turn the
# tool on for the model you call in chats or channels. The desk must be
# running on the same Mac: node desk.js serve <dir> (port 8790).
# Tasks added from here never carry a test command: they wait for a person's
# review on the desk.

import json
import urllib.request

try:
    from pydantic import BaseModel, Field
except ImportError:  # only for trying the file outside Open WebUI
    class BaseModel:  # type: ignore
        def __init__(self, **kw):
            for k, v in type(self).__dict__.items():
                if not k.startswith("_"):
                    setattr(self, k, kw.get(k, v))

    def Field(default=None, **_):  # type: ignore
        return default


class Tools:
    class Valves(BaseModel):
        desk_url: str = Field(default="http://127.0.0.1:8790", description="Where desk.js is running")

    def __init__(self):
        self.valves = self.Valves()

    def _call(self, method: str, route: str, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = urllib.request.Request(self.valves.desk_url + route, data=data, method=method, headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            return json.loads(e.read().decode() or "{}")
        except Exception as e:  # desk not running
            return {"error": f"The desk is not reachable at {self.valves.desk_url}: {e}"}

    @staticmethod
    def _who(user) -> str:
        user = user or {}
        return str(user.get("name") or user.get("email") or "someone")[:60]

    def desk_board(self) -> str:
        """
        Show the shared goal, every task with its status and who holds it, the money spent, and people's latest comments.
        """
        b = self._call("GET", "/board")
        if "error" in b:
            return b["error"]
        lines = [f"Goal: {b['goal']}", f"Spent about ${b['spent_usd']:.2f} of ${b['budget_usd']}", "Tasks:"]
        for t in b["tasks"]:
            held = f", held by {t['holder']}" if t.get("holder") else ""
            needs = f", needs {', '.join(t['needs'])}" if t.get("needs") else ""
            lines.append(f"- {t['id']} {t['title']}: {t['status']}{held}{needs} (tries {t['attempts']})")
        if b.get("comments"):
            lines.append("Comments:")
            lines += [f"- {c['by']}: {c['text']}" for c in b["comments"][-10:]]
        return "\n".join(lines)

    def desk_add_task(self, title: str, detail: str = "", __user__: dict = {}) -> str:
        """
        Add a new task to the shared desk. A worker agent will take it; a person reviews the result.
        :param title: Short name of the task.
        :param detail: What exactly should be done and what counts as finished.
        """
        r = self._call("POST", "/tasks", {"title": title, "detail": detail, "by": self._who(__user__)})
        return r.get("error") or f"Added task {r['id']}."

    def desk_comment(self, text: str, task_id: str = "", __user__: dict = {}) -> str:
        """
        Leave a comment on the desk, on one task (the workers read it the next time they take that task) or for everyone.
        :param text: The comment.
        :param task_id: The task it is about, for example t3; empty for a comment to everyone.
        """
        payload = {"text": text, "by": self._who(__user__)}
        if task_id:
            payload["task"] = task_id
        r = self._call("POST", "/comment", payload)
        return r.get("error") or "Comment saved on the desk."

    def desk_review(self, task_id: str, verdict: str, note: str = "", __user__: dict = {}) -> str:
        """
        Accept or reject a task that is waiting for a person's review.
        :param task_id: The task, for example p1.
        :param verdict: accept or reject.
        :param note: Why; the worker reads it if the task goes back.
        """
        r = self._call("POST", "/review", {"task": task_id, "verdict": verdict, "note": note, "by": self._who(__user__)})
        return r.get("error") or f"Task {task_id} is now {r['status']}."
