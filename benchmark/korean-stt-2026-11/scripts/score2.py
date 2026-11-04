import glob,json,os,re,statistics as st,sys,unicodedata as u,collections
data,res=sys.argv[1],sys.argv[2]
RUNS=['gpt-ko','gpt-koen','scribe-ko','gemini-koen','mai-ko','nemo-ko','nemo-prompt']
CORE=['gpt-ko','scribe-ko','gemini-koen','mai-ko','nemo-ko']
norm=lambda t:re.sub(r'[^가-힣a-z0-9]','',u.normalize('NFKC',t).lower())
def ops(h,r):
    p=[(j,0,j,0) for j in range(len(r)+1)]  # cost,sub,del(ref missing),ins
    for i,x in enumerate(h,1):
        c=[(i,0,0,i)]
        for j,y in enumerate(r,1):
            a=p[j-1];b=p[j];d=c[j-1]
            s=(a[0]+(x!=y),a[1]+(x!=y),a[2],a[3]); ins=(b[0]+1,b[1],b[2],b[3]+1); de=(d[0]+1,d[1],d[2]+1,d[3])
            c.append(min(s,ins,de))
        p=c
    return p[-1]
grams=lambda t:{t[i:i+4] for i in range(len(t)-3)}
man={c['id']:c for c in json.load(open(data+'/manifest.json',encoding='utf-8'))}
base=lambda c:c.split('_crowd')[0].split('_farmic')[0]
T=collections.defaultdict(dict)
for f in glob.glob(res+'/*.json'):
    c,r=os.path.basename(f)[:-5].split('__'); d=json.load(open(f,encoding='utf-8'))
    T[c][r]=norm(d.get('text') or '')
out={}
for c,ts in T.items():
    ref=norm(open(f'{data}/refs/{base(c)}.txt',encoding='utf-8').read())
    cnt=collections.Counter(g for r in CORE for g in grams(ts.get(r,'')))
    cons={g for g,n in cnt.items() if n>=3}
    for r,h in ts.items():
        k,s,de,i=ops(h,ref); g=grams(h)
        others=set().union(*[grams(ts[o]) for o in CORE if o!=r and o in ts])|grams(ref)
        out[c,r]=dict(cer=k/len(ref)*100,noins=(s+de)/len(ref)*100,ins=i/len(ref)*100,miss=len(cons-g)/max(1,len(cons))*100,solo=len(g-others)/max(1,len(g))*100,ln=len(h),refln=len(ref))
json.dump({f'{a}__{b}':v for (a,b),v in out.items()},open(res+'/../'+os.path.basename(res)+'_scores.json','w'),indent=0)
clips=sorted(T,key=lambda c:(man.get(base(c),{}).get('cat',''),c))
for lab,key in (('CER(삽입 제외: 치환+삭제)','noins'),('합의 내용 누락%','miss'),('단독 내용%','solo')):
    print('==',lab); print('clip'.ljust(24),*[r[:8].rjust(8) for r in RUNS])
    for c in clips:
        print((man.get(base(c),{}).get('cat','')[:3]+' '+c)[:24].ljust(24),*[('%.1f'%out[c,r][key]).rjust(8) if (c,r) in out else '-'.rjust(8) for r in RUNS])
print('== 글자수'); print('clip'.ljust(24),'ref'.rjust(6),*[r[:8].rjust(8) for r in RUNS])
for c in clips:
    print(c[:24].ljust(24),str(out[c,RUNS[0]]['refln']).rjust(6),*[str(out[c,r]['ln']).rjust(8) if (c,r) in out else '-'.rjust(8) for r in RUNS])
EXCL=[c for c in clips if min(out[c,r]['cer'] for r in CORE if (c,r) in out)>50]
print('자막 무효(모든 모델 CER>50):',EXCL)
print('== 범주 평균 (무효 제외)')
print('cat'.ljust(16),*[r[:8].rjust(8) for r in RUNS])
for key in ('noins','cer','miss','solo'):
    for cat in sorted({man.get(base(c),{}).get('cat','') for c in clips}):
        cs=[c for c in clips if man.get(base(c),{}).get('cat','')==cat and (c not in EXCL or key in('miss','solo'))]
        if not cs: continue
        print((key+' '+cat)[:16].ljust(16),*[('%.1f'%st.mean(out[c,r][key] for c in cs if (c,r) in out)).rjust(8) if any((c,r) in out for c in cs) else '-'.rjust(8) for r in RUNS])
    cs=[c for c in clips if (c not in EXCL or key in('miss','solo'))]
    print((key+' ALL')[:16].ljust(16),*[('%.1f'%st.mean(out[c,r][key] for c in cs if (c,r) in out)).rjust(8) for r in RUNS])
