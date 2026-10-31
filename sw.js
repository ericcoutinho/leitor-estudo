// Service worker: deixa o saber.ia instalável e abrindo sem internet (os materiais já salvos).
// Página: rede primeiro (pega a versão nova), cache como reserva. Arquivos com ?v=, bibliotecas do CDN, fontes e
// amostras: cache primeiro (não mudam). A IA e o modelo da voz passam direto (a biblioteca da voz já guarda o modelo).
const CACHE = "leitor-v1";
const BASE = ["./", "manifest.webmanifest", "icone-192.png", "icone-512.png", "amostras/pf_dora.mp3", "amostras/pm_alex.mp3", "amostras/pm_santa.mp3"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(BASE))); self.skipWaiting(); });
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
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
