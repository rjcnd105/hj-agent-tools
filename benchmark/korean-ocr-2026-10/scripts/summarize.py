"""Wilson intervals for the merchant hit rate, the 2026-11-04 rerun totals, and the payment count the text scoring expects.

usage: summarize.py <benchmark folder>
"""
import csv, json, math, re, sys
root = sys.argv[1]
def wilson(k, n, z=1.96):
    p = k/n; d = 1 + z*z/n; c = p + z*z/(2*n); h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))
    return (c-h)/d*100, (c+h)/d*100
rows = list(csv.DictReader(open(f'{root}/data/ocr_merchants.csv', encoding='utf-8')))
def line(lab, sub):
    k = sum(int(r['hits']) for r in sub); n = sum(int(r['total']) for r in sub)
    lo, hi = wilson(k, n)
    print(f'{lab}: {k}/{n} = {k/n*100:.0f}% [{lo:.0f}, {hi:.0f}]')
for e in dict.fromkeys(r['engine'] for r in rows):
    sub = [r for r in rows if r['engine'] == e]
    line(f'{e} all', sub)
    line(f'{e} not degraded', [r for r in sub if r['set'] != 'degraded'])
    line(f'{e} degraded', [r for r in sub if r['set'] == 'degraded'])
SETS = ('base', 'real-names', 'degraded')
def rerun(engine):
    return {s: json.load(open(f'{root}/outputs/2026-11-04/{s}/{engine}.json', encoding='utf-8'))['screens'] for s in SETS}
def hits(data, field):
    return [sum(v['hits'][field][i] for v in data[s].values()) for s in SETS for i in (0, 1)]
runs = {e: rerun(e) for e in ('paddle', 'ovis')}
for e, data in runs.items():
    h = hits(data, 'merchant')
    print(f'rerun {e} merchant by set: {h}')
    line(f'rerun {e} all', [{'hits': h[i], 'total': h[i+1]} for i in (0, 2, 4)])
    a = hits(data, 'amount')
    cer = sum(v['cer'] for s in SETS for v in data[s].values()) / 15
    n = sum(len(v['strips']) for s in SETS for v in data[s].values())
    secs = sum(v['seconds'] for s in SETS for v in data[s].values())
    print(f'rerun {e}: amount {sum(a[::2])}/{sum(a[1::2])}, mean CER {cer*100:.2f}%, {n} strips, {secs/n*1000:.0f} ms per strip')
only_p = only_o = 0
for s in SETS:
    for name in runs['paddle'][s]:
        p, o = (set(runs[e][s][name]['misses']['merchant']) for e in ('paddle', 'ovis'))
        only_o += len(p - o)
        only_p += len(o - p)
tail = min(1.0, 2 * sum(math.comb(only_p + only_o, i) for i in range(min(only_p, only_o) + 1)) / 2 ** (only_p + only_o))
print(f'rerun merchants right only in paddle {only_p}, only in ovis {only_o}, exact sign test p={tail:.2g}')
def expected(rs):
    n = 0
    for r in rs:
        text = ' '.join([r['merchant'], r['amount'], r['detail']])
        if r['amount'].startswith('+') or re.search(r'취소|환불|거절', text) or re.search(r'(?:^|[\s·|])(?:입금|이자)(?:$|[\s·|])', r['detail']):
            continue
        n += 1
    return n
tot = 0
for s in SETS:
    t = json.load(open(f'{root}/images/{s}/truth.json', encoding='utf-8'))
    n = sum(expected(v) for v in t.values()); tot += n
    print(s, 'screens', len(t), 'rows', sum(len(v) for v in t.values()), 'expected payments', n)
print('expected payments total', tot)
