"""Wilson intervals for the merchant hit rate, and the payment count the text scoring expects.

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
def expected(rs):
    n = 0
    for r in rs:
        text = ' '.join([r['merchant'], r['amount'], r['detail']])
        if r['amount'].startswith('+') or re.search(r'취소|환불|거절', text) or re.search(r'(?:^|[\s·|])(?:입금|이자)(?:$|[\s·|])', r['detail']):
            continue
        n += 1
    return n
tot = 0
for s in ('base', 'real-names', 'degraded'):
    t = json.load(open(f'{root}/images/{s}/truth.json', encoding='utf-8'))
    n = sum(expected(v) for v in t.values()); tot += n
    print(s, 'screens', len(t), 'rows', sum(len(v) for v in t.values()), 'expected payments', n)
print('expected payments total', tot)
