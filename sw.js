// Service worker: deixa o saber.ia instalável e abrindo sem internet (os materiais já salvos).
// Página: rede primeiro (pega a versão nova), cache como reserva. Arquivos com ?v=, bibliotecas do CDN, fontes e
// amostras: cache primeiro (não mudam). A IA e o modelo da voz passam direto (a biblioteca da voz já guarda o modelo).
const CACHE = "saberia-v2";
const BASE = ["./", "manifest.webmanifest", "icone-192.png", "icone-512.png", "favicon.svg", "favicon-32.png",
  "marca/logo-principal.svg", "marca/logo-negativa.svg", "marca/simbolo-azul.svg", "marca/simbolo-azul-luz.svg",
  "fontes/Inter-Regular.woff2", "fontes/Inter-Medium.woff2", "fontes/Inter-SemiBold.woff2", "fontes/Inter-Bold.woff2",
  "amostras/pf_dora.mp3", "amostras/pm_alex.mp3", "amostras/pm_santa.mp3"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE))); self.skipWaiting(); });
// ao ativar, apaga só os caches antigos deste service worker ("leitor-v1", "saberia-v1"...); o cache do modelo da voz fica
self.addEventListener("activate", (e) => e.waitUntil(caches.keys()
  .then((ks) => Promise.all(ks.filter((k) => k !== CACHE && /^(leitor|saberia)-v\d+$/.test(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.hostname === "generativelanguage.googleapis.com" || url.hostname.endsWith("huggingface.co") || url.hostname.endsWith("hf.co")) return;
  const pagina = req.mode === "navigate" || (url.origin === location.origin && /(\/|\.html)$/.test(url.pathname));
  if (pagina) {
    e.respondWith(fetch(req).then((r) => { const copia = r.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); return r; })
      .catch(() => caches.match(req).then((r) => r || caches.match("./"))));
    return;
  }
  e.respondWith(caches.match(req).then((r) => r || fetch(req).then((resp) => {
    if (resp.ok || resp.type === "opaque") { const copia = resp.clone(); caches.open(CACHE).then((c) => c.put(req, copia)); }
    return resp;
  })));
});
