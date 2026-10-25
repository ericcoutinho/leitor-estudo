// Leitor de Estudo (versão web, sem servidor): extrai o texto do arquivo, a IA (Gemini, chave do próprio usuário)
// organiza em tópicos e a voz Kokoro lê no aparelho (voz-worker.js). Materiais ficam salvos neste navegador.
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { paraFala } from "./texto.js";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const $ = (s) => document.querySelector(s);
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSA = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
const lembrar = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---------- extração e limpeza do texto ----------
async function extrair(arquivo) {
  const nome = arquivo.name.toLowerCase(), dados = await arquivo.arrayBuffer();
  if (nome.endsWith(".pdf")) {
    const pdf = await pdfjs.getDocument({ data: dados }).promise, paginas = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const c = await (await pdf.getPage(i)).getTextContent();
      paginas.push(c.items.map((it) => it.str + (it.hasEOL ? "\n" : "")).join(""));
    }
    return paginas.join("\n\n");
  }
  if (nome.endsWith(".docx")) return (await window.mammoth.extractRawText({ arrayBuffer: dados })).value;
  return new TextDecoder().decode(dados);
}
// junta as linhas de um mesmo parágrafo do PDF; linha curta (título) vira parágrafo próprio
const limpar = (t) => t.replace(/\r/g, "").replace(/-\n(\p{L})/gu, "$1").replace(/^([^\n]{1,70})\n(?!\n)/gm, "$1\n\n")
  .replace(/(?<![.!?:;\n])\n(?!\n)/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
function blocos(texto, tamanho) {
  const saida = []; let atual = "";
  for (const par of texto.split("\n\n")) {
    if (atual.length + par.length > tamanho && atual) { saida.push(atual); atual = ""; }
    atual += par + "\n\n";
  }
  return atual.trim() ? [...saida, atual] : saida;
}

// ---------- IA que organiza (Gemini com a chave do usuário) ----------
const INSTRUCAO = `Você prepara material de estudo para ser OUVIDO (vai ser lido em voz alta por uma voz sintética).
Organize o trecho abaixo em tópicos, na ordem lógica do conteúdo. Regras:
- NÃO corte informação que possa cair numa prova: definições, números, datas, nomes, listas, exceções.
- Reescreva em frases curtas e claras, em português do Brasil, como um professor explicando.
- Explique termos técnicos e siglas na primeira vez que aparecem.
- Nada de tabelas, marcadores, asteriscos ou emojis: só texto corrido para ouvir. Listas viram frases ("São três tipos: primeiro..., segundo..., terceiro...").
- Para cada tópico: um resumo de 1 a 3 frases e de 1 a 3 perguntas de revisão com resposta curta.
- Mantenha termos em inglês (ou outra língua estrangeira) escritos no original no texto, e liste em "pronuncia" cada um
  com a grafia aportuguesada de como um brasileiro fala, para a voz ler certo. Ex.: {"software":"sófituer","feedback":"fidbéc",
  "compliance":"complaiâns","home office":"rôum ófis"}. Siglas em inglês lidas letra a letra também: {"CEO":"ci í ôu"}.
Responda SOMENTE com JSON válido neste formato:
{"topicos":[{"titulo":"...","texto":"...","resumo":"...","perguntas":[{"pergunta":"...","resposta":"..."}]}],"pronuncia":{}}`;
const MODELOS = ["gemini-flash-lite-latest", "gemini-flash-latest"];

async function organizar(trecho, chave) {
  const erros = [];
  for (const modelo of MODELOS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: INSTRUCAO + "\n\nTRECHO:\n" + trecho }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) {
      try {
        const bruto = j.candidates[0].content.parts[0].text;
        const o = JSON.parse(bruto.slice(bruto.indexOf("{"), bruto.lastIndexOf("}") + 1));
        return { topicos: o.topicos, pronuncia: o.pronuncia || {} };
      } catch { erros.push(`${modelo}: resposta fora do formato`); continue; }
    }
    if (r.status === 400 || r.status === 403) throw new Error("a chave do Gemini não foi aceita; confira em “Chave da IA”");
    erros.push(r.status === 429 ? `${modelo}: cota grátis do dia acabou` : `${modelo}: erro ${r.status}`);
  }
  throw new Error(erros.join("; ") + ". Tente mais tarde ou desmarque “Organizar com IA”.");
}

