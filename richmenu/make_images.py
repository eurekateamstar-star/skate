from PIL import Image, ImageDraw, ImageFont
import math
W,H=2500,1686; HD=250
BOLD="/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"; MED="/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
f=lambda p,s: ImageFont.truetype(p,s,index=2)  # TC
THEMES={
 "blue":dict(BG=(245,245,247),ACC=(0,113,227),TXT=(29,29,31),MUT=(134,134,139),TINT=(230,240,252),CARD=(255,255,255),HDON=(255,255,255),HDOFF=(233,233,238),HTON=None,HTOFF=(134,134,139),G1=(41,151,255),G2=(0,113,227),BIGSUB=(220,236,255)),
 "A":dict(BG=(246,244,244),ACC=(214,0,28),TXT=(29,29,31),MUT=(134,134,139),TINT=(253,232,234),CARD=(255,255,255),HDON=(255,255,255),HDOFF=(236,233,233),HTON=None,HTOFF=(150,140,140),G1=(236,32,52),G2=(196,0,24),BIGSUB=(255,222,226)),
 "B":dict(BG=(214,0,28),ACC=(214,0,28),TXT=(29,29,31),MUT=(140,120,122),TINT=(253,232,234),CARD=(255,255,255),HDON=(214,0,28),HDOFF=(170,0,22),HTON=(255,255,255),HTOFF=(255,190,196),G1=(255,255,255),G2=(255,255,255),BIGFG=(214,0,28),BIGSUB=(170,60,70),UL=(255,255,255)),
 "C":dict(BG=(24,24,26),ACC=(232,24,44),TXT=(245,245,247),MUT=(150,150,156),TINT=(60,22,26),CARD=(44,44,48),HDON=(24,24,26),HDOFF=(38,38,42),HTON=(255,255,255),HTOFF=(120,120,126),G1=(240,36,56),G2=(190,0,24),BIGSUB=(255,214,218),UL=(232,24,44)),
 "D":dict(BG=(244,238,228),ACC=(200,16,36),TXT=(40,32,30),MUT=(140,126,116),TINT=(250,226,224),CARD=(255,252,247),HDON=(255,252,247),HDOFF=(232,224,212),HTON=None,HTOFF=(150,136,124),G1=(200,16,36),G2=(200,16,36),BIGSUB=(255,220,222)),
}
THEMES.update({
 # 曜石：純黑、紅色光暈、細邊框
 "K1":dict(BG=(10,10,11),ACC=(235,28,46),TXT=(246,246,247),MUT=(132,132,138),TINT=None,CARD=(22,22,24),CARDLINE=(44,44,48),HDON=(10,10,11),HDOFF=(20,20,22),HTON=(255,255,255),HTOFF=(98,98,104),UL=(235,28,46),
           G1=(30,30,33),G2=(14,14,15),BIGLINE=(70,20,26),GLOW=(235,28,46),GLOWA=215,GLOWR=430,BIGICON=(255,255,255),BIGSUB=(150,150,156),BIGBAR=(235,28,46),CHEV=(70,70,76)),
 # 炭黑紅漸層：大按鈕黑到深紅斜漸層
 "K2":dict(BG=(18,18,20),ACC=(240,44,60),TXT=(245,245,247),MUT=(140,140,146),TINT=(48,20,24),CARD=(32,32,35),HDON=(18,18,20),HDOFF=(30,30,33),HTON=(255,255,255),HTOFF=(110,110,116),UL=(240,44,60),
           G1=(150,8,26),G2=(26,10,12),DIAG=True,BIGSUB=(230,190,194),RING=(255,255,255),RINGW=5,CHEV=(80,80,86)),
 # 極簡黑：黑白為主，紅色只用在重點
 "K3":dict(BG=(0,0,0),ACC=(230,0,30),TXT=(255,255,255),MUT=(120,120,126),TINT=None,ICON=(255,255,255),CARD=(18,18,19),CARDTOP=(230,0,30),HDON=(0,0,0),HDOFF=(14,14,15),HTON=(255,255,255),HTOFF=(90,90,96),UL=(230,0,30),
           G1=(230,0,30),G2=(230,0,30),BIGSUB=(255,205,210),RAD=40,CHEV=(230,0,30)),
 # 黑金紅：深灰卡片、紅色圓形圖示、紅框大按鈕
 "K4":dict(BG=(20,20,22),ACC=(220,20,40),TXT=(240,236,230),MUT=(150,140,128),TINT=(220,20,40),ICON=(255,255,255),TINTLINE=None,CARD=(34,33,35),CARDLINE=(54,52,54),HDON=(20,20,22),HDOFF=(34,33,35),HTON=(240,236,230),HTOFF=(110,104,98),UL=(200,160,90),
           G1=(26,25,27),G2=(26,25,27),BIGLINE=(220,20,40),BIGLW=6,BIGICON=(220,20,40),BIGSUB=(150,140,128),BIGBAR=(200,160,90),CHEV=(200,160,90)),
})
def use(name):
    globals().update(THEMES[name]); globals()["BLUE"]=ACC
