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
// PDF costuma guardar "ç" e "ã" em pedaços: letra + sinal combinado, ou sinal solto antes/depois da letra
// (PDF de LaTeX: "Identifica¸c˜ao"). A tela junta, mas a voz lê só a letra — aqui vira "ç"/"ã" de verdade.
const SINAIS = [["¸", "̧", "cC"], ["˜", "̃", "aoAO"], ["´", "́", "aeiouAEIOU"],
  ["ˆ", "̂", "aeoAEO"], ["ˋ", "̀", "aA"], ["¨", "̈", "uU"]];
const acentos = (t) => SINAIS.reduce((s, [solto, comb, letras]) => s
  .replace(new RegExp(`${solto} ?([${letras}])`, "g"), `$1${comb}`)   // sinal antes da letra (LaTeX)
  .replace(new RegExp(`([${letras}]) ?${solto}`, "g"), `$1${comb}`), t).normalize("NFC");
// junta as linhas de um mesmo parágrafo do PDF; linha curta (título) vira parágrafo próprio
const limpar = (t) => acentos(t).replace(/\r/g, "").replace(/-\n(\p{L})/gu, "$1").replace(/^([^\n]{1,70})\n(?!\n)/gm, "$1\n\n")
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
const ESPERAS = [5, 15, 30, 60]; // segundos entre as tentativas quando o Gemini está ocupado (503) ou no limite por minuto
const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));

// lê o motivo do erro do Gemini: chave recusada, cota do DIA acabou (não adianta repetir) ou espera sugerida
function motivo(status, j) {
  const det = j?.error?.details || [];
  const quota = det.find((d) => d["@type"]?.endsWith("QuotaFailure"))?.violations?.map((v) => v.quotaId).join(" ") || "";
  const espera = parseFloat(det.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay) || 0;
  if (status === 400 || status === 403) return { fatal: "a chave do Gemini não foi aceita; confira em “Chave da IA”" };
  if (status === 429 && /PerDay/i.test(quota)) return { dia: true, texto: "a cota grátis do dia acabou" };
  if (status === 429) return { espera, texto: "limite de pedidos por minuto" };
  if (status >= 500) return { espera, texto: status === 503 ? "o Gemini está sobrecarregado" : `erro ${status} no Gemini` };
  return { espera, texto: `erro ${status}` };
}

async function organizar(trecho, chave, aviso) {
  const esgotados = new Set();
  let ultimo = "";
  for (let tentativa = 0; tentativa <= ESPERAS.length; tentativa++) {
    let espera = 0;
    for (const modelo of MODELOS.filter((m) => !esgotados.has(m))) {
      let r, j;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: INSTRUCAO + "\n\nTRECHO:\n" + trecho }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
        });
        j = await r.json().catch(() => ({}));
      } catch { ultimo = "sem conexão com o Gemini"; continue; }
      if (r.ok) {
        try {
          const bruto = j.candidates[0].content.parts[0].text;
          const o = JSON.parse(bruto.slice(bruto.indexOf("{"), bruto.lastIndexOf("}") + 1));
          if (Array.isArray(o.topicos) && o.topicos.length) return { topicos: o.topicos, pronuncia: o.pronuncia || {} };
        } catch {}
        ultimo = "o Gemini respondeu fora do formato"; continue;
      }
      const m = motivo(r.status, j);
      if (m.fatal) throw new Error(m.fatal);
      if (m.dia) esgotados.add(modelo);
      ultimo = m.texto; espera = Math.max(espera, m.espera || 0);
    }
    if (esgotados.size === MODELOS.length) throw new Error("a cota grátis do Gemini acabou por hoje");
    if (tentativa === ESPERAS.length) break;
    const s = Math.ceil(Math.max(espera, ESPERAS[tentativa]));
    for (let k = s; k > 0; k--) { aviso(`${ultimo[0].toUpperCase() + ultimo.slice(1)}; tentando de novo em ${k} s…`); await dormir(1); }
  }
  throw new Error(ultimo);
}

function soLer(texto) {
  return blocos(texto, 3000).map((t, i) => ({ titulo: `Parte ${i + 1}`, texto: t.trim(), resumo: "", perguntas: [] }));
}

