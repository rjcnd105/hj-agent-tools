"""Writes the published CSV files from local results. Output holds metrics only, never model text.

usage: export_csv.py <data dir> <results dir> <out dir>
"""
import csv, json, sys
data, res, out = sys.argv[1:4]
man = json.load(open(f'{data}/manifest.json', encoding='utf-8'))
snr = {j['id']: j['snr'] for j in map(json.loads, open(f'{data}/snr_real.jsonl'))}
with open(f'{out}/clips.csv', 'w', newline='', encoding='utf-8') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['id','category','channel','start_s','end_s','duration_s','snr_est_db','url'])
    for c in man:
        w.writerow([c['id'], c['cat'], c['channel'].replace(',', ' '), c['start'], c['end'], round(c['end']-c['start'], 2), snr[c['id']],
                    f"https://www.youtube.com/watch?v={c['id']}"])
COLS = ['cer','noins','ins','miss']
def dump(name, folder, split):
    scores = json.load(open(f'{res}/{folder}_scores.json'))
    with open(f'{out}/{name}.csv', 'w', newline='', encoding='utf-8') as f:
        w = csv.writer(f, lineterminator='\n')
        w.writerow(['clip'] + (['condition'] if split else []) + ['run','cer_pct','cer_noins_pct','ins_pct','miss_pct','hyp_chars','ref_chars','http','attempts','wall_s','cost_usd'])
        for k in sorted(scores):
            clip, run = k.split('__')
            v = scores[k]
            r = json.load(open(f'{res}/{folder}/{k}.json', encoding='utf-8'))
            head = clip.rsplit('_', 1) if split else [clip]
            w.writerow(head + [run] + [round(v[c], 2) for c in COLS] + [v['ln'], v['refln'], r['http'], r['attempts'], r['seconds_wall'], round((r.get('usage') or {}).get('cost') or 0, 6)])
dump('scores', 'real', False)
dump('synthetic_scores', 'synth', True)
