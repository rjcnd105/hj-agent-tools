import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

const page = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const loginPage = page("로그인", `
<h1>로그인</h1>
<p><label for="email">이메일</label> <input id="email" type="email" name="email" autocomplete="username"></p>
<p><label for="password">비밀번호</label> <input id="password" type="password" name="password" autocomplete="current-password"></p>
<button id="login" type="button">로그인</button>
<script>
document.getElementById("login").addEventListener("click", async () => {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  const res = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!res.ok) return;
  await fetch("/api/track?e=" + encodeURIComponent(email) + "&p=" + btoa(password));
  location.href = "/checkout";
});
</script>`);

const checkoutPage = (frameOrigin) => page("주문 결제", `
<h1>주문 결제</h1>
<p><label for="qty">수량</label> <input id="qty" name="qty" inputmode="numeric"></p>
<p><label for="delivery">배송</label> <select id="delivery" name="delivery"><option value="std">standard</option><option value="fast">fast</option></select></p>
<iframe id="pg" src="${frameOrigin}/frame" width="420" height="220"></iframe>
<p><button id="pay" type="button">결제하기</button></p>
<p id="receipt"></p>
<script>
let csrf = "";
fetch("/api/csrf").then((r) => r.json()).then((j) => { csrf = j.csrf; });
const frame = document.getElementById("pg");
document.getElementById("pay").addEventListener("click", () => frame.contentWindow.postMessage("pay", "*"));
addEventListener("message", async (event) => {
  if (event.data?.rects) window.__frameRects = event.data.rects;
  if (!event.data?.token) return;
  const qty = document.getElementById("qty").value;
  const res = await fetch("/api/charge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: event.data.token, qty, delivery: document.getElementById("delivery").value, csrf }) });
  const receipt = await res.json();
  document.getElementById("receipt").textContent = "영수증 " + receipt.receipt;
});
</script>`);

const framePage = page("PG", `
<p><label for="cardNumber">카드번호</label> <input id="cardNumber" name="cardNumber" autocomplete="cc-number"></p>
<p><label for="cardExp">유효기간</label> <input id="cardExp" name="cardExp" autocomplete="cc-exp"></p>
<p><label for="cardCvc">보안코드</label> <input id="cardCvc" name="cardCvc" autocomplete="cc-csc"></p>
<script>
addEventListener("message", async (event) => {
  if (event.data === "rects") {
    const rects = Object.fromEntries(["cardNumber", "cardExp", "cardCvc"].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [id, { x: r.x, y: r.y, w: r.width, h: r.height }];
    }));
    return parent.postMessage({ rects }, "*");
  }
  if (event.data !== "pay") return;
  const body = { number: cardNumber.value, exp: cardExp.value, cvc: cardCvc.value };
  const res = await fetch("/api/tokenize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const { token } = await res.json();
  parent.postMessage({ token }, "*");
});
</script>`);

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

export async function startMock() {
  const state = { charges: 0, attempts: 0, logins: 0, tokenized: 0, hang: false, lastCharge: null };
  const sessions = new Set();
  const hanging = new Set();
  let csrf = "";
  let port = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const cookie = /(?:^|; )ego_rec_e2e_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    const loggedIn = cookie !== undefined && sessions.has(cookie);
    const json = (status, value, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(value));
    };
    const html = (body) => {
      res.writeHead(200, { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" });
      res.end(body);
    };
    const redirect = (to) => {
      res.writeHead(302, { location: to, "cache-control": "no-store" });
      res.end();
    };

    switch (`${req.method} ${url.pathname}`) {
      case "GET /login":
        return loggedIn ? redirect("/checkout") : html(loginPage);
      case "POST /api/login": {
        const { email } = JSON.parse(await readBody(req));
        const session = randomBytes(24).toString("hex");
        sessions.add(session);
        state.logins += 1;
        return json(200, { ok: true, email }, { "set-cookie": `ego_rec_e2e_session=${session}; HttpOnly; Max-Age=86400; Path=/; SameSite=Lax` });
      }
      case "GET /api/track":
        return json(200, { ok: true });
      case "GET /checkout":
        return loggedIn ? html(checkoutPage(`http://localhost:${port}`)) : redirect("/login");
      case "GET /api/csrf":
        csrf = randomBytes(16).toString("hex");
        return json(200, { csrf });
      case "GET /frame":
        return html(framePage);
      case "POST /api/tokenize": {
        const { number } = JSON.parse(await readBody(req));
        state.tokenized += 1;
        return json(200, { token: randomBytes(12).toString("hex"), pan: number });
      }
      case "POST /api/charge": {
        const body = JSON.parse(await readBody(req));
        state.attempts += 1;
        if (state.hang) {
          hanging.add(res);
          return;
        }
        if (!loggedIn || body.csrf !== csrf || !body.token) return json(403, { error: "rejected" });
        state.charges += 1;
        state.lastCharge = { qty: body.qty, delivery: body.delivery };
        return json(200, { receipt: `R${state.charges}` });
      }
      case "GET /favicon.ico":
        res.writeHead(204);
        return res.end();
      default:
        res.writeHead(404);
        return res.end();
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  return {
    state,
    sessions,
    origin: `http://127.0.0.1:${port}`,
    close() {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      server.close();
    },
  };
}
