"""Render synthetic Korean bank/card transaction-history screens and their ground truth."""
import html
import json
import subprocess
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
SET = sys.argv[2] if len(sys.argv) > 2 else "base"
OUT.mkdir(parents=True, exist_ok=True)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Each screen: style + groups of (date header or None, rows). A row: merchant, amount, detail line, right column.
SCREENS = {
    "s1_light_twocol": {
        "theme": "light",
        "title": "입출금 내역",
        "groups": [
            ("10월 3일 금요일", [
                ("스타벅스 강남R점", "-6,500원", "14:12 · 체크카드", "1,182,700원"),
                ("GS25 역삼힐스점", "-3,200원", "12:40 · 체크카드", "1,189,200원"),
                ("김민지", "+25,000원", "11:05 · 입금", "1,192,400원"),
            ]),
            ("10월 2일 목요일", [
                ("맥도날드 강남역DT점", "-8,900원", "21:33 · 체크카드", "1,167,400원"),
                ("쿠팡(주)", "-34,560원", "09:12 · 체크카드", "1,176,300원"),
            ]),
        ],
    },
    "s2_card_dated_rows": {
        "theme": "light",
        "title": "이용내역",
        "groups": [
            (None, [
                ("올리브영 명동본점", "27,800원", "26. 10. 13 (화) · 일시불", ""),
                ("곱창이야기 홍대점", "86,000원", "26. 10. 12 (월) · 할부 3개월", ""),
                ("(주)코리아세븐", "4,700원", "26. 10. 12 (월) · 일시불", ""),
                ("커피빈 판교H스퀘어점", "5,300원", "26. 10. 11 (일) · 결제취소", ""),
                ("네이버페이 결제", "19,900원", "26. 10. 10 (토) · 일시불", ""),
            ]),
        ],
    },
    "s3_dark_bank": {
        "theme": "dark",
        "title": "거래내역조회",
        "groups": [
            ("2026.10.21", [
                ("카카오T 택시", "-12,300원", "출금 · 08:47", "잔액 532,180원"),
                ("SK텔레콤 통신요금", "-55,000원", "자동이체 · 07:00", "잔액 544,480원"),
                ("예금이자", "+1,214원", "이자 · 00:01", "잔액 599,480원"),
            ]),
            ("2026.10.20", [
                ("이마트24 신논현점", "-2,600원", "출금 · 23:58", "잔액 598,266원"),
                ("박서준", "+100,000원", "입금 · 19:20", "잔액 600,866원"),
            ]),
        ],
    },
    "s4_dense_gray": {
        "theme": "dense",
        "title": "카드 결제내역",
        "groups": [
            ("10월 25일 일요일", [
                ("쿠팡(주)-쿠팡이츠 서울특별시강남구", "-23,400원", "19:02 · 신용 · 일시불", "누적 412,300원"),
                ("㈜우아한형제들 배달의민족", "-18,000원", "12:31 · 신용 · 일시불", "누적 388,900원"),
                ("한국철도공사 KTX 서울-부산", "-59,800원", "07:15 · 신용 · 일시불", "누적 370,900원"),
            ]),
            ("10월 24일 토요일", [
                ("CU 신촌로터리점", "-1,800원", "23:11 · 체크 · 결제완료", "누적 311,100원"),
                ("교보문고 광화문점", "-32,400원", "15:47 · 신용 · 할부 2개월", "누적 309,300원"),
                ("다이소 홍대2호점", "-7,000원", "15:02 · 체크 · 결제취소", "누적 276,900원"),
            ]),
        ],
    },
    "s5_rare_hangul": {
        "theme": "light",
        "title": "결제 내역",
        "groups": [
            ("10월 18일 토요일", [
                ("뷁스베이커리 연남점", "-9,800원", "16:20 · 체크카드", "843,200원"),
                ("똠얌꿍타이 쌀국수", "-14,000원", "13:05 · 체크카드", "853,000원"),
                ("숯불닭갈비 춘천본점", "-41,000원", "19:44 · 체크카드", "867,000원"),
                ("왕십리곱창 뜰앞점", "-38,500원", "21:10 · 체크카드", "908,000원"),
                ("돐잔치떡집 쌍문점", "-22,000원", "10:31 · 체크카드", "946,500원"),
            ]),
        ],
    },
}

CSS = {
    "light": "body{background:#fff;color:#191f28} .detail{color:#8b95a1} .hdr{color:#4e5968}",
    "dark": "body{background:#17171c;color:#f2f2f7} .detail{color:#8e8e93} .hdr{color:#c7c7cc} .plus{color:#4f9dff}",
    "dense": "body{background:#fff;color:#222} .detail{color:#a0a7b0} .hdr{color:#666} .row{padding:9px 0!important} .m{font-size:14px!important} .a{font-size:14px!important} .detail{font-size:11px!important}",
}


def render(name, spec):
    parts = [f'<h1>{html.escape(spec["title"])}</h1>']
    gt = []
    for header, rows in spec["groups"]:
        if header:
            parts.append(f'<div class="hdr">{html.escape(header)}</div>')
        for merchant, amount, detail, right in rows:
            plus = " plus" if amount.startswith("+") else ""
            parts.append(
                '<div class="row">'
                f'<div class="line"><span class="m">{html.escape(merchant)}</span>'
                f'<span class="a{plus}">{html.escape(amount)}</span></div>'
                f'<div class="line detail"><span>{html.escape(detail)}</span><span>{html.escape(right)}</span></div>'
                "</div>"
            )
            gt.append({"header": header, "merchant": merchant, "amount": amount, "detail": detail, "right": right})
    doc = f"""<!doctype html><meta charset="utf-8"><style>
    *{{margin:0;padding:0;box-sizing:border-box}}
    body{{font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;width:393px;padding:24px 20px}}
    h1{{font-size:22px;font-weight:700;margin-bottom:22px}}
    .hdr{{font-size:13px;font-weight:600;margin:22px 0 6px}}
    .row{{padding:14px 0}}
    .line{{display:flex;justify-content:space-between;gap:12px}}
    .m{{font-size:16px;font-weight:600}} .a{{font-size:16px;font-weight:700;white-space:nowrap}}
    .detail{{font-size:13px;margin-top:4px}}
    {CSS[spec["theme"]]}
    </style><body>{''.join(parts)}</body>"""
    page = OUT / f"{name}.html"
    page.write_text(doc)
    height = 120 + 32 * len(spec["groups"]) + 70 * len(gt)
    subprocess.run(
        [CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
         "--force-device-scale-factor=3", f"--window-size=393,{height}",
         f"--screenshot={OUT / (name + '.png')}", page.as_uri()],
        check=True, capture_output=True,
    )
    return gt


if SET == "real":
    from screens_real import SCREENS
truth = {name: render(name, spec) for name, spec in SCREENS.items()}
(OUT / "truth.json").write_text(json.dumps(truth, ensure_ascii=False, indent=1))
(OUT / "titles.json").write_text(json.dumps({n: s["title"] for n, s in SCREENS.items()}, ensure_ascii=False))
print("\n".join(sorted(p.name for p in OUT.glob("*.png"))))