use("K1")
import os; OUT=os.path.dirname(os.path.abspath(__file__))+"/"

def icon(d,kind,cx,cy,s,col,w):
    r=s/2
    L=lambda pts: d.line(pts,fill=col,width=w,joint="curve")
    def rr(x0,y0,x1,y1,rad): d.rounded_rectangle([x0,y0,x1,y1],radius=rad,outline=col,width=w)
    if kind=="clock":
        d.ellipse([cx-r,cy-r,cx+r,cy+r],outline=col,width=w); L([(cx,cy-r*.55),(cx,cy),(cx+r*.4,cy+r*.25)])
    elif kind=="list":
        for i,y in enumerate([-.5,0,.5]):
            yy=cy+y*r*1.4; d.ellipse([cx-r-w*.7,yy-w*.7,cx-r+w*.7,yy+w*.7],fill=col); L([(cx-r*.55,yy),(cx+r,yy)])
    elif kind=="cal":
        rr(cx-r,cy-r*.8,cx+r,cy+r,s*.12); L([(cx-r,cy-r*.25),(cx+r,cy-r*.25)])
        L([(cx-r*.45,cy-r*1.05),(cx-r*.45,cy-r*.55)]); L([(cx+r*.45,cy-r*1.05),(cx+r*.45,cy-r*.55)])
        for i in range(3):
            for j in range(2):
                x=cx-r*.5+i*r*.5; y=cy+r*.15+j*r*.45; d.ellipse([x-w*.6,y-w*.6,x+w*.6,y+w*.6],fill=col)
    elif kind=="grid":
        rr(cx-r,cy-r,cx+r,cy+r,s*.12); L([(cx-r,cy-r*.35),(cx+r,cy-r*.35)]); L([(cx-r*.35,cy-r*.35),(cx-r*.35,cy+r)])
    elif kind=="chart":
        L([(cx-r,cy-r),(cx-r,cy+r),(cx+r,cy+r)]); L([(cx-r*.55,cy+r*.3),(cx-r*.1,cy-r*.15),(cx+r*.25,cy+r*.15),(cx+r*.85,cy-r*.6)])
    elif kind=="money":
        rr(cx-r,cy-r*.6,cx+r,cy+r*.6,s*.1); d.ellipse([cx-r*.3,cy-r*.3,cx+r*.3,cy+r*.3],outline=col,width=w)
    elif kind=="users":
        d.ellipse([cx-r*.75,cy-r*.95,cx+r*.05,cy-r*.15],outline=col,width=w)
        d.arc([cx-r*1.1,cy+r*.05,cx+r*.4,cy+r*1.6],180,360,fill=col,width=w)
        d.arc([cx+r*.05,cy-r*.9,cx+r*.75,cy-r*.2],270,90,fill=col,width=w)
        d.arc([cx+r*.15,cy+r*.1,cx+r*1.1,cy+r*1.6],250,360,fill=col,width=w)
    elif kind=="tag":
        pts=[(cx-r,cy-r),(cx+r*.1,cy-r),(cx+r,cy-r*.1),(cx-r*.1,cy+r),(cx-r,cy+r*.1),(cx-r,cy-r)]; L(pts)
        d.ellipse([cx-r*.55-w*.7,cy-r*.55-w*.7,cx-r*.55+w*.7,cy-r*.55+w*.7],fill=col)
    elif kind=="leave":
        rr(cx-r,cy-r*.8,cx+r,cy+r,s*.12); L([(cx-r,cy-r*.25),(cx+r,cy-r*.25)])
        L([(cx-r*.45,cy-r*1.05),(cx-r*.45,cy-r*.55)]); L([(cx+r*.45,cy-r*1.05),(cx+r*.45,cy-r*.55)])
        L([(cx-r*.4,cy+r*.4),(cx+r*.4,cy+r*.4)])
    elif kind=="check":
        L([(cx-r*.45,cy-r*.05),(cx-r*.05,cy+r*.35),(cx+r*.95,cy-r*.75)])
        d.arc([cx-r,cy-r,cx+r,cy+r],40,330,fill=col,width=w)
    elif kind=="team":
        rr(cx-r,cy-r*.8,cx+r,cy+r,s*.12); L([(cx-r,cy-r*.25),(cx+r,cy-r*.25)])
        for i,x in enumerate([-.45,.15]):
            d.ellipse([cx+x*r,cy+r*.05,cx+(x+.3)*r,cy+r*.35],outline=col,width=max(4,w//2))
        L([(cx-r*.55,cy+r*.7),(cx+r*.55,cy+r*.7)])

def center(d,text,cx,cy,font,col):
    b=d.textbbox((0,0),text,font=font); d.text((cx-(b[2]-b[0])/2-b[0],cy-(b[3]-b[1])/2-b[1]),text,font=font,fill=col)

def header(d,mode):
    d.rectangle([0,0,W,HD],fill=HDON)
    if mode is None:
        center(d,"打卡系統",W/2,HD/2,f(BOLD,96),HTON or TXT); return
    tabs=[("我要打卡","emp"),("管理員","admin")]
    for i,(t,k) in enumerate(tabs):
        x0=i*W/2; on=(k==mode)
        d.rectangle([x0,0,x0+W/2,HD],fill=HDON if on else HDOFF)
        center(d,t,x0+W/4,HD/2-6,f(BOLD,92),(HTON or ACC) if on else HTOFF)
        if on: d.rounded_rectangle([x0+W/4-130,HD-26,x0+W/4+130,HD-10],radius=8,fill=globals().get("UL") or ACC)

G=lambda k,dflt=None: globals().get(k,dflt)
def glow(img,cx,cy,rad,col,alpha):
    from PIL import ImageFilter
    lay=Image.new("RGBA",img.size,(0,0,0,0)); ImageDraw.Draw(lay).ellipse([cx-rad,cy-rad,cx+rad,cy+rad],fill=col+(alpha,))
    lay=lay.filter(ImageFilter.GaussianBlur(rad*.45)); img.paste(lay,(0,0),lay)

def tile(img,d,x0,y0,x1,y1,kind,title,sub,big=False,row=False):
    m=18; R=G("RAD",50)
    if big:
        bw,bh=int(x1-x0-2*m),int(y1-y0-2*m)
        g=Image.new("RGB",(bw,bh)); gd=ImageDraw.Draw(g)
        diag=G("DIAG",False)
        if diag:
            for y in range(bh):
                for x in range(0,bw,4):
                    t=min(1,max(0,(x*.35+y)/(bw*.35+bh)))
                    gd.line([(x,y),(x+4,y)],fill=tuple(int(G1[k]+(G2[k]-G1[k])*t) for k in range(3)))
        else:
            for y in range(bh):
                t=y/bh; gd.line([(0,y),(bw,y)],fill=tuple(int(G1[k]+(G2[k]-G1[k])*t) for k in range(3)))
        mask=Image.new("L",g.size,0); ImageDraw.Draw(mask).rounded_rectangle([0,0,bw-1,bh-1],radius=R+10,fill=255)
        img.paste(g,(int(x0+m),int(y0+m)),mask)
        d=ImageDraw.Draw(img)
        if G("BIGLINE"): d.rounded_rectangle([x0+m,y0+m,x1-m,y1-m],radius=R+10,outline=BIGLINE,width=G("BIGLW",4))
        cx=(x0+x1)/2; cy=(y0+y1)/2
        if G("GLOW"): glow(img,int(cx),int(cy-150),G("GLOWR",260),GLOW,G("GLOWA",150)); d=ImageDraw.Draw(img)
        if G("RING"): d.ellipse([cx-215,cy-365,cx+215,cy+65],outline=RING,width=G("RINGW",6))
        fg=G("BIGFG") or (255,255,255)
        icon(d,kind,cx,cy-150,330 if not G("RING") else 290,G("BIGICON") or fg,30 if not G("RING") else 26)
        center(d,title,cx,cy+150,f(BOLD,130),fg)
        if G("BIGBAR"): d.rounded_rectangle([cx-50,cy+252,cx+50,cy+259],radius=4,fill=BIGBAR)
        center(d,sub,cx,cy+(325 if G("BIGBAR") else 290),f(MED,62),BIGSUB); return
    d.rounded_rectangle([x0+m,y0+m,x1-m,y1-m],radius=R,fill=CARD,outline=G("CARDLINE"),width=3 if G("CARDLINE") else 0)
    if G("CARDTOP"): d.rounded_rectangle([x0+m+R,y0+m,x1-m-R,y0+m+5],radius=2,fill=CARDTOP)
    cx=(x0+x1)/2; cy=(y0+y1)/2
    ic=G("ICON") or ACC
    def ibg(ax,ay,rad,rr):
        if TINT: d.rounded_rectangle([ax-rad,ay-rad,ax+rad,ay+rad],radius=rr,fill=TINT,outline=G("TINTLINE"),width=3 if G("TINTLINE") else 0)
    if row:   # 橫式：圖示在左、文字在右
        ix=x0+190
        ibg(ix,cy,95,50)
        icon(d,kind,ix,cy,110,ic,14)
        tf=f(BOLD,84); d.text((ix+150,cy-62),title,font=tf,fill=TXT,anchor="lm")
        d.text((ix+152,cy+48),sub,font=f(MED,50),fill=MUT,anchor="lm")
        if G("CHEV"): d.line([(x1-m-110,cy-34),(x1-m-76,cy),(x1-m-110,cy+34)],fill=CHEV,width=10,joint="curve")
        return
    ibg(cx,cy-100,115,60)
    icon(d,kind,cx,cy-100,130,ic,16)
    center(d,title,cx,cy+95,f(BOLD,84),TXT)
    center(d,sub,cx,cy+185,f(MED,50),MUT)

def emp(mode,name):
    img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img); header(d,mode)
    tile(img,d,0,HD,W/2,H,"clock","我要打卡","上班・下班打卡",big=True)
    t=(H-HD)/3
    tile(img,d,W/2,HD,W,HD+t,"list","出勤紀錄","打卡與異常",row=True)
    tile(img,d,W/2,HD+t,W,HD+2*t,"cal","我的班表","月曆・週明細",row=True)
    tile(img,d,W/2,HD+2*t,W,H,"leave","我要請假","選班別請假",row=True)
    img.save(OUT+name,optimize=True)

def admin(name):
    img=Image.new("RGB",(W,H),BG); d=ImageDraw.Draw(img); header(d,"admin")
    items=[("check","簽核中心","請假・補打卡"),("grid","排班作業","每月班表"),("chart","出勤報表","打卡細項"),
           ("money","薪資計算","當月薪資"),("users","員工管理","人員・綁定"),("tag","班別設定","班別・地點")]
    cw=W/3; ch=(H-HD)/2
    for i,(k,t,s) in enumerate(items):
        x=(i%3)*cw; y=HD+(i//3)*ch; tile(img,d,x,y,x+cw,y+ch,k,t,s)
    img.save(OUT+name,optimize=True)

import sys
if len(sys.argv)>2:   # 預覽：python make_images.py 主題 輸出資料夾
    use(sys.argv[1]); OUT=sys.argv[2].rstrip("/")+"/"
    emp("emp","menu-admin-staff.png"); admin("menu-admin.png"); sys.exit()
emp(None,"menu-staff.png"); emp("emp","menu-admin-staff.png"); admin("menu-admin.png")
import os; print([ (n, os.path.getsize(OUT+n)//1024) for n in os.listdir(OUT)])
