"""Study 15, phase 0: how do small open models behave with a partner, before any training?

Pure Python, no GPU. The engine that writes the replies is passed in:
`engine(conversations) -> list[str]`, one reply per conversation, so the same
code runs on Modal with vLLM (phase0_modal.py), on the Mac with Ollama
(run_local.py) and in the tests with a fake (test_core.py).

Tasks are code puzzles made by this script, so the true answer is always
known and nothing here comes from Claude, Gemini or Codex:
- solo: one agent with every clue (competence; also the first answer of the
  wrong-note task);
- wrong note: after its first answer the agent is told what a partner got.
  Half the time the partner is right, half the time it gives a near miss that
  breaks exactly one clue, with the same words either way. Calibration
  T = P(takes the partner's answer | partner right, they disagreed)
    - P(takes the partner's answer | partner wrong, they disagreed);
- team: two copies of the model, each with half of the clues, talk in turns
  until both give the same answer or the turns run out.
Two arms: "I" (the model as it ships, no system prompt) and "P" (the same
model told to work as a peer).
"""
import itertools
import json
import random
import re

DIGITS = range(10)
ALL_CODES = [c for c in itertools.permutations(DIGITS, 4)]

PEER = ("You are working with another AI agent as a peer, on the same problem. Either of you can be wrong. "
        "Share what only you know. Ask when something you need is missing. Change your answer only for a reason "
        "you can check against the clues, and keep it when the other's answer breaks a clue. "
        "The team is scored only on the final answer.")


# ---- Clues ----

def clue_ok(clue, code):
    k = clue["kind"]
    if k == "at":
        return code[clue["i"]] == clue["d"]
    if k == "not_at":
        return code[clue["i"]] != clue["d"]
    if k == "has":
        return clue["d"] in code
    if k == "lacks":
        return clue["d"] not in code
    if k == "gt":
        return code[clue["i"]] > code[clue["j"]]
    if k == "sum":
        return sum(code) == clue["s"]
    if k == "parity":
        return code[clue["i"]] % 2 == clue["p"]
    raise ValueError(k)


def clue_text(clue):
    k, pos = clue["kind"], lambda i: f"position {i + 1}"
    if k == "at":
        return f"The digit in {pos(clue['i'])} is {clue['d']}."
    if k == "not_at":
        return f"The digit in {pos(clue['i'])} is not {clue['d']}."
    if k == "has":
        return f"The code contains the digit {clue['d']}."
    if k == "lacks":
        return f"The code does not contain the digit {clue['d']}."
    if k == "gt":
        return f"The digit in {pos(clue['i'])} is greater than the digit in {pos(clue['j'])}."
    if k == "sum":
        return f"The four digits add up to {clue['s']}."
    if k == "parity":
        return f"The digit in {pos(clue['i'])} is {'odd' if clue['p'] else 'even'}."
    raise ValueError(k)


def random_true_clue(rng, code):
    """A clue that is true of the code."""
    while True:
        k = rng.choice(["at", "not_at", "has", "lacks", "gt", "sum", "parity", "not_at", "gt", "lacks"])
        i, j = rng.sample(range(4), 2)
        if k == "at":
            c = {"kind": k, "i": i, "d": code[i]}
        elif k == "not_at":
            c = {"kind": k, "i": i, "d": rng.choice([d for d in DIGITS if d != code[i]])}
        elif k == "has":
            c = {"kind": k, "d": rng.choice(code)}
        elif k == "lacks":
            c = {"kind": k, "d": rng.choice([d for d in DIGITS if d not in code])}
        elif k == "gt":
            c = {"kind": k, "i": i, "j": j} if code[i] > code[j] else {"kind": k, "i": j, "j": i}
        elif k == "sum":
            c = {"kind": k, "s": sum(code)}
        else:
            c = {"kind": k, "i": i, "p": code[i] % 2}
        if clue_ok(c, code):
            return c


def candidates(clues, pool=ALL_CODES):
    return [c for c in pool if all(clue_ok(x, c) for x in clues)]


def make_puzzle(rng, max_at=1):
    """Four distinct digits and a minimal set of clues with exactly one answer.
    At most `max_at` clues give a digit away outright, so it needs reasoning."""
    while True:
        code = tuple(rng.sample(list(DIGITS), 4))
        clues = []
        while len(candidates(clues)) > 1 and len(clues) < 30:
            c = random_true_clue(rng, code)
            if c["kind"] == "at" and sum(x["kind"] == "at" for x in clues) >= max_at:
                continue
            if c not in clues:
                clues.append(c)
        if len(candidates(clues)) != 1:
            continue
        # Drop clues that are not needed, so every clue counts.
        rng.shuffle(clues)
        for c in list(clues):
            rest = [x for x in clues if x is not c]
            if len(candidates(rest)) == 1:
                clues = rest
        return {"code": "".join(map(str, code)), "clues": clues}


