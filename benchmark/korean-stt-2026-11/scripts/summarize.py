"""Recomputes every table in README.md from the published CSV files. Standard library only.

usage: summarize.py <data dir>
"""
import csv, random, statistics as st, sys
d = sys.argv[1]
RUNS = ['mai-ko','scribe-ko','gemini-koen','gpt-ko','gpt-koen','nemo-ko','nemo-prompt']
CORE = ['gpt-ko','scribe-ko','gemini-koen','mai-ko','nemo-ko']
REF = 'mai-ko'
N, SEED = 10000, 20261104
load = lambda n: list(csv.DictReader(open(f'{d}/{n}.csv', encoding='utf-8')))
clips = {c['id']: c for c in load('clips')}
S = {(r['clip'], r['run']): r for r in load('scores')}
val = lambda c, r, k: float(S[c, r][k])
EXCL = sorted(c for c in clips if min(val(c, r, 'cer_pct') for r in CORE) > 50)
VALID = sorted(c for c in clips if c not in EXCL)
ALL = sorted(clips)
hours = sum(float(c['duration_s']) for c in clips.values()) / 3600

def boot(cs, f):
    rng = random.Random(SEED)
    xs = sorted(st.fmean(f(rng.choice(cs)) for _ in cs) for _ in range(N))
    return st.fmean(f(c) for c in cs), xs[int(.025*N)], xs[int(.975*N)]
ci = lambda t: f'{t[0]:.1f} [{t[1]:.1f}, {t[2]:.1f}]'
def p90(xs):
    xs = sorted(xs)
    return xs[min(len(xs)-1, int(round(.9*(len(xs)-1))))]

print(f'clips {len(clips)}, valid {len(VALID)}, excluded {EXCL}, audio hours per run {hours:.3f}')
print('\n## overall (mean over clips, 95% paired bootstrap CI)')
print('run | CER incl. ins | CER excl. ins | ins | omission (21) | wall median | wall p90 | cost $ | $/audio h | http ok')
for r in RUNS:
    wall = [val(c, r, 'wall_s') for c in ALL]
    cost = sum(val(c, r, 'cost_usd') for c in ALL)
    ok = sum(S[c, r]['http'] == '200' for c in ALL)
    print(r, '|', ci(boot(VALID, lambda c: val(c, r, 'cer_pct'))), '|', ci(boot(VALID, lambda c: val(c, r, 'cer_noins_pct'))), '|',
          f"{st.fmean(val(c, r, 'ins_pct') for c in VALID):.1f}", '|', ci(boot(ALL, lambda c: val(c, r, 'miss_pct'))), '|',
          f'{st.median(wall):.1f} | {p90(wall):.1f} | {cost:.3f} | {cost/hours:.2f} | {ok}/{len(ALL)}')

print(f'\n## paired difference, other run minus {REF} (positive means {REF} is lower)')
print('run | CER excl. ins | omission | CER incl. ins | clips where mai is lower (excl. ins)')
for r in RUNS:
    if r == REF: continue
    dif = lambda k: lambda c: val(c, r, k) - val(c, REF, k)
    wins = sum(val(c, REF, 'cer_noins_pct') < val(c, r, 'cer_noins_pct') for c in VALID)
    print(r, '|', ci(boot(VALID, dif('cer_noins_pct'))), '|', ci(boot(ALL, dif('miss_pct'))), '|', ci(boot(VALID, dif('cer_pct'))), '|', f'{wins}/{len(VALID)}')

print('\n## best run per clip, CER excl. ins, five core runs')
best = {}
for c in VALID:
    w = min(CORE, key=lambda r: val(c, r, 'cer_noins_pct'))
    best[w] = best.get(w, 0) + 1
print(best)

for lab, key, cs in (('CER excl. ins', 'cer_noins_pct', VALID), ('CER incl. ins', 'cer_pct', VALID), ('omission', 'miss_pct', ALL)):
    print(f'\n## category means, {lab}')
    print('category (n) |', ' | '.join(RUNS))
    for cat in ['single','english','talk','meeting','outdoor']:
        sub = [c for c in cs if clips[c]['category'] == cat]
        print(f'{cat} ({len(sub)}) |', ' | '.join(f'{st.fmean(val(c, r, key) for c in sub):.1f}' for r in RUNS))

print('\n## latin vs hangul spelling of english terms, 5 clips')
L = load('latin_terms')
for r in RUNS:
    a = sum(int(x['latin']) for x in L if x['run'] == r); b = sum(int(x['hangul']) for x in L if x['run'] == r)
    print(r, a, b, f'{a/max(1,a+b)*100:.0f}%')

print('\n## synthetic degradation')
print('clip condition run | CER excl. ins | hyp chars | ref chars | precision | recall')
for x in load('synthetic_scores'):
    ref, hyp = int(x['ref_chars']), int(x['hyp_chars'])
    m = ref * (1 - float(x['cer_noins_pct'])/100)
    print(x['clip'], x['condition'], x['run'], '|', x['cer_noins_pct'], '|', hyp, '|', ref, '|', f'{m/max(1,hyp)*100:.0f} | {m/ref*100:.0f}')

print('\n## sensitivity, CER excl. ins on all 21 clips without the exclusion rule')
for r in RUNS:
    print(r, ci(boot(ALL, lambda c: val(c, r, 'cer_noins_pct'))))

print('\n## clip SNR range')
sn = [float(c['snr_est_db']) for c in clips.values()]
print(min(sn), max(sn))