// ---------- materiais salvos neste navegador ----------
const indice = () => lembrar("estudos", []);
function salvarEstudo(e) {
  if (!guardar("estudo:" + e.id, e)) throw new Error("o navegador não deixou salvar (espaço cheio ou modo anônimo)");
  const resumo = { id: e.id, titulo: e.titulo, criado: e.criado, organizado_por: e.organizado_por, topicos: e.topicos.length, faltam: e.pendentes?.length || 0 };
  guardar("estudos", [resumo, ...indice().filter((x) => x.id !== e.id)]);
}

// organiza parte por parte e salva a cada parte pronta; se o Gemini falhar, guarda o que falta para continuar depois
async function processar(e, chave) {
  const st = $("#estado"); st.className = "estado";
  const total = e.partes_total;
  while (e.pendentes.length) {
    const n = total - e.pendentes.length + 1;
    const aviso = (t) => (st.textContent = `Parte ${n} de ${total}: ${t}`);
    aviso("organizando…");
    try {
      const o = await organizar(e.pendentes[0], chave, aviso);
      e.topicos.push(...o.topicos); Object.assign(e.pronuncia, o.pronuncia);
      e.pendentes.shift();
      salvarEstudo(e); carregarLista();
      if (estudo?.id === e.id) { estudo = e; const p = pos, t = topico; if (!tocando) montar(t, p); }
    } catch (err) {
      salvarEstudo(e); carregarLista();
      st.className = "estado erro";
      st.textContent = e.topicos.length
        ? `Organizei ${n - 1} de ${total} partes e parei: ${err.message}. O que já foi organizado está salvo; abra o material e toque em “Continuar organizando” mais tarde.`
        : `Não consegui organizar: ${err.message}. Tente de novo em alguns minutos, ou desmarque “Organizar com IA” para ouvir o texto como está.`;
      return false;
    }
  }
  st.textContent = "";
  return true;
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
    const agora = new Date();
    const e = { id: String(agora.getTime()), titulo: arquivo.name.replace(/\.[^.]+$/, ""),
      criado: agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
      organizado_por: usarIa ? "Gemini" : "sem IA", topicos: [], pronuncia: {}, pendentes: [], partes_total: 0 };
    if (!usarIa) {
      e.topicos = soLer(texto); salvarEstudo(e);
      st.textContent = $("#usarIa").checked ? "Sem chave do Gemini: o material foi aberto como está." : "";
      carregarLista(); return abrir(e.id);
    }
    e.pendentes = blocos(texto, 20000); e.partes_total = e.pendentes.length;
    salvarEstudo(e); carregarLista();
    organizando.add(e.id);
    const ok = await processar(e, chave);
    organizando.delete(e.id);
    if (e.topicos.length && (ok || estudo?.id !== e.id)) abrir(e.id);
  } catch (err) { st.className = "estado erro"; st.textContent = "Erro: " + err.message; }
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
    `<button class="item ${estudo?.id === e.id ? "ativo" : ""}" data-id="${esc(e.id)}"><b>${esc(e.titulo)}</b><small>${e.topicos} tópicos${e.faltam ? ` (faltam ${e.faltam} partes)` : ""} · ${esc(e.criado)} · ${esc(e.organizado_por)}</small></button>`).join("") : "";
  document.querySelectorAll(".item").forEach((b) => (b.onclick = () => abrir(b.dataset.id)));
}

