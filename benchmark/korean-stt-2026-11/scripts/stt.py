import base64,glob,json,os,sys,threading,time,urllib.request,urllib.error
from concurrent.futures import ThreadPoolExecutor
URL='https://openrouter.ai/api/v1/audio/transcriptions'
KEY=os.environ['OPENROUTER_API_KEY']
def call(body,timeout=240):
    req=urllib.request.Request(URL,data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+KEY,'Content-Type':'application/json'})
    t=time.time()
    try:
        with urllib.request.urlopen(req,timeout=timeout) as r:
            return r.status,json.load(r),time.time()-t
    except urllib.error.HTTPError as e:
        raw=e.read().decode('utf-8','replace')[:1500]
        return e.code,{'error_raw':raw},time.time()-t
    except Exception as e:
        return 0,{'error_raw':repr(e)[:500]},time.time()-t
def body(run,audio):
    b=dict(run['body']); b['input_audio']={'data':base64.b64encode(open(audio,'rb').read()).decode(),'format':'mp3'}
    return b
def probe(cfg,audio):
    for name,run in json.load(open(cfg,encoding='utf-8')).items():
        st,d,dt=call(body(run,audio))
        print(f"--- {name} http={st} {dt:.1f}s cost={(d.get('usage') or {}).get('cost')}")
        print((d.get('text') or d.get('error_raw') or str(d))[:400])
def batch(cfg,audiodir,outdir,limit,workers):
    runs=json.load(open(cfg,encoding='utf-8'))
    jobs=[(r,f) for f in sorted(glob.glob(audiodir+'/*.mp3')) for r in runs]
    lock=threading.Lock(); spent=[0.0]
    for f in glob.glob(outdir+'/*.json'):
        spent[0]+=(json.load(open(f,encoding='utf-8')).get('usage') or {}).get('cost') or 0
    def work(j):
        r,f=j; i=os.path.basename(f)[:-4]; out=f'{outdir}/{i}__{r}.json'
        if os.path.exists(out) and json.load(open(out,encoding='utf-8')).get('http')==200: return
        with lock:
            if spent[0]>=limit: print('LIMIT',r,i); return
        for a in range(2):
            st,d,dt=call(body(runs[r],f))
            if st==200 or st in (400,401,402,403,404,413,422): break
            time.sleep(5)
        d.update(http=st,seconds_wall=round(dt,1),attempts=a+1)
        json.dump(d,open(out,'w',encoding='utf-8'),ensure_ascii=False)
        with lock:
            spent[0]+=(d.get('usage') or {}).get('cost') or 0
            print(r,i,st,f'{dt:.0f}s',f'total=${spent[0]:.3f}',(d.get('error_raw') or '')[:120],flush=True)
    with ThreadPoolExecutor(workers) as ex: list(ex.map(work,jobs))
    print('spent',round(spent[0],3))
if __name__=='__main__':
    if sys.argv[1]=='probe': probe(sys.argv[2],sys.argv[3])
    else: batch(sys.argv[2],sys.argv[3],sys.argv[4],float(sys.argv[5]),int(sys.argv[6]))