function soLer(texto) {
  return blocos(texto, 3000).map((t, i) => ({ titulo: `Parte ${i + 1}`, texto: t.trim(), resumo: "", perguntas: [] }));
}

// ---------- materiais salvos neste navegador ----------
const indice = () => lembrar("estudos", []);
function salvarEstudo(e) {
  if (!guardar("estudo:" + e.id, e)) throw new Error("o navegador não deixou salvar (espaço cheio ou modo anônimo)");
  guardar("estudos", [{ id: e.id, titulo: e.titulo, criado: e.criado, organizado_por: e.organizado_por, topicos: e.topicos.length }, ...indice()]);
}

async function enviar(arquivo) {
  if (!arquivo) return;
  const st = $("#estado"); st.className = "estado";
  try {
    st.textContent = "Lendo o arquivo…";
    const texto = limpar(await extrair(arquivo));
    if (texto.length < 50) throw new Error("não achei texto no arquivo (PDF escaneado? precisa de OCR)");
    const chave = $("#chave").value.trim();
    const usarIa = $("#usarIa").checked && chave;
    let topicos = [], pron = {};
    if (usarIa) {
      const partes = blocos(texto, 12000);
      for (let i = 0; i < partes.length; i++) {
        st.textContent = `Organizando parte ${i + 1} de ${partes.length}…`;
        const o = await organizar(partes[i], chave);
        topicos.push(...o.topicos); Object.assign(pron, o.pronuncia);
      }
    } else topicos = soLer(texto);
    const agora = new Date();
    const estudo = { id: String(agora.getTime()), titulo: arquivo.name.replace(/\.[^.]+$/, ""),
      criado: agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
      organizado_por: usarIa ? "Gemini" : "sem IA", topicos, pronuncia: pron };
    salvarEstudo(estudo);
    st.textContent = $("#usarIa").checked && !chave ? "Sem chave do Gemini: o material foi aberto como está." : "";
    carregarLista(); abrir(estudo.id);
  } catch (e) { st.className = "estado erro"; st.textContent = "Erro: " + e.message; }
}
$("#arquivo").onchange = (e) => { enviar(e.target.files[0]); e.target.value = ""; };
const envio = $("#envio");
envio.ondragover = (e) => { e.preventDefault(); envio.classList.add("arrastando"); };
envio.ondragleave = () => envio.classList.remove("arrastando");
envio.ondrop = (e) => { e.preventDefault(); envio.classList.remove("arrastando"); enviar(e.dataTransfer.files[0]); };
$("#chave").value = lembrar("chave", "");
$("#chave").onchange = () => guardar("chave", $("#chave").value.trim());
if (!$("#chave").value) $("#config").open = true;

function carregarLista() {
  const lista = indice();
  $("#lista").innerHTML = lista.length ? '<div class="rotulo">Seus materiais</div>' + lista.map((e) =>
    `<button class="item ${estudo?.id === e.id ? "ativo" : ""}" data-id="${esc(e.id)}"><b>${esc(e.titulo)}</b><small>${e.topicos} tópicos · ${esc(e.criado)} · ${esc(e.organizado_por)}</small></button>`).join("") : "";
  document.querySelectorAll(".item").forEach((b) => (b.onclick = () => abrir(b.dataset.id)));
}

// ---------- voz ----------
const worker = new Worker(new URL("./voz-worker.js", import.meta.url), { type: "module" });
let vozPronta = null, pedidos = new Map(), seq = 0;
worker.onmessage = ({ data }) => {
  if (data.tipo === "progresso") $("#vozTexto").textContent = `Baixando a voz… ${data.pct}% (só na primeira vez)`;
  if (data.tipo === "pronto") {
    $("#vozEstado").classList.add("ok");
    $("#vozTexto").textContent = data.device === "webgpu" ? "Voz pronta (placa de vídeo)" : "Voz pronta (processador: pode pausar entre frases)";
    vozPronta.ok();
  }
  if (data.tipo === "audio") { pedidos.get(data.id)?.ok(URL.createObjectURL(new Blob([data.buf], { type: "audio/wav" }))); pedidos.delete(data.id); }
  if (data.tipo === "erro") {
    if (data.id != null) { pedidos.get(data.id)?.falha(new Error(data.msg)); pedidos.delete(data.id); }
    else { $("#vozTexto").textContent = "A voz não carregou: " + data.msg; vozPronta?.falha(new Error(data.msg)); }
  }
};
function carregarVoz() {
  if (!vozPronta) {
    let ok, falha; const p = new Promise((a, b) => { ok = a; falha = b; });
    vozPronta = { p, ok, falha };
    $("#vozTexto").textContent = "Preparando a voz…";
    worker.postMessage({ tipo: "carregar" });
  }
  return vozPronta.p;
}
async function sintetizar(texto) {
  await carregarVoz();
  const id = ++seq;
  return new Promise((ok, falha) => {
    pedidos.set(id, { ok, falha });
    worker.postMessage({ tipo: "falar", id, texto: paraFala(texto, estudo?.pronuncia), voz: $("#voz").value, vel: +$("#vel").value });
  });
}

