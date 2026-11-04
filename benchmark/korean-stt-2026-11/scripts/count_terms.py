"""Counts how often English terms come back in Latin script or spelled out in Hangul.

usage: count_terms.py <results/real> > data/latin_terms.csv
The term list was written by hand after reading the clips, so it is a coarse signal.
"""
import csv, json, re, sys
res = sys.argv[1]
RUNS = ['gpt-ko','gpt-koen','scribe-ko','gemini-koen','mai-ko','nemo-ko','nemo-prompt']
M = {'sdk':'에스디케이','gpu':'지피유','ppt':'피피티','github':'깃허브','git':'깃','lcd':'엘씨디|엘시디','hdmi':'에이치디엠아이','led':'엘이디','sd':'에스디','api':'에이피아이','http':'에이치티티피','ip':'아이피','acl':'에이씨엘|에이시엘','msa':'엠에스에이','cli':'씨엘아이|시엘아이','ai':'에이아이','gpt':'지피티','vs':'브이에스','mcp':'엠씨피|엠시피','llm':'엘엘엠','macos':'맥오에스','esc':'이에스씨','rewind':'리와인드','desktop':'데스크탑|데스크톱','m1':'엠원','dac':'댁','usb':'유에스비','hz':'헤르츠'}
CLIPS = ['q1v1_btl19w','IGFIke0RbWw','rl5ynybcqXU','TNYIXKQy1FU','QndOyQtTHUQ']
w = csv.writer(sys.stdout, lineterminator='\n')
w.writerow(['clip','run','latin','hangul'])
for r in RUNS:
    for c in CLIPS:
        t = json.load(open(f'{res}/{c}__{r}.json', encoding='utf-8'))['text']
        lo = t.lower()
        w.writerow([c, r,
                    sum(len(re.findall(r'(?<![a-z])'+k+r'(?![a-z])', lo)) for k in M),
                    sum(len(re.findall(v, t)) for v in M.values())])
