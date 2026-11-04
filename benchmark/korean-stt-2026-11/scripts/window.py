import json,os,re,sys
base=sys.argv[1]
CL=[("english","q1v1_btl19w"),("english","IGFIke0RbWw"),("english","rl5ynybcqXU"),("english","9OZIxaXLdks"),
("single","QndOyQtTHUQ"),("single","TNYIXKQy1FU"),("single","RkyJGjwzSEA"),
("talk","0lCBzZBxKUQ"),("talk","nP5UJ5aVy7c"),("talk","YSwWF13jCko"),
("outdoor","s8WeliPT2JM"),("outdoor","TBMTpe3yBt8"),("outdoor","JEMS-Cn5960"),("outdoor","TOdxAwqAw1E"),("outdoor","I3udwVGVjms"),("outdoor","Gb-FFxdGt24"),
("meeting","MHI2bTsLj90"),("meeting","kd8-mXwxUho"),("meeting","MWEBO7idPhQ"),("meeting","1s-6BqFpHm0"),("meeting","mL1z56bKII4")]
def cues(f):
    out=[]
    for e in json.load(open(f,encoding='utf-8')).get('events',[]):
        t=''.join(s.get('utf8','') for s in e.get('segs',[])).replace('\n',' ').strip() if e.get('segs') else ''
        if t: out.append((e['tStartMs']/1000,(e['tStartMs']+e.get('dDurationMs',0))/1000,t))
    return out
def clean(t):
    t=re.sub(r'\[[^\]]*\]|\([^)]*\)|（[^）]*）|\*+[^*]*\*+|✼[^✼]*✼|♪+[^♪]*♪+|♪','',t)
    t=re.sub(r'^\s*[-–—]\s*','',t); t=re.sub(r'\s[-–—]\s',' ',t)
    t=re.sub(r'^[가-힣A-Za-z?]{1,8}\s*:\s*','',t)
    return re.sub(r'\s+',' ',t).strip()
man=[]
for cat,i in CL:
    for d,mf in (('subs',f'meta/{i}.json'),('subs2',f'subs2/{i}.info.json')):
        sf=f'{base}/{d}/{i}.ko.json3'
        if os.path.exists(sf) and os.path.exists(f'{base}/{mf}'):
            break
    else:
        print('MISSING',i); continue
    m=json.load(open(f'{base}/{mf}',encoding='utf-8')); dur=m['duration']; cs=cues(sf)
    t0=0 if dur<=330 else dur*0.2
    w=[c for c in cs if c[0]>=t0]
    s=w[0][0]; lim=s+300
    w=[c for c in w if c[1]<=lim]; e=w[-1][1]
    txt=[];last=None
    for c in w:
        t=clean(c[2])
        if t and t!=last: txt.append(t); last=t
    ref=' '.join(txt)
    open(f'{base}/refs/{i}.txt','w',encoding='utf-8').write(ref)
    hang=len(re.findall('[가-힣]',ref)); lat=re.findall(r'[A-Za-z][A-Za-z0-9.\-]+',ref)
    man.append(dict(id=i,cat=cat,channel=m.get('channel'),title=m.get('title'),start=round(s,2),end=round(e,2)))
    print(cat,i,(m.get('channel') or '')[:10],f's={s:.0f} len={e-s:.0f} 한글/분={hang/(e-s)*60:.0f} 영문={len(lat)}')
json.dump(man,open(f'{base}/manifest.json','w',encoding='utf-8'),ensure_ascii=False,indent=0)
