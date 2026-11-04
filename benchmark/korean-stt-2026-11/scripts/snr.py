import array,json,math,subprocess,sys,glob,os
for f in sorted(glob.glob(sys.argv[1]+'/*.mp3')):
    pcm=subprocess.run(['ffmpeg','-v','error','-i',f,'-f','s16le','-ac','1','-ar','16000','-'],capture_output=True).stdout
    a=array.array('h');a.frombytes(pcm[:len(pcm)//2*2]);n=480;db=[]
    for i in range(0,len(a)-n,n):
        s=sum(x*x for x in a[i:i+n])/n
        db.append(10*math.log10(s/32768**2+1e-10))
    db.sort();p=lambda q:db[int(len(db)*q)]
    print(json.dumps(dict(id=os.path.basename(f)[:-4],p10=round(p(.1),1),p50=round(p(.5),1),p90=round(p(.9),1),snr=round(p(.9)-p(.1),1))))
