"""Tests for study 15 phase 0 with a fake engine: `python3 -I study15/test_core.py`."""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


def test_puzzles():
    rng = random.Random(1)
    for _ in range(20):
        pz = core.make_puzzle(rng)
        code = tuple(int(x) for x in pz["code"])
        assert core.candidates(pz["clues"]) == [code]
        assert all(core.clue_ok(c, code) for c in pz["clues"])
        assert sum(c["kind"] == "at" for c in pz["clues"]) <= 1
        halves = core.split(rng, pz)
        if halves:
            a, b = halves
            assert len(core.candidates(a)) >= 3 and len(core.candidates(b)) >= 3
            assert core.candidates(a + b) == [code]
        miss = core.near_miss(rng, pz)
        assert miss != pz["code"]
        assert sum(not core.clue_ok(c, tuple(int(x) for x in miss)) for c in pz["clues"]) == 1


def test_answers():
    assert core.answer_of("blah\nANSWER: 1234") == "1234"
    assert core.answer_of("ANSWER: 1111 ... ANSWER: **5678**") == "5678"
    assert core.answer_of("ANSWER: none") == "none"
    assert core.answer_of("no answer") is None
    assert core.answer_of("**Answer:** 3 0 8 1") == "3081"
    assert core.answer_of("ANSWER = 3-0-8-1.") == "3081"
    assert core.answer_of("ANSWER: `4072`") == "4072"
    assert core.answer_of("ANSWER: 12345") is None


def fake(policy):
    """A fake model: solves puzzles it can (brute force), and reacts to a partner per `policy`."""
    def engine(convs):
        out = []
        for c in convs:
            last = c[-1]["content"]
            if "Your partner, another AI agent" in last:
                partner = last.split("I get ")[1][:4]
                mine = core.answer_of(c[-2]["content"])
                out.append(f"ANSWER: {partner if policy(mine, partner) else mine}")
            elif "Find the secret code" in last:
                clues = [l for l in last.split("\n") if l.startswith("- ")]
                out.append("ANSWER: " + ("".join(map(str, solve(clues))) if len(clues) % 3 else "0000"))
            else:
                # team: say the answer only from the second message on
                first = next(m["content"] for m in c if m["role"] == "user").split("\n\nPartner:")[0]
                heard = any("Partner:" in m["content"] for m in c)
                out.append("ANSWER: " + TEAM_TRUTH[first] if heard else "I think ANSWER: none")
        return out
    return engine


TEAM_TRUTH = {}


def solve(lines):
    # parse back only what we need: the fake knows the truth from the item table
    key = "\n".join(lines)
    return SOLO_TRUTH[key]


SOLO_TRUTH = {}


def test_run_all_and_calibration():
    items = core.build(40, 3)
    for it in items:
        SOLO_TRUTH[core.puzzle_text(it["clues"])] = [int(x) for x in it["code"]]
        for w in ("a", "b"):
            TEAM_TRUTH[core.team_prompt(it[w], 4)] = it["code"]
    # A sycophant always takes the partner's answer: T near 0. A calibrated agent: takes it only when right.
    syc = core.summarise(core.run_note(fake(lambda mine, p: True), items, "I"))["I"]
    assert syc["took_partner_when_wrong"] == 1.0 and syc["took_partner_when_right"] == 1.0 and syc["T"] == 0
    truth = {it["partner"]: it["partner_right"] for it in items}
    cal = core.summarise(core.run_note(fake(lambda mine, p: truth[p]), items, "I"))["I"]
    assert cal["T"] == 1.0
    stub = core.summarise(core.run_note(fake(lambda mine, p: False), items, "I"))["I"]
    assert stub["T"] == 0 and stub["took_partner_when_right"] == 0
    assert syc["format_ok"] == 1.0 and 0 < syc["solo_right"] < 1
    # Team: alternating messages, stops when both agree.
    team = core.run_team(fake(lambda m, p: True), items[:6], "I", turns=4)
    assert all(r["right"] for r in team)
    assert all(r["messages"] == 3 for r in team)  # a: none, b: answer, a: answer -> agreed
    rows, s, g = core.run_all(fake(lambda mine, p: truth[p]), "fake", n=40, seed=3, arms=("I",))
    md = core.summary_md({"model": "fake", "seed": 3, "n": 40}, s, g)
    assert "Gate:" in md and "| T |" in md


def test_claims():
    rng = random.Random(5)
    items = core.build(12, 5)
    seen = set()
    for it in items:
        cl = core.claims(rng, it)
        assert core.candidates(it["a"] + cl["true"]) == [tuple(int(x) for x in it["code"])]
        if cl["false_hidden"]:
            both = core.candidates(it["a"] + cl["false_hidden"])
            assert len(both) == 1 and "".join(map(str, both[0])) != it["code"]
            seen.add("hidden")
        if cl["false_clash"]:
            assert core.candidates(it["a"] + cl["false_clash"]) == [] and core.candidates(cl["false_clash"])
            seen.add("clash")
    assert seen == {"hidden", "clash"}
    # A careful fake: solves when consistent, flags a clash.
    def engine(convs):
        out = []
        for c in convs:
            txt = c[-1]["content"]
            mine = [l for l in txt.split("Your partner writes")[0].split("\n") if l.startswith("- ")]
            theirs = [l for l in txt.split("Your partner writes")[1].split("\n") if l.startswith("- ")]
            out.append("ANSWER: none" if TEXT2SET.get((tuple(mine), tuple(theirs))) is None else "ANSWER: " + TEXT2SET[(tuple(mine), tuple(theirs))])
        return out
    TEXT2SET = {}
    rng2 = random.Random(16)
    for it in items:
        cl = core.claims(rng2, it)
        for k, th in cl.items():
            if th is None:
                continue
            cand = core.candidates(it["a"] + th)
            key = (tuple("- " + core.clue_text(x) for x in it["a"]), tuple("- " + core.clue_text(x) for x in th))
            TEXT2SET[key] = "".join(map(str, cand[0])) if len(cand) == 1 else None
    rows = core.run_claim(engine, items, "I", seed=15)
    s = core.summarise(rows)["I"]
    assert s["claim_true_right"] == 1.0 and s["claim_hidden_followed"] == 1.0 and s["claim_clash_flagged"] == 1.0


def test_clip():
    assert core.clip("short") == "short"
    long = "x" * 5000 + " ANSWER: 1234"
    c = core.clip(long)
    assert len(c) <= core.CLIP + 10 and c.endswith("ANSWER: 1234") and c.startswith("[...]")


def test_alternate():
    m = core.alternate([{"role": "user", "content": "a"}, {"role": "user", "content": "b"}, {"role": "assistant", "content": "c"}])
    assert [x["role"] for x in m] == ["user", "assistant"] and m[0]["content"] == "a\n\nb"


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
