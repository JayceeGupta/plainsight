// plainsight-gate: Cloudflare Worker in front of the dashboard tunnel (deployed by `plainsight cloudflare setup`).
// Cloudflare Access runs before this Worker, so only signed-in, allowed visitors get here.
// It passes every request through to the tunnel. If no machine is connected (Cloudflare answers
// 530 / error 1033) or the connector cannot reach plainsight (502-504), it shows a calm page that
// retries by itself instead of Cloudflare's error screen.
const DOWN = new Set([502, 503, 504, 530]);

export default {
  async fetch(request) {
    let res;
    try {
      res = await fetch(request);
    } catch {
      return down(request);
    }
    if (DOWN.has(res.status)) return down(request);
    return res;
  },
};

function down(request) {
  const headers = { 'cache-control': 'no-store', 'retry-after': '20' };
  if (new URL(request.url).pathname.startsWith('/api/')) {
    return Response.json({ error: 'no plainsight machine is online right now' }, { status: 503, headers });
  }
  return new Response(PAGE, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}

const PAGE = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000"><meta name="color-scheme" content="dark">
<title>plainsight</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 24 24%22%3E%3Cstyle%3E.m%7Bcolor:%23111%7D%40media (prefers-color-scheme:dark)%7B.m%7Bcolor:%23f5f5f5%7D%7D%3C/style%3E%3Cg class=%22m%22 fill=%22none%22 stroke-linecap=%22round%22%3E%3Cpath d=%22M4.93 19.57A10 10 0 1 1 19.07 19.57%22 stroke=%22currentColor%22 stroke-width=%222.4%22 opacity=%22.45%22/%3E%3Cpath d=%22M4.93 19.57A10 10 0 0 1 16.54 3.59%22 stroke=%22%23e8794a%22 stroke-width=%222.2%22/%3E%3Cpath d=%22M12 12.5L14.95 6.71%22 stroke=%22currentColor%22 stroke-width=%221.5%22/%3E%3Ccircle cx=%2212%22 cy=%2212.5%22 r=%221.9%22 fill=%22currentColor%22/%3E%3C/g%3E%3C/svg%3E">
<style>
  html,body{margin:0;height:100%;background:#000;color:#f5f5f5;font:15px/1.5 "Inter","Segoe UI",system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
  main{min-height:100%;display:grid;place-items:center;padding:24px}
  .box{max-width:440px}
  .brand{color:#8e8e8e;font-weight:600;margin-bottom:28px}
  h1{font-size:28px;letter-spacing:-.02em;margin:0 0 12px;display:flex;align-items:center;gap:12px}
  .dot{width:10px;height:10px;border-radius:50%;background:#5a5a5a;flex:none;animation:p 1.8s infinite}
  @keyframes p{50%{opacity:.3}}
  p{color:#8e8e8e;margin:0 0 10px}
  button{margin-top:22px;font:inherit;color:#f5f5f5;background:#1c1c1c;border:1px solid #262626;border-radius:10px;padding:9px 16px;cursor:pointer}
  button:hover{background:#262626}
  .faint{color:#5a5a5a;font-size:13px;margin-top:18px}
  @media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style></head>
<body><main><div class="box">
  <div class="brand">plainsight</div>
  <h1><span class="dot"></span>No machine is online</h1>
  <p>The dashboard is shown by whichever plainsight machine is on: your computer or any box. None of them is connected right now.</p>
  <p>Usage recorded while they were away is kept on the machines and shows up as soon as one comes back.</p>
  <button onclick="location.reload()">Try again</button>
  <div class="faint" id="t">Checking again in 20 s</div>
</div></main>
<script>
  let n = 20; const t = document.getElementById('t');
  setInterval(() => { n--; if (n <= 0) location.reload(); else t.textContent = 'Checking again in ' + n + ' s'; }, 1000);
</script>
</body></html>`;
