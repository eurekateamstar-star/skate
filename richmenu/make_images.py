from PIL import Image, ImageDraw, ImageFont
import math
W,H=2500,1686; HD=250
BOLD="/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"; MED="/usr/share/fonts/opentype/noto/NotoSansCJK-Medium.ttc"
f=lambda p,s: ImageFont.truetype(p,s,index=2)  # TC
BG=(245,245,247); BLUE=(0,113,227); TXT=(29,29,31); MUT=(134,134,139); TINT=(230,240,252)
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
    d.rectangle([0,0,W,HD],fill=(255,255,255))
    if mode is None:
        center(d,"打卡系統",W/2,HD/2,f(BOLD,96),TXT); return
    tabs=[("我要打卡","emp"),("管理員","admin")]
    for i,(t,k) in enumerate(tabs):
        x0=i*W/2; on=(k==mode)
        d.rectangle([x0,0,x0+W/2,HD],fill=(255,255,255) if on else (233,233,238))
        center(d,t,x0+W/4,HD/2-6,f(BOLD,92),BLUE if on else MUT)
        if on: d.rounded_rectangle([x0+W/4-130,HD-26,x0+W/4+130,HD-10],radius=8,fill=BLUE)

def tile(img,d,x0,y0,x1,y1,kind,title,sub,big=False,row=False):
    m=18
    if big:
        g=Image.new("RGB",(int(x1-x0-2*m),int(y1-y0-2*m)))
        gd=ImageDraw.Draw(g)
        for y in range(g.height):
            t=y/g.height; gd.line([(0,y),(g.width,y)],fill=(int(41+(0-41)*t),int(151+(113-151)*t),int(255+(227-255)*t)))
        mask=Image.new("L",g.size,0); ImageDraw.Draw(mask).rounded_rectangle([0,0,g.width-1,g.height-1],radius=60,fill=255)
        img.paste(g,(int(x0+m),int(y0+m)),mask)
        cx=(x0+x1)/2; cy=(y0+y1)/2
        icon(d,kind,cx,cy-150,330,(255,255,255),30)
        center(d,title,cx,cy+150,f(BOLD,130),(255,255,255))
        center(d,sub,cx,cy+290,f(MED,62),(220,236,255)); return
    d.rounded_rectangle([x0+m,y0+m,x1-m,y1-m],radius=50,fill=(255,255,255))
    cx=(x0+x1)/2; cy=(y0+y1)/2
    if row:   # 橫式：圖示在左、文字在右
        ix=x0+190
        d.rounded_rectangle([ix-95,cy-95,ix+95,cy+95],radius=50,fill=TINT)
        icon(d,kind,ix,cy,110,BLUE,14)
        tf=f(BOLD,84); d.text((ix+150,cy-62),title,font=tf,fill=TXT,anchor="lm")
        d.text((ix+152,cy+48),sub,font=f(MED,50),fill=MUT,anchor="lm"); return
    s=min(x1-x0,y1-y0)
    d.rounded_rectangle([cx-115,cy-215,cx+115,cy+15],radius=60,fill=TINT)
    icon(d,kind,cx,cy-100,130,BLUE,16)
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

emp(None,"menu-staff.png"); emp("emp","menu-admin-staff.png"); admin("menu-admin.png")
import os; print([ (n, os.path.getsize(OUT+n)//1024) for n in os.listdir(OUT)])
