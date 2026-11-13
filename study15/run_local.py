"""Study 15, phase 0 smoke test on this computer with Ollama, no GPU rental:
`python3 study15/run_local.py --model qwen3:8b --n 2`

Slow (one call at a time, ~35 s each on the Mac): only to see that prompts and
answers work before paying for a GPU. Results in
~/.agent-dispatch/study15/local/<time>/. Ollama listens only on this computer.
"""
import argparse
import json
import os
import pathlib
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import core  # noqa: E402


def ollama(model, host):
    def engine(convs):
        out = []
        for c in convs:
            body = json.dumps({"model": model, "messages": c, "stream": False, "think": False,
                               "options": {"temperature": 0.7, "top_p": 0.8, "num_predict": 2048}}).encode()
            req = urllib.request.Request(f"{host}/api/chat", body, {"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as r:
                out.append(json.loads(r.read())["message"]["content"])
            print(".", end="", flush=True)
        return out
    return engine


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="qwen3:8b")
    ap.add_argument("--n", type=int, default=2)
    ap.add_argument("--seed", type=int, default=15)
    ap.add_argument("--turns", type=int, default=4)
    ap.add_argument("--arms", default="I,P")
    ap.add_argument("--host", default="http://127.0.0.1:11434")
    a = ap.parse_args()
    t0 = time.time()
    rows, s, g = core.run_all(ollama(a.model, a.host), a.model, n=a.n, seed=a.seed, arms=tuple(a.arms.split(",")), turns=a.turns)
    meta = {"model": a.model, "n": a.n, "seed": a.seed, "seconds": round(time.time() - t0)}
    out = pathlib.Path.home() / ".agent-dispatch" / "study15" / "local" / time.strftime("%Y-%m-%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.jsonl").write_text(core.dump(rows))
    (out / "summary.json").write_text(json.dumps({"meta": meta, "summary": s, "gate": g}, indent=2))
    md = core.summary_md(meta, s, g, rows)
    (out / "summary.md").write_text(md)
    print("\n" + md + f"\nSaved in {out}")