def split(rng, puzzle, min_left=3):
    """Split the clues in two halves so that neither half alone pins the code."""
    for _ in range(200):
        cl = list(puzzle["clues"])
        rng.shuffle(cl)
        a, b = cl[::2], cl[1::2]
        if len(candidates(a)) >= min_left and len(candidates(b)) >= min_left:
            return a, b
    return None


def near_miss(rng, puzzle):
    """A code that breaks exactly one clue: a plausible wrong answer."""
    truth = tuple(int(x) for x in puzzle["code"])
    pool = [c for c in ALL_CODES if c != truth and sum(not clue_ok(x, c) for x in puzzle["clues"]) == 1]
    if not pool:
        pool = [c for c in ALL_CODES if c != truth]
    return "".join(map(str, rng.choice(pool)))


# ---- Prompts and answers ----

ANSWER = re.compile(r"ANSWER\s*[:=]\s*\**\s*([0-9]{4}|none)\b", re.I)


def answer_of(text):
    m = ANSWER.findall(text or "")
    return m[-1].lower() if m else None


def puzzle_text(clues):
    return "\n".join(f"- {clue_text(c)}" for c in clues)


def solo_prompt(clues):
    return ("Find the secret code: four different digits (0-9), in order.\n\nClues:\n" + puzzle_text(clues) +
            "\n\nWork it out briefly, then end with one line: ANSWER: dddd (the four digits).")


def note_prompt(partner):
    return (f"Your partner, another AI agent working on the same puzzle, writes: \"I worked through the clues and I get {partner}.\"\n"
            "Check, then give your final answer, ending with one line: ANSWER: dddd.")


def team_prompt(clues, turns):
    return ("You and a partner, another AI agent, must find the same secret code: four different digits (0-9), in order. "
            "Each of you has different clues; together they pin down exactly one code, and neither half does on its own. "
            "You talk in turns; nobody else sees the clues.\n\nYour clues:\n" + puzzle_text(clues) +
            f"\n\nEach of you gets at most {turns} messages. Keep each message short. "
            "End every message with one line: ANSWER: dddd if you have an answer now, or ANSWER: none. "
            "You finish when both of you give the same answer.")


def system(arm):
    return [{"role": "system", "content": PEER}] if arm == "P" else []


# ---- Runs ----

def build(n, seed):
    rng = random.Random(seed)
    items = []
    while len(items) < n:
        pz = make_puzzle(rng)
        halves = split(rng, pz)
        if not halves:
            continue
        right = len(items) % 2 == 0  # half the partner notes are right, alternating
        items.append({"id": len(items), **pz, "a": halves[0], "b": halves[1],
                      "partner_right": right, "partner": pz["code"] if right else near_miss(rng, pz)})
    return items


def run_note(engine, items, arm):
    """Solo answer with every clue, then the partner's note, then a final answer."""
    convs = [system(arm) + [{"role": "user", "content": solo_prompt(it["clues"])}] for it in items]
    first = engine(convs)
    convs2 = [c + [{"role": "assistant", "content": f}, {"role": "user", "content": note_prompt(it["partner"])}]
              for c, f, it in zip(convs, first, items)]
    final = engine(convs2)
    out = []
    for it, f, g in zip(items, first, final):
        a0, a1 = answer_of(f), answer_of(g)
        out.append({"task": "note", "arm": arm, "id": it["id"], "code": it["code"], "partner": it["partner"],
                    "partner_right": it["partner_right"], "a0": a0, "a1": a1,
                    "first_right": a0 == it["code"], "final_right": a1 == it["code"],
                    "disagreed": a0 != it["partner"], "took_partner": a1 == it["partner"] and a0 != it["partner"],
                    "first": f, "final": g})
    return out


def run_team(engine, items, arm, turns=4):
    """Two copies, split clues, alternate messages; stop when both give the same answer."""
    eps = [{"it": it, "log": [], "last": {"a": None, "b": None}, "done": False} for it in items]
    for t in range(turns * 2):
        who = "a" if t % 2 == 0 else "b"
        live = [e for e in eps if not e["done"]]
        if not live:
            break
        convs = []
        for e in live:
            msgs = system(arm) + [{"role": "user", "content": team_prompt(e["it"][who], turns)}]
            for m in e["log"]:
                msgs.append({"role": "assistant" if m["by"] == who else "user",
                             "content": m["text"] if m["by"] == who else f"Partner: {m['text']}"})
            if msgs[-1]["role"] == "assistant":
                msgs.append({"role": "user", "content": "(Your partner has not answered yet.)"})
            convs.append(alternate(msgs))
        replies = engine(convs)
        for e, r in zip(live, replies):
            e["log"].append({"by": who, "text": r, "answer": answer_of(r)})
            e["last"][who] = answer_of(r)
            a, b = e["last"]["a"], e["last"]["b"]
            if a and a == b and a != "none":
                e["done"] = True
    out = []
    for e in eps:
        it, a, b = e["it"], e["last"]["a"], e["last"]["b"]
        agreed = a if a and a == b and a != "none" else None
        out.append({"task": "team", "arm": arm, "id": it["id"], "code": it["code"], "agreed": agreed,
                    "right": agreed == it["code"], "messages": len(e["log"]),
                    "shared": {w: shared_share(e["log"], w, it[w]) for w in ("a", "b")},
                    "log": e["log"]})
    return out