// ---------- voz ----------
const worker = new Worker(new URL("./voz-worker.js", import.meta.url), { type: "module" });
let vozPronta = null, pedidos = new Map(), seq = 0;
const mb = (b) => Math.round(b / 1048576);
function avisoVoz(titulo, detalhe, pct) {
  const el = $("#vozAviso");
  el.hidden = false;
  el.querySelector("b").textContent = titulo;
  el.querySelector("small").textContent = detalhe;
  el.querySelector(".progresso i").style.width = pct == null ? "100%" : pct + "%";
  el.classList.toggle("indeterminado", pct == null);
}
worker.onmessage = ({ data }) => {
  if (data.tipo === "progresso") {
    const pct = Math.min(100, Math.round((data.carregado / data.total) * 100));
    avisoVoz(`Baixando a voz: ${mb(data.carregado)} de ${mb(data.total)} MB (${pct}%)`,
      "Só acontece na primeira vez. Depois a voz fica guardada neste navegador e abre na hora.", pct);
    $("#vozTexto").textContent = `Baixando a voz… ${pct}%`;
  }
  if (data.tipo === "fase") { avisoVoz(data.texto, "Falta pouco: deixando a voz pronta para ler.", null); $("#vozTexto").textContent = data.texto; }
  if (data.tipo === "pronto") {
    $("#vozAviso").hidden = true;
    $("#vozEstado").classList.add("ok");
    $("#vozTexto").textContent = data.device === "webgpu" ? "Voz pronta (placa de vídeo)" : "Voz pronta (processador: pode pausar entre frases)";
    vozPronta.ok();
  }
  if (data.tipo === "audio") { pedidos.get(data.id)?.ok(URL.createObjectURL(new Blob([data.buf], { type: "audio/wav" }))); pedidos.delete(data.id); }
  if (data.tipo === "erro") {
    if (data.id != null) { pedidos.get(data.id)?.falha(new Error(data.msg)); pedidos.delete(data.id); }
    else {
      $("#vozTexto").textContent = "A voz não carregou: " + data.msg;
      avisoVoz("A voz não carregou", data.msg + " — confira a internet e recarregue a página.", 0);
      vozPronta?.falha(new Error(data.msg));
    }
  }
};
function carregarVoz() {
  if (!vozPronta) {
    let ok, falha; const p = new Promise((a, b) => { ok = a; falha = b; });
    vozPronta = { p, ok, falha };
    $("#vozTexto").textContent = "Preparando a voz…";
    avisoVoz("Preparando a voz…", "Na primeira vez ela é baixada para o seu aparelho (cerca de 300 MB).", null);
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

// faixa no topo do material: organizar com IA depois de aberto, ou continuar de onde o Gemini parou
const organizando = new Set();
function faixaIa() {
  if (organizando.has(estudo.id)) return `<div class="continuar">Organizando com IA… acompanhe o andamento à esquerda.</div>`;
  if (estudo.pendentes?.length)
    return `<div class="continuar">Faltam ${estudo.pendentes.length} de ${estudo.partes_total} partes para organizar. <button id="btnIa">Continuar organizando</button></div>`;
  if (estudo.organizado_por === "sem IA")
    return `<div class="continuar">Este material está como veio no arquivo. <button id="btnIa">Organizar com IA</button></div>`;
  return "";
}
function pedirChave() {
  const chave = $("#chave").value.trim();
  if (!chave) {
    $("#config").open = true; $("#chave").focus();
    const st = $("#estado"); st.className = "estado erro"; st.textContent = "Cole a chave do Gemini aqui embaixo para organizar com IA.";
  }
  return chave;
}
async function organizarDepois() {
  const chave = pedirChave();
  if (!chave) return;
  let e = estudo;
  if (!e.pendentes?.length) {
    // material aberto sem IA: vira um material novo organizado; o original continua na lista
    const agora = new Date();
    e = { id: String(agora.getTime()), titulo: estudo.titulo, criado: agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
      organizado_por: "Gemini", topicos: [], pronuncia: {}, pendentes: blocos(estudo.topicos.map((x) => x.texto).join("\n\n"), 20000) };
    e.partes_total = e.pendentes.length;
    salvarEstudo(e);
  }
  organizando.add(e.id);
  if (estudo.id === e.id) montar(topico, pos);
  const ok = await processar(e, chave);
  organizando.delete(e.id);
  if (estudo?.id === e.id || ok) abrir(e.id);
}

function montar(t, p = 0) {
  fila = []; limparPre();
  if (!estudo.topicos.length) { // nenhuma parte organizada ainda
    $("#coluna").innerHTML = faixaIa() + '<div class="vazio"><h2>Ainda não há tópicos prontos</h2></div>';
    $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
    return;
  }
  topico = Math.max(0, Math.min(t, estudo.topicos.length - 1));
  const tp = estudo.topicos[topico];
  const span = (texto, tipo) => { fila.push({ texto, tipo }); return `<span class="frase" data-i="${fila.length - 1}">${esc(texto)}</span> `; };
  let html = faixaIa() + `<div class="topicos">${estudo.topicos.map((x, i) => `<button class="chip ${i === topico ? "ativo" : i < topico ? "feito" : ""}" data-t="${i}">${i + 1}. ${esc(x.titulo)}</button>`).join("")}</div>`;
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
  $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
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