// ---------- montar o tópico ----------
let estudo = null, topico = 0, fila = [], pos = 0, tocando = false, espera = null;
const audio = new Audio();
const pre = new Map();
// cada parágrafo começa frase nova (títulos sem ponto não grudam no texto seguinte)
const frases = (t) => (t || "").split(/\n\s*\n/).flatMap((par) =>
  par.replace(/\s+/g, " ").trim().split(/(?<=[.!?…:;])\s+(?=[A-ZÁÉÍÓÚÂÊÔÃÕÇ0-9"“(])/)).filter(Boolean);
const limparPre = () => { pre.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {})); pre.clear(); };

function abrir(id) {
  parar();
  estudo = lembrar("estudo:" + id, null);
  if (!estudo) return;
  const salvo = lembrar("pos:" + id, { topico: 0, pos: 0 });
  montar(salvo.topico, salvo.pos);
  carregarLista();
  carregarVoz().catch(() => {});
}

function montar(t, p = 0) {
  topico = Math.max(0, Math.min(t, estudo.topicos.length - 1));
  const tp = estudo.topicos[topico];
  fila = []; limparPre();
  const span = (texto, tipo) => { fila.push({ texto, tipo }); return `<span class="frase" data-i="${fila.length - 1}">${esc(texto)}</span> `; };
  let html = `<div class="topicos">${estudo.topicos.map((x, i) => `<button class="chip ${i === topico ? "ativo" : i < topico ? "feito" : ""}" data-t="${i}">${i + 1}. ${esc(x.titulo)}</button>`).join("")}</div>`;
  html += `<h2 class="titulo">${span(tp.titulo, "titulo")}</h2><div class="texto">${(tp.texto || "").split(/\n\s*\n/).map((par) => `<p>${frases(par).map((f) => span(f)).join("")}</p>`).join("")}</div>`;
  if (tp.resumo) {
    fila.push({ texto: "Resumindo.", tipo: "aviso" });
    html += `<div class="cartao"><h3>Resumo</h3><div class="texto">${frases(tp.resumo).map((f) => span(f)).join("")}</div></div>`;
  }
  if (tp.perguntas?.length) {
    fila.push({ texto: "Hora de revisar.", tipo: "aviso" });
    html += `<div class="cartao"><h3>Perguntas de revisão</h3>${tp.perguntas.map((q, k) => {
      const pq = span(q.pergunta, "pergunta");
      fila.push({ tipo: "pensar", k });
      const r = span(q.resposta, "resposta");
      return `<div class="pergunta"><div class="p">${pq}</div><div class="pensar" id="pensar-${k}"></div><div class="r texto oculta">${r}</div></div>`;
    }).join("")}</div>`;
  }
  html += `<button class="apagar" id="apagar">Apagar este material</button>`;
  $("#coluna").innerHTML = html;
  document.querySelectorAll(".chip").forEach((c) => (c.onclick = () => { const t = tocando; parar(); montar(+c.dataset.t); if (t) tocar(); }));
  document.querySelectorAll(".frase").forEach((f) => (f.onclick = () => { parar(); ir(+f.dataset.i); tocar(); })); // tocar numa frase lê dali
  document.querySelectorAll(".r.oculta").forEach((r) => (r.onclick = () => r.classList.remove("oculta")));
  $("#apagar").onclick = () => {
    const b = $("#apagar");
    if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Clique de novo para confirmar"; return; }
    parar();
    try { localStorage.removeItem("estudo:" + estudo.id); localStorage.removeItem("pos:" + estudo.id); } catch {}
    guardar("estudos", indice().filter((e) => e.id !== estudo.id));
    estudo = null; $("#coluna").innerHTML = '<div class="vazio"><h2>Material apagado</h2></div>'; carregarLista();
  };
  ir(Math.min(p, fila.length - 1));
  $(".conteudo").scrollTop = 0;
}

function ir(i) {
  pos = Math.max(0, Math.min(i, fila.length - 1));
  document.querySelectorAll(".frase").forEach((f) => { const n = +f.dataset.i; f.classList.toggle("atual", n === pos); f.classList.toggle("lida", n < pos); });
  fila.forEach((it, n) => { if (it.tipo === "resposta" && n <= pos) document.querySelector(`[data-i="${n}"]`)?.closest(".r")?.classList.remove("oculta"); });
  document.querySelector(".frase.atual")?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (estudo) guardar("pos:" + estudo.id, { topico, pos });
}

function preparar(i) {
  const it = fila[i];
  if (!it || !it.texto) return null;
  if (!pre.has(i)) pre.set(i, sintetizar(it.texto));
  return pre.get(i);
}

let geracao = 0; // cada toque no ▶ abre uma leitura nova; a antiga para sozinha ao ver que não é mais a atual
async function tocar() {
  if (!estudo) return;
  if (espera) { const e = espera; espera = null; e(false); if (fila[pos]?.tipo === "pensar") pos++; }
  const g = ++geracao;
  const ativa = () => tocando && g === geracao;
  tocando = true; $("#tocar").innerHTML = PAUSA;
  while (ativa()) {
    const it = fila[pos];
    if (!it) {
      if (topico < estudo.topicos.length - 1) { montar(topico + 1); continue; }
      return parar();
    }
    ir(pos);
    if (it.tipo === "pensar") {
      const s = +$("#pensar").value;
      if (s !== 0) {
        const el = document.getElementById("pensar-" + it.k);
        const ok = await new Promise((fim) => {
          espera = fim;
          if (s < 0) { el.textContent = "Pense na resposta… toque ▶ para continuar."; tocando = false; $("#tocar").innerHTML = PLAY; return; }
          let r = s; el.textContent = `Pense na resposta… ${r}`;
          const tm = setInterval(() => { r--; el.textContent = r > 0 ? `Pense na resposta… ${r}` : ""; if (r <= 0) { clearInterval(tm); fim(true); } }, 1000);
          espera = (v) => { clearInterval(tm); fim(v); };
        });
        el.textContent = "";
        if (!ok || !ativa()) return;
        espera = null;
      }
      pos++; continue;
    }
    const atual = document.querySelector(".frase.atual");
    const p = preparar(pos);
    preparar(pos + 1); preparar(pos + 2);
    atual?.classList.add("gerando");
    let url;
    try { url = await p; } catch (e) { $("#vozTexto").textContent = "Erro na voz: " + e.message; return parar(); }
    finally { atual?.classList.remove("gerando"); }
    if (!ativa()) return;
    audio.src = url;
    await audio.play().catch(() => {});
    const terminou = await new Promise((fim) => { audio.onended = () => fim(true); audio.onpause = () => fim(audio.ended); });
    if (!terminou || !ativa()) return;
    pos++;
  }
}
function parar() {
  tocando = false; $("#tocar").innerHTML = PLAY; audio.onpause = null; audio.pause();
  if (espera) { espera(false); espera = null; }
}

$("#tocar").onclick = () => (tocando ? parar() : tocar());
const pular = (f) => () => { const t = tocando; parar(); f(); if (t) tocar(); };
$("#fraseAnt").onclick = pular(() => ir(pos - 1));
$("#fraseProx").onclick = pular(() => ir(pos + 1));
$("#topAnt").onclick = pular(() => estudo && montar(topico - 1));
$("#topProx").onclick = pular(() => estudo && montar(topico + 1));
document.onkeydown = (e) => {
  if (["SELECT", "INPUT"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); $("#tocar").click(); }
  if (e.code === "ArrowLeft") $("#fraseAnt").click();
  if (e.code === "ArrowRight") $("#fraseProx").click();
};
for (const id of ["voz", "vel", "pensar"]) {
  const v = lembrar(id, null); if (v !== null) $("#" + id).value = v;
  $("#" + id).onchange = () => { guardar(id, $("#" + id).value); limparPre(); };
}
carregarLista();
