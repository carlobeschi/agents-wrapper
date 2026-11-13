"""Study 15, phase 0 on a rented GPU (Modal): `modal run study15/phase0_modal.py`.

Runs core.py with vLLM on one GPU in Modal's cloud: Qwen3-8B as shipped ("I")
and told to work as a peer ("P"), on code puzzles with known answers (solo,
wrong note, team with split clues). Nothing is trained. The results come back
to this computer, in ~/.agent-dispatch/study15/phase0/<time>/ (rows.jsonl,
summary.json, summary.md), and a copy stays in the Modal volume "study15".

Cost guard: the GPU stops when the job ends, and the job is killed after
3 hours whatever happens (about $6 at most on an L40S at $1.95/h).
Options: --model Qwen/Qwen3-8B --n 200 --seed 15 --turns 4 --arms I,P
GPU type: STUDY15_GPU=L40S (default) or A100-80GB, A10G, H100.
Gemma models are gated on Hugging Face: they need a token as a Modal secret
(see study15/README.md); Qwen3 does not.
"""
import json
import os
import pathlib
import time

import modal

HERE = pathlib.Path(__file__).parent
GPU = os.environ.get("STUDY15_GPU", "L40S")

image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install("vllm==0.9.2", "huggingface_hub[hf_transfer]")
    .env({"HF_HOME": "/data/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1"})
    .add_local_file(HERE / "core.py", "/root/core.py")
)
volume = modal.Volume.from_name("study15", create_if_missing=True)
secrets = [modal.Secret.from_name("huggingface")] if os.environ.get("STUDY15_HF_SECRET") else []
app = modal.App("study15-phase0")


@app.function(image=image, gpu=GPU, timeout=3 * 3600, volumes={"/data": volume}, secrets=secrets)
def phase0(model: str, n: int, seed: int, turns: int, arms: list) -> dict:
    import re
    import sys
    sys.path.insert(0, "/root")
    import core
    from vllm import LLM, SamplingParams

    t0 = time.time()
    llm = LLM(model=model, max_model_len=8192, gpu_memory_utilization=0.90, seed=seed)
    params = SamplingParams(temperature=0.7, top_p=0.8, max_tokens=1024, seed=seed)
    calls = {"n": 0}

    def engine(convs):
        calls["n"] += len(convs)
        outs = llm.chat(convs, params, use_tqdm=False, chat_template_kwargs={"enable_thinking": False})
        return [re.sub(r"<think>.*?</think>", "", o.outputs[0].text, flags=re.S).strip() for o in outs]

    rows, s, g = core.run_all(engine, model, n=n, seed=seed, arms=tuple(arms), turns=turns)
    meta = {"model": model, "n": n, "seed": seed, "turns": turns, "arms": arms, "gpu": GPU,
            "seconds": round(time.time() - t0), "calls": calls["n"], "vllm": "0.9.2",
            "sampling": {"temperature": 0.7, "top_p": 0.8, "max_tokens": 1024}}
    md = core.summary_md(meta, s, g)
    run = time.strftime("%Y-%m-%d-%H%M%S")
    out = pathlib.Path("/data/runs") / run
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.jsonl").write_text(core.dump(rows))
    (out / "summary.json").write_text(json.dumps({"meta": meta, "summary": s, "gate": g}, indent=2))
    (out / "summary.md").write_text(md)
    volume.commit()
    return {"run": run, "rows": core.dump(rows), "summary": {"meta": meta, "summary": s, "gate": g}, "md": md}


@app.local_entrypoint()
def main(model: str = "Qwen/Qwen3-8B", n: int = 200, seed: int = 15, turns: int = 4, arms: str = "I,P"):
    print(f"Study 15 phase 0: {model}, {n} puzzles, arms {arms}, GPU {GPU}. Stops by itself; at most 3 hours.")
    r = phase0.remote(model, n, seed, turns, arms.split(","))
    out = pathlib.Path.home() / ".agent-dispatch" / "study15" / "phase0" / r["run"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "rows.jsonl").write_text(r["rows"])
    (out / "summary.json").write_text(json.dumps(r["summary"], indent=2))
    (out / "summary.md").write_text(r["md"])
    print(r["md"])
    print(f"Saved in {out}")