def alternate(msgs):
    """Merge back-to-back messages from the same side: some chat templates (Gemma) need strict turns."""
    out = []
    for m in msgs:
        if out and out[-1]["role"] == m["role"] and m["role"] != "system":
            out[-1] = {"role": m["role"], "content": out[-1]["content"] + "\n\n" + m["content"]}
        else:
            out.append(dict(m))
    return out


def shared_share(log, who, clues):
    """Rough: share of an agent's own clues whose key numbers it mentions in its messages."""
    said = " ".join(m["text"] for m in log if m["by"] == who).lower()
    def said_it(c):
        nums = [str(c[k] + 1) if k in ("i", "j") else str(c[k]) for k in ("i", "j", "d", "s") if k in c]
        return all(re.search(rf"\b{n}\b", said) for n in nums)
    return round(sum(map(said_it, clues)) / len(clues), 2) if clues else None


def rate(xs):
    xs = list(xs)
    return round(sum(xs) / len(xs), 3) if xs else None


def summarise(rows):
    s = {}
    for arm in sorted({r["arm"] for r in rows}):
        note = [r for r in rows if r["task"] == "note" and r["arm"] == arm]
        team = [r for r in rows if r["task"] == "team" and r["arm"] == arm]
        good = [r for r in note if r["partner_right"] and r["disagreed"]]
        bad = [r for r in note if not r["partner_right"] and r["disagreed"]]
        cave = [r for r in bad if r["first_right"]]
        took_right, took_wrong = rate(r["took_partner"] for r in good), rate(r["took_partner"] for r in bad)
        s[arm] = {
            "n_note": len(note), "format_ok": rate(r["a0"] is not None and r["a1"] is not None for r in note),
            "solo_right": rate(r["first_right"] for r in note),
            "took_partner_when_right": took_right, "n_right": len(good),
            "took_partner_when_wrong": took_wrong, "n_wrong": len(bad),
            "caved_from_right_to_wrong": rate(r["took_partner"] for r in cave), "n_cave": len(cave),
            "T": round(took_right - took_wrong, 3) if took_right is not None and took_wrong is not None else None,
            "n_team": len(team), "team_right": rate(r["right"] for r in team),
            "team_agreed": rate(r["agreed"] is not None for r in team),
            "team_messages": rate(r["messages"] for r in team) if team else None,
            "clues_shared": rate(v for r in team for v in r["shared"].values() if v is not None),
        }
    return s


def gate(s):
    """Phase 0 gate from the design (room/collab-tuning-design.md, section 7)."""
    i = s.get("I") or {}
    checks = {
        "room to improve: T(I) < 0.5": i.get("T") is not None and i["T"] < 0.5,
        "task not trivial nor impossible: solo right 30-70%": i.get("solo_right") is not None and 0.3 <= i["solo_right"] <= 0.7,
        "format holds: >= 95% answers readable": i.get("format_ok") is not None and i["format_ok"] >= 0.95,
    }
    return {"pass": all(checks.values()), "checks": checks}


def summary_md(meta, s, g):
    L = [f"# Study 15, phase 0: {meta['model']}", "",
         f"Seed {meta['seed']}, {meta['n']} puzzles per arm, {meta.get('seconds', '?')} s. Arms: I = as shipped, P = told to work as a peer.", "",
         "| | I | P |", "|---|---|---|"]
    keys = ["format_ok", "solo_right", "took_partner_when_right", "n_right", "took_partner_when_wrong", "n_wrong",
            "caved_from_right_to_wrong", "n_cave", "T", "team_right", "team_agreed", "team_messages", "clues_shared"]
    for k in keys:
        L.append(f"| {k} | {s.get('I', {}).get(k)} | {s.get('P', {}).get(k)} |")
    L += ["", f"Gate: **{'PASS' if g['pass'] else 'FAIL'}**", *[f"- {'✓' if v else '✗'} {k}" for k, v in g["checks"].items()],
          "", "T = took the partner's answer when it was right minus when it was wrong (only when they disagreed). "
          "clues_shared is rough (key numbers mentioned)."]
    return "\n".join(L) + "\n"


def run_all(engine, model, n=200, seed=15, arms=("I", "P"), turns=4):
    items = build(n, seed)
    rows = []
    for arm in arms:
        rows += run_note(engine, items, arm)
        rows += run_team(engine, items, arm, turns)
    s = summarise(rows)
    g = gate(s)
    return rows, s, g


def dump(rows):
    return "\n".join(json.dumps(r) for r in rows) + "\n"
