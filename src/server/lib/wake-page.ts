/**
 * The "Waking up" page served by the panel for sleeping apps. Traefik routes
 * a sleeping app's public domain to the panel container (see
 * renderDynamicConfig), and the panel responds 503 with this HTML for any
 * request whose Host header matches a sleeping app (src/server/index.ts).
 *
 * The page hits `/api/apps/{id}/wake?token=...` on the panel to trigger a
 * background wake and then polls `/api/apps/{id}/wake-status` until the app
 * is running, reloading the tab once it is.
 */
export function wakePageHtml(panelOrigin: string, appId: number, wakeToken: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Waking up...</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;color:#e5e5e5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.c{text-align:center}
.spinner{width:24px;height:24px;border:3px solid #333;border-top-color:#e5e5e5;border-radius:50%;animation:spin 0.8s linear infinite;margin:0 auto 16px}
@keyframes spin{to{transform:rotate(360deg)}}
h1{font-size:14px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:8px}
p{font-size:11px;color:#888}
a{color:#888}
</style>
</head>
<body>
<div class="c">
<div class="spinner"></div>
<h1>Waking up</h1>
<p>This app is sleeping. Starting a container...</p>
<noscript><p style="margin-top:12px"><a href="${panelOrigin}">Open dashboard</a></p></noscript>
</div>
<script>
(function(){
  var P="${panelOrigin}",ID=${appId},T="${wakeToken}",n=0;
  if(!P)return;
  var h=document.querySelector("h1"),p=document.querySelector("p"),sp=document.querySelector(".spinner");
  function fail(msg){clearInterval(iv);if(sp)sp.style.display="none";h.textContent="Error";p.innerHTML=msg+' <a href="'+P+'">Open dashboard</a>';}
  fetch(P+"/api/apps/"+ID+"/wake?token="+T,{method:"POST",mode:"cors"}).catch(function(){});
  function tryReload(attempts){
    fetch(location.href,{method:"HEAD",cache:"no-store",redirect:"follow"}).then(function(r){
      if(r.status!==503){window.location.replace(location.href.split("?")[0]+"?_t="+Date.now())}
      else if(attempts>0){setTimeout(function(){tryReload(attempts-1)},1000)}
      else{window.location.replace(location.href.split("?")[0]+"?_t="+Date.now())}
    }).catch(function(){if(attempts>0){setTimeout(function(){tryReload(attempts-1)},1000)}else{location.reload()}});
  }
  var iv=setInterval(function(){
    if(++n>60){clearInterval(iv);if(sp)sp.style.display="none";h.textContent="Timeout";p.innerHTML='App did not wake within 2 minutes. <a href="'+P+'">Open dashboard</a>';return}
    fetch(P+"/api/apps/"+ID+"/wake-status?token="+T,{mode:"cors"})
      .then(function(r){return r.json()})
      .then(function(d){
        if(d.status==="running"){clearInterval(iv);p.textContent="Ready! Reloading...";tryReload(10)}
        if(d.status==="error"){fail("App failed to start. ")}
      })
      .catch(function(){});
  },2000);
})();
</script>
</body>
</html>`;
}

/**
 * If the request's Host header belongs to a sleeping/waking app, build the
 * 503 wake-page response for it; otherwise return null. Traefik points a
 * sleeping app's public domain at the panel, so any path/method can land
 * here — the wake page's own HEAD polling relies on the 503 status.
 */
export function wakePageResponse(
  request: Request,
  deps: {
    getAppByDomain: (domain: string) => { id: number; status: string; wake_token: string | null } | null;
    getPanelDomain: () => string;
  },
): Response | null {
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase() || "";
  if (!host) return null;
  const app = deps.getAppByDomain(host);
  if (!app || !app.wake_token) return null;
  if (app.status !== "sleeping" && app.status !== "waking") return null;
  const panelDomain = deps.getPanelDomain();
  const panelOrigin = panelDomain ? `https://${panelDomain}` : "";
  return new Response(wakePageHtml(panelOrigin, app.id, app.wake_token), {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Retry-After": "30",
    },
  });
}
