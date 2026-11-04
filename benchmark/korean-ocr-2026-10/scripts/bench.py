"""OCR each strip through an OpenAI-compatible llama-server and score against ground truth.

usage: bench.py <name> <port> <prompt-file|literal> <data-dir> [max_tokens]
Writes <data-dir>/out/<name>.json with per-screen joined text, per-strip timing and scores.
"""
import base64
import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

name, port, prompt_arg, data = sys.argv[1:5]
max_tokens = int(sys.argv[5]) if len(sys.argv) > 5 else 512
prompt = Path(prompt_arg).read_text().strip() if Path(prompt_arg).is_file() else prompt_arg
data = Path(data)
truth = json.loads((data / "screens" / "truth.json").read_text())


recorded = {}
if port.startswith("file:"):
    # Score outputs recorded by another runner (JSON lines keyed "<screen>/<strip>").
    for line in Path(port[5:]).read_text().splitlines():
        row = json.loads(line)
        recorded[row["image"]] = row


def ocr(png: bytes, key: str):
    if recorded:
        row = recorded[key]
        return row["text"], row["seconds"], "stop"
    body = {
        "messages": [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(png).decode()}},
            {"type": "text", "text": prompt},
        ]}],
        "temperature": 0, "max_tokens": max_tokens, "stream": False,
    }
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"})
    start = time.monotonic()
    res = json.load(urllib.request.urlopen(req, timeout=300))
    return res["choices"][0]["message"]["content"], time.monotonic() - start, res["choices"][0]["finish_reason"]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[·•∙ㆍ・]", "·", s)
    return re.sub(r"\s+", "", s)


def lev(a: str, b: str) -> int:
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def gt_lines(rows, title):
    lines, last = [title], None
    for r in rows:
        if r["header"] and r["header"] != last:
            lines.append(r["header"])
            last = r["header"]
        lines.append(f'{r["merchant"]} {r["amount"]}')
        lines.append(f'{r["detail"]} {r["right"]}'.strip())
    return lines


titles = json.loads((data / "screens" / "titles.json").read_text())
result = {"model": name, "screens": {}}
for screen, rows in truth.items():
    strips = sorted((data / "strips" / screen).glob("*.png"))
    outputs = []
    for path in strips:
        text, secs, finish = ocr(path.read_bytes(), f"{screen}/{path.name}")
        outputs.append({"strip": path.name, "text": text, "seconds": round(secs, 3), "finish": finish})
    lines = (re.sub(r"\s*(?:\r\n|\n|\r)\s*", " / ", o["text"].strip()) for o in outputs)
    joined = "\n".join(line for line in lines if line)
    out_n = norm(joined.replace(" / ", ""))
    fields = {"merchant": [], "amount": [], "date": [], "type": [], "balance": []}
    for r in rows:
        fields["merchant"].append((r["merchant"], norm(r["merchant"]) in out_n))
        fields["amount"].append((r["amount"], norm(r["amount"]) in out_n))
        date = r["header"] or r["detail"].split("·")[0]
        fields["date"].append((date, norm(date) in out_n))
        for part in r["detail"].split("·"):
            if part.strip() and not re.search(r"\d\d:\d\d|\d\d\. \d\d\. \d\d", part):
                fields["type"].append((part.strip(), norm(part) in out_n))
        if r["right"]:
            fields["balance"].append((r["right"], norm(r["right"]) in out_n))
    ref = norm("".join(gt_lines(rows, titles[screen])))
    result["screens"][screen] = {
        "joined": joined,
        "strips": outputs,
        "seconds": round(sum(o["seconds"] for o in outputs), 2),
        "cer": round(lev(ref, out_n) / len(ref), 4),
        "misses": {k: [v for v, ok in vals if not ok] for k, vals in fields.items()},
        "hits": {k: [sum(ok for _, ok in vals), len(vals)] for k, vals in fields.items()},
    }
    s = result["screens"][screen]
    print(f'{name} {screen}: cer={s["cer"]} secs={s["seconds"]} hits={s["hits"]} misses={s["misses"]}', flush=True)

(data / "out").mkdir(exist_ok=True)
print(name, "TOTAL", {k: [sum(s["hits"][k][0] for s in result["screens"].values()), sum(s["hits"][k][1] for s in result["screens"].values())] for k in ["merchant", "amount", "date", "type", "balance"]}, "secs", round(sum(s["seconds"] for s in result["screens"].values()), 1))
(data / "out" / f"{name}.json").write_text(json.dumps(result, ensure_ascii=False, indent=1))
