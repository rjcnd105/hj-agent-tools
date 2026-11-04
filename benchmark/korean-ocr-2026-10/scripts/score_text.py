"""Score the text model output against the payments a screen should yield.

usage: score_text.py <set_dir>...   (reads <set>/screens/truth.json and <set>/text/*.json)
"""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path


def month_day(s):
    for pat in (r"\d{2,4}\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})", r"(\d{1,2})\s*월\s*(\d{1,2})\s*일"):
        m = re.search(pat, s or "")
        if m:
            return f"{int(m[1]):02d}-{int(m[2]):02d}"
    return None


def expected(rows):
    out = []
    for r in rows:
        text = " ".join([r["merchant"], r["amount"], r["detail"]])
        if r["amount"].startswith("+") or re.search(r"취소|환불|거절", text) or re.search(r"(?:^|[\s·|])(?:입금|이자)(?:$|[\s·|])", r["detail"]):
            continue
        out.append({"date": month_day(r["header"] or r["detail"]), "merchant": r["merchant"],
                    "amount": int(re.sub(r"\D", "", r["amount"]))})
    return out


totals = defaultdict(lambda: defaultdict(int))
for d in map(Path, sys.argv[1:]):
    truth = json.loads((d / "screens" / "truth.json").read_text())
    for f in sorted((d / "text").glob("*.json")):
        run = json.loads(f.read_text())
        t = totals[f.stem]
        t["warmup_ms"] = max(t["warmup_ms"], run["warmup_ms"])
        for screen, rows in truth.items():
            exp, res = expected(rows), run["screens"][screen]
            t["screens"] += 1
            t["expected"] += len(exp)
            t["ms"] += res["ms"]
            t["max_ms"] = max(t["max_ms"], res["ms"])
            if not res["ok"]:
                t["errors"] += 1
                t["missing"] += len(exp)
                print(f"  {f.stem} {d.name}/{screen}: ERROR {res['error']} after {res['ms']}ms")
                continue
            got = list(res["rows"])
            screen_ok = len(got) == len(exp)
            for e in exp:
                match = next((g for g in got if g["amount"] == e["amount"]), None)
                if not match:
                    t["missing"] += 1
                    screen_ok = False
                    continue
                got.remove(match)
                t["amount_ok"] += 1
                t["date_ok"] += match["date"] == e["date"]
                t["merchant_ok"] += match["merchant"] == e["merchant"]
                screen_ok &= match["date"] == e["date"]
            t["extra"] += len(got)
            t["screen_ok"] += screen_ok
            if got or not screen_ok:
                print(f"  {f.stem} {d.name}/{screen}: extra={[(g['merchant'], g['amount']) for g in got]} ok={screen_ok}")

print()
for tag, t in totals.items():
    print(f"{tag:14} screens_ok={t['screen_ok']}/{t['screens']} found={t['amount_ok']}/{t['expected']} "
          f"date={t['date_ok']} merchant={t['merchant_ok']} extra={t['extra']} errors={t['errors']} "
          f"avg={t['ms'] / t['screens'] / 1000:.1f}s max={t['max_ms'] / 1000:.1f}s warmup={t['warmup_ms'] / 1000:.1f}s")
