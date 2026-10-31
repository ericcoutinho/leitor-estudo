// saber.ia — leitor de estudo (versão web, sem servidor): extrai o texto do arquivo, a IA (Gemini, chave do próprio usuário)
// organiza em tópicos e a voz Kokoro lê no aparelho (voz-worker.js). Materiais ficam salvos neste navegador.
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { paraFala } from "./texto.js?v=20261030225201";

pdfjs.GlobalWorkerOptions.workerSrc = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const $ = (s) => document.querySelector(s);
const PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const PAUSA = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
// Materiais, progresso e cartões ficam no IndexedDB (aguenta centenas de MB; o localStorage só ~5 MB, e dois ou três
// PDFs grandes estouravam). Por cima dele há um espelho em memória: o resto do código lê e grava na hora, e a gravação
// no banco acontece em segundo plano. Ajustes pequenos (voz, tema, pomodoro…) continuam no localStorage.
const NO_BANCO = /^(estudo:|estudos$|pos:|caixas:|simulado:)/;
const espelho = new Map();
let banco = null;
const pedido = (r) => new Promise((ok, falha) => { r.onsuccess = () => ok(r.result); r.onerror = () => falha(r.error); });
const loja = (modo) => banco.transaction("dados", modo).objectStore("dados");
try {
  const abrindo = indexedDB.open("leitor-estudo", 1);
  abrindo.onupgradeneeded = () => abrindo.result.createObjectStore("dados");
  banco = await pedido(abrindo);
  const [chaves, valores] = await Promise.all([pedido(loja("readonly").getAllKeys()), pedido(loja("readonly").getAll())]);
  chaves.forEach((k, i) => espelho.set(k, valores[i]));
  // versões antigas guardavam tudo no localStorage: passa para o banco uma vez e libera o espaço
  for (const k of Object.keys(localStorage).filter((k) => NO_BANCO.test(k))) {
    if (!espelho.has(k)) { espelho.set(k, localStorage.getItem(k)); await pedido(loja("readwrite").put(localStorage.getItem(k), k)); }
    localStorage.removeItem(k);
  }
} catch { banco = null; } // navegador sem IndexedDB: continua no localStorage
// quando cada material mudou pela última vez (id → ms, no localStorage "alteradoEm"): ao levar os materiais para o
// endereço novo, se o mesmo material existir nos dois lados, fica a versão mexida por último
const DO_MATERIAL = /^(estudo|pos|caixas|simulado):(.+)$/;
const carimbos = () => { try { return JSON.parse(localStorage.getItem("alteradoEm") || "{}") || {}; } catch { return {}; } };
function carimbar(k) {
  const m = DO_MATERIAL.exec(k); if (!m) return;
  try { const t = carimbos(); t[m[2]] = Date.now(); localStorage.setItem("alteradoEm", JSON.stringify(t)); } catch {}
}
function guardar(k, v) {
  const txt = JSON.stringify(v);
  carimbar(k);
  if (banco && NO_BANCO.test(k)) {
    espelho.set(k, txt);
    pedido(loja("readwrite").put(txt, k)).catch(() => toast("Não deu para salvar neste navegador (espaço cheio?). Exporte um backup em Configurações."));
    return true;
  }
  try { localStorage.setItem(k, txt); return true; } catch { return false; }
}
function lembrar(k, padrao) {
  try { const txt = banco && NO_BANCO.test(k) ? espelho.get(k) : localStorage.getItem(k); return txt == null ? padrao : JSON.parse(txt) ?? padrao; } catch { return padrao; }
}
function apagarChave(k) {
  espelho.delete(k);
  if (banco) pedido(loja("readwrite").delete(k)).catch(() => {});
  try { localStorage.removeItem(k); } catch {}
}
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
- Para cada tópico, também de 4 a 8 flash cards: frente curta (um conceito, sigla, número ou pergunta direta) e verso
  com a resposta em uma ou duas frases. Cubra o que mais cai em prova; não repita as perguntas de revisão.
- Mantenha termos em inglês escritos no original no texto e liste em "ingles" cada termo ou nome em inglês do jeito que
  aparece (ex.: "Data Warehouse", "Business Intelligence", "Kimball", "Power BI", "dashboard"), para a voz ler com
  pronúncia de inglês. Não inclua siglas que no Brasil se leem letra a letra em português (ETL, SQL, ERP, OLAP).
Responda SOMENTE com JSON válido neste formato:
{"topicos":[{"titulo":"...","texto":"...","resumo":"...","perguntas":[{"pergunta":"...","resposta":"..."}],"cartoes":[{"frente":"...","verso":"..."}]}],"ingles":[]}`;
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

// chama o Gemini com novas tentativas; `valida` confere se o JSON veio com o que se pediu
async function gemini(prompt, chave, aviso, valida) {
  const esgotados = new Set();
  let ultimo = "";
  for (let tentativa = 0; tentativa <= ESPERAS.length; tentativa++) {
    let espera = 0;
    for (const modelo of MODELOS.filter((m) => !esgotados.has(m))) {
      let r, j;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent?key=${encodeURIComponent(chave)}`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.3 } }),
        });
        j = await r.json().catch(() => ({}));
      } catch { ultimo = "sem conexão com o Gemini"; continue; }
      if (r.ok) {
        try {
          const bruto = j.candidates[0].content.parts[0].text;
          const o = JSON.parse(bruto.slice(bruto.indexOf("{"), bruto.lastIndexOf("}") + 1));
          if (valida(o)) return o;
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

async function organizar(trecho, chave, aviso, objetivo) {
  const prompt = INSTRUCAO.replace("Responda SOMENTE", linhaObjetivo(objetivo) + "Responda SOMENTE") + "\n\nTRECHO:\n" + trecho;
  const o = await gemini(prompt, chave, aviso, (o) => Array.isArray(o.topicos) && o.topicos.length);
  return { topicos: o.topicos, ingles: Array.isArray(o.ingles) ? o.ingles : [], objetivo: String(o.objetivo || "").toLowerCase().trim() };
}

const INSTRUCAO_CARTOES = `Crie flash cards para estudar para uma prova a partir do material abaixo, em português do Brasil.
Para cada tópico indicado ("## número. título"), de 4 a 8 cartões: frente curta (um conceito, sigla, número ou pergunta direta)
e verso com a resposta em uma ou duas frases. Cubra o que mais cai em prova: definições, números, datas, nomes, listas, exceções.
Responda SOMENTE com JSON válido: {"cartoes":[{"topico":0,"frente":"...","verso":"..."}]} (topico = número do tópico, começando em 0).`;

function soLer(texto) {
  return blocos(texto, 3000).map((t, i) => ({ titulo: `Parte ${i + 1}`, texto: t.trim(), resumo: "", perguntas: [] }));
}

// ---------- materiais salvos neste navegador ----------
const indice = () => lembrar("estudos", []);
function salvarEstudo(e) {
  if (!guardar("estudo:" + e.id, e)) throw new Error("o navegador não deixou salvar (espaço cheio ou modo anônimo)");
  const resumo = { id: e.id, titulo: e.titulo, criado: e.criado, organizado_por: e.organizado_por, topicos: e.topicos.length, faltam: e.pendentes?.length || 0,
    objetivo: e.objetivo && e.objetivo.tipo !== "auto" ? nomeObjetivo(e.objetivo) : "" };
  guardar("estudos", [resumo, ...indice().filter((x) => x.id !== e.id)]);
}

// organiza parte por parte e salva a cada parte pronta; se o Gemini falhar, guarda o que falta para continuar depois
async function processar(e, chave) {
  const st = $("#estado"); st.className = "estado";
  const total = e.partes_total;
  while (e.pendentes.length) {
    const n = total - e.pendentes.length + 1;
    // o andamento aparece na tela de preparo (se a pessoa estiver nela), no cartão da biblioteca e no topo
    const aviso = (t) => { andamento.set(e.id, { n, total, texto: t }); if (preparo?.id === e.id) mostrarPreparo(); else if (estudo) st.textContent = `“${e.titulo}”, parte ${n} de ${total}: ${t}`; else carregarLista(); };
    aviso("organizando…");
    try {
      const o = await organizar(e.pendentes[0], chave, aviso, e.objetivo);
      // "A IA identifica": o objetivo achado na 1ª parte vale para as próximas (e aparece no material)
      if (e.objetivo?.tipo === "auto" && OBJETIVOS[o.objetivo]) e.objetivo = { tipo: o.objetivo, detectado: true };
      e.topicos.push(...o.topicos); e.ingles = [...new Set([...(e.ingles || []), ...o.ingles])];
      e.pendentes.shift();
      salvarEstudo(e); carregarLista();
      if (preparo?.id === e.id) { st.textContent = ""; abrir(e.id); } // 1ª parte pronta: já dá para começar a ler
      else if (estudo?.id === e.id) { estudo = e; const p = pos, t = topico; if (!tocando) montar(t, p); }
    } catch (err) {
      andamento.delete(e.id);
      salvarEstudo(e); carregarLista();
      if (preparo?.id === e.id) { mostrarPreparo({ erro: err.message }); return false; }
      st.className = "estado erro";
      st.textContent = e.topicos.length
        ? `Organizei ${n - 1} de ${total} partes e parei: ${err.message}. O que já foi organizado está salvo; abra o material e toque em “Continuar organizando” mais tarde.`
        : `Não consegui organizar: ${err.message}. Tente de novo em alguns minutos, ou desmarque “Organizar com IA” para ouvir o texto como está.`;
      return false;
    }
  }
  st.textContent = ""; andamento.delete(e.id);
  return true;
}

async function enviar(arquivo) {
  if (!arquivo) return;
  fecharModais();
  const st = $("#estado"); st.className = "estado"; st.textContent = "";
  const titulo = arquivo.name.replace(/\.[^.]+$/, "");
  mostrarPreparo({ id: null, titulo, etapa: "lendo", erro: null }); // tela do material novo desde o primeiro instante
  try {
    const texto = limpar(await extrair(arquivo));
    if (texto.length < 50) throw new Error("não achei texto no arquivo (PDF escaneado? precisa de OCR)");
    await criarMaterial(titulo, texto, arquivo.name.toLowerCase().split(".").pop());
  } catch (err) { if (preparo && !preparo.id) mostrarPreparo({ erro: err.message }); else { st.className = "estado erro"; st.textContent = "Erro: " + err.message; } }
}

async function criarMaterial(titulo, texto, tipo, objetivo = objetivoEscolhido(), forcarIa = false) {
  const st = $("#estado"); st.className = "estado";
  const chave = $("#chave").value.trim();
  const querIa = forcarIa || $("#usarIa").checked, usarIa = querIa && chave;
  const agora = new Date();
  const e = { id: String(agora.getTime()), titulo, tipo, criado: agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
    organizado_por: usarIa ? "Gemini" : "sem IA", topicos: [], pronuncia: {}, pendentes: [], partes_total: 0,
    original: texto, objetivo: usarIa ? objetivo : null }; // o texto original permite organizar de novo com outro objetivo
  if (!usarIa) {
    e.topicos = soLer(texto); salvarEstudo(e);
    st.textContent = querIa ? "Sem chave do Gemini: o material foi aberto como está. Coloque a chave em “Chave da IA” para organizar." : "";
    return abrir(e.id);
  }
  e.pendentes = blocos(texto, 20000); e.partes_total = e.pendentes.length;
  salvarEstudo(e);
  organizando.add(e.id);
  mostrarPreparo({ id: e.id, titulo, etapa: "organizando", palavras: texto.split(/\s+/).length, erro: null });
  await processar(e, chave);
  organizando.delete(e.id);
  if (estudo?.id === e.id && !tocando) montar(topico, pos); // tira a faixa "organizando"
  carregarLista();
}

// ---------- tela de preparo do material novo ----------
// Em vez de deixar a pessoa no material antigo com um aviso pequeno no topo, a tela vai para o material novo e mostra
// as etapas. Quando a 1ª parte fica pronta, o material abre; as outras continuam chegando enquanto ela lê.
let preparo = null; // { id, titulo, etapa, palavras, erro }
const andamento = new Map(); // id → { n, total, texto } da organização em curso (também aparece na biblioteca)
function mostrarPreparo(mudar = {}) {
  parar(); estudo = null; naTelaPlano = false; $("#navPlano").classList.remove("ativo");
  preparo = { ...preparo, ...mudar };
  document.body.classList.add("na-biblioteca"); document.body.classList.remove("modo-cartoes", "modo-simulado");
  $("#navBiblioteca").classList.remove("ativo"); $("#linhaProgresso").style.width = "0";
  const a = preparo.id ? andamento.get(preparo.id) : null;
  const pct = a ? Math.round(((a.n - 1) / a.total) * 100) : 0;
  const passo = (estado, titulo, detalhe = "") => `<li class="passo ${estado}"><span class="marca-passo"></span><div><b>${titulo}</b>${detalhe ? `<small>${detalhe}</small>` : ""}</div></li>`;
  const lido = preparo.etapa !== "lendo";
  $("#tituloTopo").textContent = "Novo material";
  const primeira = !$(".preparo"); // a animação de entrada só na primeira vez (a tela se redesenha a cada parte)
  $("#coluna").innerHTML = `<div class="preparo ${primeira ? "entra" : ""}">
    <span class="miniatura">${ICONE_TIPO.pdf}</span>
    <h1>${esc(preparo.titulo)}</h1>
    <p class="sub">${preparo.erro ? "Não deu para organizar agora." : "Preparando o seu material de estudo…"}</p>
    <ol class="passos">
      ${passo(lido ? "feito" : "agora", lido ? "Arquivo lido" : "Lendo o arquivo…", lido && preparo.palavras ? `${preparo.palavras.toLocaleString("pt-BR")} palavras` : "")}
      ${passo(preparo.erro ? "erro" : !lido ? "" : "agora", "Organizando com IA", preparo.erro ? esc(preparo.erro) : a ? `Parte ${a.n} de ${a.total}: ${esc(a.texto)}` : "Dividindo em tópicos, resumo, perguntas e flash cards")}
      ${passo("", "Pronto para estudar", "Abre sozinho assim que a primeira parte ficar pronta")}
    </ol>
    ${!preparo.erro && lido ? `<div class="progresso"><i style="width:${Math.max(6, pct)}%"></i></div>` : ""}
    ${preparo.erro ? `<div class="linha-botoes" style="justify-content:center">${preparo.id ? `<button class="sec" id="prepTentar">Tentar de novo</button>` : ""}<button class="pri" id="prepVoltar">Voltar à biblioteca</button></div>`
      : `<div class="esqueleto" aria-hidden="true"><i></i><i></i><i style="width:80%"></i><i style="width:60%"></i></div>
         <button class="link" id="prepVoltar">Voltar à biblioteca enquanto organiza</button>`}
  </div>`;
  $("#prepVoltar").onclick = () => mostrarBiblioteca();
  $("#prepTentar") && ($("#prepTentar").onclick = async () => {
    const e = lembrar("estudo:" + preparo.id, null), chave = pedirChave();
    if (!e || !chave) return;
    organizando.add(e.id); mostrarPreparo({ erro: null });
    await processar(e, chave); organizando.delete(e.id); carregarLista();
  });
}

// ---------- janelas, menus e biblioteca ----------
const abrirModal = (id) => { fecharMenus(); $(id).hidden = false; $(id).querySelector("input:not([hidden]), textarea, button.pri")?.focus(); };
const fecharModais = () => document.querySelectorAll(".fundo-modal").forEach((m) => (m.hidden = true));
document.querySelectorAll(".fundo-modal").forEach((m) => {
  m.onclick = (ev) => { if (ev.target === m || ev.target.closest(".fechar")) m.hidden = true; };
});
$("#btnNovo").onclick = () => abrirModal("#modalNovo");
$("#btnConfig").onclick = () => abrirModal("#modalConfig");
$("#usarIa").checked = lembrar("usarIa", true);
$("#usarIa").onchange = () => guardar("usarIa", $("#usarIa").checked);
$("#arquivo").onchange = (e) => { enviar(e.target.files[0]); e.target.value = ""; };
$("#colado").oninput = () => ($("#usarColado").disabled = $("#colado").value.trim().length < 20);
$("#usarColado").onclick = () => {
  const texto = limpar($("#colado").value);
  const titulo = texto.split("\n")[0].slice(0, 60).trim() || "Texto colado";
  $("#colado").value = ""; $("#usarColado").disabled = true; fecharModais();
  criarMaterial(titulo, texto, "txt");
};
// arrastar arquivo em qualquer lugar da página
let arrastos = 0;
document.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types.includes("Files")) { arrastos++; document.body.classList.add("arrastando"); } });
document.addEventListener("dragleave", () => { if (--arrastos <= 0) { arrastos = 0; document.body.classList.remove("arrastando"); } });
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", (e) => {
  e.preventDefault(); arrastos = 0; document.body.classList.remove("arrastando");
  const f = e.dataTransfer?.files?.[0]; if (f) enviar(f);
});
$("#chave").value = lembrar("chave", "");
$("#salvarChave").onclick = () => {
  guardar("chave", $("#chave").value.trim()); fecharModais();
  const st = $("#estado"); if (st.classList.contains("erro")) { st.textContent = ""; st.className = "estado"; }
};
$("#recolher").onclick = () => { document.body.classList.toggle("recolhida"); guardar("recolhida", document.body.classList.contains("recolhida")); };
if (lembrar("recolhida", false)) document.body.classList.add("recolhida");
$("#navBiblioteca").onclick = () => mostrarBiblioteca();
$("#voltar").onclick = () => mostrarBiblioteca();

// menus que abrem junto ao botão (voz, velocidade, mais)
function abrirMenu(id, botao) {
  const pop = $(id), aberto = !pop.hidden;
  fecharMenus();
  if (aberto) return;
  pop.hidden = false;
  const r = botao.getBoundingClientRect(), w = pop.offsetWidth, h = pop.offsetHeight;
  const embaixo = r.bottom + 8 + h < innerHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
  pop.style.top = (embaixo ? r.bottom + 8 : r.top - h - 8) + "px";
}
const fecharMenus = () => document.querySelectorAll(".pop").forEach((p) => (p.hidden = true));
document.addEventListener("click", (e) => { if (!e.target.closest(".pop, #btnVoz, #btnVel, #btnMais, #btnPomo, #btnPomoNav, #btnVolume, #btnCoresGrifo")) fecharMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { fecharMenus(); fecharModais(); } });

const VOZES = [["pf_dora", "Dora", "feminina"], ["pm_alex", "Alex", "masculina"], ["pm_santa", "Santa", "masculina"]];
const VELS = ["0.8", "0.9", "1.0", "1.1", "1.25", "1.5"];
let vozAtual = lembrar("voz", "pf_dora"), velAtual = lembrar("vel", "1.0");
if (!VELS.includes(velAtual)) velAtual = "1.0";
const amostra = new Audio();

// ---------- volume (vale para a leitura, as explicações, os flash cards e as amostras) ----------
let volume = lembrar("volume", 100), mudo = lembrar("mudo", false);
const ICONES_VOLUME = {
  mudo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4zM22 9l-6 6M16 9l6 6"/></svg>',
  baixo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"/></svg>',
  alto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/></svg>',
};
function aplicarVolume() {
  const v = mudo ? 0 : volume / 100;
  audio.volume = v; amostra.volume = v;
  const icone = mudo || !volume ? ICONES_VOLUME.mudo : volume < 50 ? ICONES_VOLUME.baixo : ICONES_VOLUME.alto;
  for (const b of [$("#btnVolume"), $("#mudoPop")]) { b.innerHTML = icone; b.classList.toggle("mudo", mudo || !volume); }
  $("#volume").value = $("#volumePop").value = mudo ? 0 : volume;
  $("#volumeValor").textContent = (mudo ? 0 : volume) + "%";
  $("#btnVolume").setAttribute("aria-label", mudo ? "Volume: mudo" : `Volume: ${volume}%`);
}
function alternarMudo() { mudo = !mudo; if (!mudo && !volume) volume = 60; guardar("mudo", mudo); guardar("volume", volume); aplicarVolume(); }
function mudarVolume(v) { volume = +v; mudo = !volume; guardar("volume", volume); guardar("mudo", mudo); aplicarVolume(); }
// no computador o ícone liga/desliga o mudo (a barra fica ao lado); no celular abre a barra num menu
$("#btnVolume").onclick = () => (matchMedia("(max-width: 820px)").matches ? abrirMenu("#popVolume", $("#btnVolume")) : alternarMudo());
$("#mudoPop").onclick = alternarMudo;
$("#volume").oninput = $("#volumePop").oninput = (e) => mudarVolume(e.target.value);
const virgula = (v) => String(+v).replace(".", ",");
function mostrarVoz() {
  const [, nome] = VOZES.find((v) => v[0] === vozAtual) || VOZES[0];
  $("#avatarVoz").textContent = nome[0]; $("#avatarVoz").className = "avatar " + vozAtual; $("#nomeVoz").textContent = nome;
  $("#btnVel").textContent = virgula(velAtual) + "x";
  $("#listaVozes").innerHTML = VOZES.map(([id, nome, g]) => `<div class="opcao-voz ${id === vozAtual ? "ativo" : ""}">
      <button class="ouvir" data-ouvir="${id}" title="Ouvir ${nome}" aria-label="Ouvir ${nome}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
      <button class="opcao-voz" data-voz="${id}" role="menuitemradio" aria-checked="${id === vozAtual}" style="padding:0"><span class="avatar ${id}">${nome[0]}</span><span class="nome">${nome}<small>Português (Brasil) · ${g}</small></span></button></div>`).join("");
  $("#listaVel").innerHTML = VELS.map((v) => `<button class="opcao-vel ${v === velAtual ? "ativo" : ""}" data-vel="${v}" role="menuitemradio" aria-checked="${v === velAtual}">${virgula(v)}x${v === "1.0" ? " · normal" : ""}</button>`).join("");
  document.querySelectorAll("[data-ouvir]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); amostra.src = `amostras/${b.dataset.ouvir}.mp3`; amostra.play().catch(() => {}); }));
  document.querySelectorAll("[data-voz]").forEach((b) => (b.onclick = () => trocarAjuste(() => (vozAtual = b.dataset.voz), "voz")));
  document.querySelectorAll("[data-vel]").forEach((b) => (b.onclick = () => trocarAjuste(() => (velAtual = b.dataset.vel), "vel")));
}
function trocarAjuste(f, chave) {
  const t = tocando, guiaFalando = modo === "guiado" && guia.etapa !== 2 && falandoGuia();
  parar(); f(); guardar(chave, chave === "voz" ? vozAtual : velAtual);
  limparPre(); mostrarVoz(); fecharMenus(); if (t) tocar();
  if (guiaFalando && guia.falar) falarGuia(guia.falar);
}
$("#btnVoz").onclick = () => abrirMenu("#popVoz", $("#btnVoz"));
$("#btnVel").onclick = () => abrirMenu("#popVel", $("#btnVel"));
$("#btnMais").onclick = () => abrirMenu("#popMais", $("#btnMais"));
$("#btnIaTopo").onclick = () => organizarDepois();

const ICONE_TIPO = {
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h4"/></svg>',
  txt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
};

function mostrarBiblioteca() {
  parar(); estudo = null; modo = "ler"; preparo = null; naTelaPlano = false; $("#navPlano").classList.remove("ativo");
  $("#tituloTopo").textContent = "Biblioteca";
  document.body.classList.add("na-biblioteca"); document.body.classList.remove("modo-cartoes", "modo-simulado", "guia-passo");
  $("#navBiblioteca").classList.add("ativo"); $("#linhaProgresso").style.width = "0";
  const lista = indice();
  const soltar = `<label class="soltar" id="soltarBiblioteca"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
    <h2>${lista.length ? "Adicionar outro material" : "Comece pelo material da prova"}</h2><p>Arraste um PDF, Word ou texto aqui, ou <b style="color:var(--destaque)">clique para escolher</b></p></label>`;
  const ult = lembrar("ultimo", null), ultE = ult && lista.find((e) => e.id === ult), ultPos = ultE && lembrar("pos:" + ult, null);
  const continuar = ultE && ultPos ? `<button class="continuar-card" id="continuarCard"><span class="play-c"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>
    <div><small>Continuar de onde parou</small><b>${esc(ultE.titulo)}</b><small>Tópico ${ultPos.topico + 1} de ${ultE.topicos}${ultPos.pct ? ` · ${Math.round(ultPos.pct * 100)}% lido` : ""}</small></div></button>` : "";
  $("#coluna").innerHTML = (lista.length ? faixaPlano() : "") + continuar + `<div class="cab"><h1>Biblioteca<small>${lista.length || ""}</small></h1>${lista.length ? '<button class="pri" id="novoCab">+ Novo material</button>' : ""}</div>` +
    (lista.length ? `<div class="lista">${lista.map((e) => {
      const salvo = lembrar("pos:" + e.id, {}), pct = Math.round((salvo.pct || 0) * 100);
      const ia = e.organizado_por !== "sem IA";
      return `<div class="material" role="button" tabindex="0" data-id="${esc(e.id)}">
        <span class="miniatura">${ICONE_TIPO[e.tipo === "pdf" ? "pdf" : "txt"]}</span>
        <span class="info"><b>${esc(e.titulo)}</b>
          <small>${andamento.has(e.id) ? `<span class="etiqueta organizando">Organizando parte ${andamento.get(e.id).n} de ${andamento.get(e.id).total}…</span>` : `<span class="etiqueta ${ia ? "ia" : ""}">${ia ? "Organizado com IA" : "Texto original"}</span>`} · ${e.topicos} tópicos${e.objetivo ? ` · 🎯 ${esc(e.objetivo)}` : ""}${e.faltam ? ` · faltam ${e.faltam} partes` : ""} · ${esc(e.criado)}${pct ? ` · ${pct}% lido` : ""}</small>
          ${pct ? `<span class="barrinha"><i style="width:${pct}%"></i></span>` : ""}</span>
        <button class="apagar-item" data-apagar="${esc(e.id)}" title="Apagar">Apagar</button></div>`;
    }).join("")}</div><div style="margin-top:18px">${soltar}</div>` : soltar);
  // o clique na área de soltar abre a janela, onde fica o interruptor de organizar com IA
  $("#soltarBiblioteca").onclick = (ev) => { ev.preventDefault(); abrirModal("#modalNovo"); };
  $("#continuarCard") && ($("#continuarCard").onclick = () => abrir(ult));
  $("#faixaPlano") && ($("#faixaPlano").onclick = () => mostrarPlano());
  $("#novoCab") && ($("#novoCab").onclick = () => abrirModal("#modalNovo"));
  document.querySelectorAll(".material").forEach((m) => {
    m.onclick = (ev) => { if (!ev.target.closest(".apagar-item")) abrir(m.dataset.id); };
    m.onkeydown = (ev) => { if (ev.key === "Enter") abrir(m.dataset.id); };
  });
  document.querySelectorAll("[data-apagar]").forEach((b) => (b.onclick = () => {
    if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Confirmar?"; return; }
    apagarMaterial(b.dataset.apagar); mostrarBiblioteca();
  }));
}
function apagarMaterial(id) {
  for (const k of ["estudo:", "pos:", "caixas:", "simulado:"]) apagarChave(k + id);
  guardar("estudos", indice().filter((e) => e.id !== id));
}
// a lista só aparece na tela da biblioteca; nas outras telas não há o que atualizar
function carregarLista() { if (!estudo && !preparo && !naTelaPlano) mostrarBiblioteca(); }

// ---------- voz ----------
const worker = new Worker(new URL("./voz-worker.js?v=20261030225201", import.meta.url), { type: "module" });
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
    if (data.total < 1048576) return; // voz já guardada no navegador: não há download para mostrar
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
    worker.postMessage({ tipo: "falar", id, texto: paraFala(texto, estudo), voz: vozAtual, vel: +velAtual });
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
  preparo = null; naTelaPlano = false; $("#navPlano").classList.remove("ativo");
  try { localStorage.setItem("ultimo", JSON.stringify(id)); } catch {}
  modo = "ler"; filtroTopico = "todos"; document.body.classList.remove("modo-cartoes", "modo-simulado", "na-biblioteca", "guia-passo");
  $("#navBiblioteca").classList.remove("ativo"); $("#tituloMaterial").textContent = estudo.titulo;
  const salvo = lembrar("pos:" + id, { topico: 0, pos: 0 });
  montar(salvo.topico, salvo.pos);
  carregarLista();
  carregarVoz().catch(() => {});
}

// faixa no topo do material: organizar com IA depois de aberto, ou continuar de onde o Gemini parou
const organizando = new Set();
function faixaIa() {
  $("#btnIaTopo").hidden = organizando.has(estudo.id) || !(estudo.pendentes?.length || estudo.organizado_por === "sem IA");
  $("#btnIaTopo").querySelector(".rotulo-ia").textContent = estudo.pendentes?.length ? "Continuar organizando" : "Organizar com IA";
  if (organizando.has(estudo.id)) {
    const a = andamento.get(estudo.id);
    return `<div class="continuar"><span class="pensando"></span>Organizando com IA${a ? `: parte ${a.n} de ${a.total}` : "…"} Os próximos tópicos aparecem aqui sozinhos.</div>`;
  }
  if (estudo.pendentes?.length)
    return `<div class="continuar">Faltam ${estudo.pendentes.length} de ${estudo.partes_total} partes para organizar. <button id="btnIa">Continuar organizando</button></div>`;
  if (estudo.organizado_por === "sem IA")
    return `<div class="continuar">Este material está como veio no arquivo. <button id="btnIa">Organizar com IA</button></div>`;
  return "";
}
function pedirChave() {
  const chave = $("#chave").value.trim();
  if (!chave) {
    const st = $("#estado"); st.className = "estado erro"; st.textContent = "Para organizar com IA, coloque a sua chave do Gemini.";
    abrirModal("#modalConfig");
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
  if (modo === "cartoes" && estudo.topicos.length) return montarCartoes(); // material atualizado durante os cartões
  if (modo === "simulado" && estudo.topicos.length) return montarSimulado();
  if (modo === "guiado" && estudo.topicos.length) {
    if (t !== topico) guia = { etapa: 0, itens: itensRecordar(estudo.topicos[Math.max(0, Math.min(t, estudo.topicos.length - 1))], t) };
    if (guia.etapa !== 2) { topico = Math.max(0, Math.min(t, estudo.topicos.length - 1)); return montarGuiado(); }
  }
  const guiado = modo === "guiado";
  fila = []; limparPre();
  if (!estudo.topicos.length) { // nenhuma parte organizada ainda
    $("#coluna").innerHTML = faixaIa() + '<div class="vazio"><h2>Ainda não há tópicos prontos</h2></div>';
    $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
    return;
  }
  topico = Math.max(0, Math.min(t, estudo.topicos.length - 1));
  const tp = estudo.topicos[topico];
  const span = (texto, tipo) => { fila.push({ texto, tipo }); return `<span class="frase" data-i="${fila.length - 1}">${esc(texto)}</span> `; };
  const n = estudo.topicos.length;
  let html = faixaIa() + faixaObjetivo() + abas() + `<div class="nav-topico">
    <button class="icone" id="topAnt" title="Tópico anterior" aria-label="Tópico anterior" ${topico ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
    <button class="btn-sumario" id="abrirSumario" title="Ver todos os tópicos"><span class="n">${topico + 1} de ${n}</span><b>${esc(tp.titulo)}</b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
    <button class="icone" id="topProx" title="Próximo tópico" aria-label="Próximo tópico" ${topico < n - 1 ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg></button></div>`;
  if (guiado) html += stepper() + `<div class="faixa-guia">Leia (ou ouça) procurando a resposta da pergunta-guia. No fim, vem a hora de recordar. <button class="link" id="irRecordar">Já li, ir para Recordar →</button></div>`;
  html += `<div class="folha entra"><h2 class="titulo">${span(tp.titulo, "titulo")}</h2><div class="texto">${(tp.texto || "").split(/\n\s*\n/).map((par) => `<p>${frases(par).map((f) => span(f)).join("")}</p>`).join("")}</div>`;
  if (tp.resumo && lembrar("prefResumo", true) && !guiado) {
    fila.push({ texto: "Resumindo.", tipo: "aviso" });
    html += `<div class="cartao"><h3>Resumo</h3><div class="texto">${frases(tp.resumo).map((f) => span(f)).join("")}</div></div>`;
  }
  if (tp.perguntas?.length && lembrar("prefPerguntas", true) && !guiado) {
    fila.push({ texto: "Hora de revisar.", tipo: "aviso" });
    html += `<div class="cartao"><h3>Perguntas de revisão</h3>${tp.perguntas.map((q, k) => {
      const pq = span(q.pergunta, "pergunta");
      fila.push({ tipo: "pensar", k });
      const r = span(q.resposta, "resposta");
      return `<div class="pergunta"><div class="p">${pq}</div><div class="pensar" id="pensar-${k}"></div><div class="r texto oculta">${r}</div></div>`;
    }).join("")}</div>`;
  }
  html += `</div><button class="apagar" id="apagar">Apagar este material</button>`;
  $("#coluna").innerHTML = html;
  $("#irRecordar") && ($("#irRecordar").onclick = () => irEtapa(3));
  ligarObjetivo();
  $("#barraMarca").hidden = true;
  pintarMarcas();
  pintarGrifos();
  ligarAbas();
  $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
  $("#topAnt").onclick = () => irTopico(topico - 1);
  $("#topProx").onclick = () => irTopico(topico + 1);
  $("#abrirSumario").onclick = abrirSumario;
  // tocar numa frase lê dali (mas não quando a pessoa está selecionando um trecho para marcar)
  document.querySelectorAll(".frase").forEach((f) => (f.onclick = () => { if (!getSelection().isCollapsed) return; parar(); ir(+f.dataset.i); tocar(); }));
  document.querySelectorAll(".r.oculta").forEach((r) => (r.onclick = () => r.classList.remove("oculta")));
  $("#apagar").onclick = () => {
    const b = $("#apagar");
    if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Clique de novo para confirmar"; return; }
    parar(); apagarMaterial(estudo.id); mostrarBiblioteca();
  };
  ir(Math.min(p, fila.length - 1));
  $(".conteudo").scrollTop = 0;
}

// ---------- sumário (gaveta com todos os tópicos) ----------
function irTopico(t) {
  if (!estudo || t < 0 || t >= estudo.topicos.length) return;
  const tocava = tocando; parar(); fecharSumario();
  virarFolha(t > topico ? "frente" : "tras", () => montar(t)).then(() => { if (tocava) tocar(); });
}
// troca de tópico com a folha dobrando como papel. Com "reduzir movimento" no sistema, troca direto.
// Resolve assim que o tópico novo está na tela (a dobra continua por cima por ~0,8 s).
function virarFolha(direcao, trocar) {
  const velha = document.querySelector(".folha, .guia-corpo");
  if (!velha || !lembrar("animarFolha", true) || matchMedia("(prefers-reduced-motion: reduce)").matches) { trocar(); return Promise.resolve(); }
  // Folha "dobrando" como papel: uma cópia da folha fica por cima e é recortada por uma linha de dobra inclinada
  // (o canto de baixo puxa na frente, como a mão), com o verso do papel e a sombra na página de baixo.
  const r = velha.getBoundingClientRect();
  const W = r.width;
  const fixo = (el, z) => Object.assign(el.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: W + "px", height: r.height + "px",
    margin: 0, zIndex: z, pointerEvents: "none", overflow: "hidden" });
  const copia = (el) => { const c = el.cloneNode(true); c.removeAttribute("id"); c.classList.remove("entra"); c.querySelectorAll("[id]").forEach((x) => x.removeAttribute("id")); return c; };
  const camada = document.createElement("div"); camada.className = "virando";
  document.body.append(camada);
  document.documentElement.dataset.virar = direcao;
  let folha, base = null;
  // a folha nova não faz a animação de entrada (senão ela "pisca" depois da dobra)
  const semEntrada = () => document.querySelectorAll("#coluna .folha.entra, #coluna .guia-corpo.entra").forEach((x) => x.classList.remove("entra"));
  if (direcao === "frente") { folha = copia(velha); fixo(folha, 41); camada.append(folha); trocar(); semEntrada(); }
  else { base = copia(velha); fixo(base, 40); camada.append(base); trocar(); semEntrada(); const nova = document.querySelector(".folha, .guia-corpo"); folha = copia(nova || velha); fixo(folha, 41); camada.append(folha); }
  // verso do papel (com sombra própria) e sombra projetada na página de baixo
  const sombraVerso = document.createElement("div"); fixo(sombraVerso, 42); sombraVerso.style.overflow = "visible"; sombraVerso.style.filter = "drop-shadow(-6px 2px 10px rgba(0,0,0,.28))";
  const verso = document.createElement("div"); verso.className = "verso-folha"; Object.assign(verso.style, { position: "absolute", inset: 0 });
  sombraVerso.append(verso);
  const sombra = document.createElement("div"); fixo(sombra, direcao === "frente" ? 39 : 40.5);
  camada.append(sombraVerso, sombra);
  const DUR = 820, t0 = performance.now();
  const curva = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // começa devagar, passa rápido, assenta
  return new Promise((pronto) => {
    pronto(); // o tópico novo já está na tela (a voz pode seguir); a dobra continua por cima
    const quadro = (agora) => {
      const t = Math.min(1, (agora - t0) / DUR);
      const p = direcao === "frente" ? curva(t) : 1 - curva(t); // para trás: a folha volta deitando
      const xf = W * (1 - p);                                    // posição da dobra
      const d = Math.min(W * 0.11, 100) * Math.sin(Math.PI * Math.min(1, p * 1.05)); // inclinação: o canto de baixo vai na frente
      const xt = Math.max(0, xf + d), xb = Math.max(0, xf - d);
      folha.style.clipPath = `polygon(0 0, ${xt}px 0, ${xb}px ${r.height}px, 0 ${r.height}px)`;
      // verso: a parte levantada aparece espelhada à esquerda da dobra, encurtada pela perspectiva
      const larguraT = (W - xt) * 0.55 * (1 - p * 0.35), larguraB = (W - xb) * 0.55 * (1 - p * 0.35);
      verso.style.clipPath = `polygon(${xt}px 0, ${Math.max(0, xt - larguraT)}px 0, ${Math.max(0, xb - larguraB)}px ${r.height}px, ${xb}px ${r.height}px)`;
      verso.style.background = `linear-gradient(${90 + Math.atan2(xt - xb, r.height) * 57.3}deg, var(--verso-escuro) ${Math.max(0, xb - larguraB) / W * 100}%, var(--verso-claro) ${xb / W * 100}%)`;
      sombra.style.background = `linear-gradient(90deg, transparent ${Math.max(0, xf - 4)}px, rgba(0,0,0,${0.22 * Math.sin(Math.PI * p)}) ${xf + 2}px, transparent ${xf + 90}px)`;
      if (t < 1) requestAnimationFrame(quadro);
      else { camada.remove(); delete document.documentElement.dataset.virar; }
    };
    requestAnimationFrame(quadro);
  });
}
function listarTopicos() {
  const busca = $("#buscaTopico").value.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  const itens = estudo.topicos.map((t, i) => ({ t, i })).filter(({ t, i }) =>
    !busca || `${i + 1} ${t.titulo}`.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(busca));
  $("#listaTopicos").innerHTML = itens.length ? itens.map(({ t, i }) =>
    `<li><button data-t="${i}" class="${i === topico ? "atual" : i < topico ? "lido" : ""}" ${i === topico ? 'aria-current="true"' : ""}>
      <span class="num">${i < topico ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>' : i + 1}</span>
      <span class="tt">${esc(t.titulo)}</span></button></li>`).join("") : '<li class="nada">Nenhum tópico com esse nome.</li>';
  document.querySelectorAll("#listaTopicos [data-t]").forEach((b) => (b.onclick = () => irTopico(+b.dataset.t)));
}
function abrirSumario() {
  if (!estudo?.topicos.length) return;
  fecharMenus();
  const pct = Math.round((lembrar("pos:" + estudo.id, {}).pct || 0) * 100);
  $("#sumarioInfo").textContent = `${estudo.topicos.length} tópicos · ${pct}% lido`;
  $("#buscaTopico").value = "";
  listarTopicos();
  $("#sumario").hidden = $("#fundoSumario").hidden = false;
  $("#listaTopicos .atual")?.scrollIntoView({ block: "center" });
  if (matchMedia("(min-width: 821px)").matches) $("#buscaTopico").focus();
}
function fecharSumario() { $("#sumario").hidden = $("#fundoSumario").hidden = true; }
$("#buscaTopico").oninput = listarTopicos;
$("#fecharSumario").onclick = fecharSumario;
$("#fundoSumario").onclick = fecharSumario;
$("#btnSumarioTopo").onclick = abrirSumario;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") fecharSumario(); });

// ---------- marca-texto ----------
// Liga o modo e escolhe a cor uma vez; daí, selecionar o texto já pinta. Os grifos ficam em estudo.grifos
// como posições (início/fim) no texto do tópico, então sobrevivem a trocar de tópico e reabrir o material.
const CORES_GRIFO = { amarelo: ["Amarelo", "#ffe95c"], verde: ["Verde", "#9cf29c"], rosa: ["Rosa", "#ff9fd8"], azul: ["Azul", "#94d8ff"], laranja: ["Laranja", "#ffc06e"] };
const BORRACHA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l9.6-9.6a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 21"/><path d="M22 21H7M5 11l9 9"/></svg>';
let corGrifo = lembrar("corGrifo", "amarelo"), grifando = lembrar("grifando", false);
if (corGrifo !== "borracha" && !CORES_GRIFO[corGrifo]) corGrifo = "amarelo";
const bolinhas = () => Object.entries(CORES_GRIFO).map(([k, [nome, c]]) => `<button class="cor-grifo" data-cor="${k}" style="--c:${c}" role="menuitemradio" aria-label="${nome}" title="${nome}"></button>`).join("") +
  `<button class="cor-grifo borracha" data-cor="borracha" role="menuitemradio" aria-label="Borracha" title="Borracha: apaga o grifo">${BORRACHA}</button>`;
$("#coresGrifo").innerHTML = bolinhas();
$("#coresBarra").innerHTML = bolinhas();
function mostrarGrifo() {
  const c = CORES_GRIFO[corGrifo]?.[1];
  document.documentElement.style.setProperty("--cor-grifo", c || "transparent");
  $("#btnGrifo").setAttribute("aria-pressed", grifando);
  $("#btnGrifo").title = grifando ? "Marca-texto ligado: selecione o texto para pintar (clique para desligar)" : "Ligar o marca-texto";
  document.body.classList.toggle("grifando", grifando);
  document.querySelectorAll("#coresGrifo .cor-grifo").forEach((b) => b.setAttribute("aria-checked", b.dataset.cor === corGrifo));
}
$("#btnGrifo").onclick = () => { grifando = !grifando; guardar("grifando", grifando); mostrarGrifo(); toast(grifando ? "Marca-texto ligado: selecione o texto para pintar" : "Marca-texto desligado"); };
$("#btnCoresGrifo").onclick = () => abrirMenu("#popGrifo", $("#btnCoresGrifo"));
$("#coresGrifo").onclick = (e) => {
  const b = e.target.closest("[data-cor]"); if (!b) return;
  corGrifo = b.dataset.cor; grifando = true; guardar("corGrifo", corGrifo); guardar("grifando", true); mostrarGrifo(); fecharMenus();
};
mostrarGrifo();

// posição de um ponto (nó + deslocamento) contada em caracteres desde o início do texto do tópico
const textoTopico = () => $(".folha > .texto");
function posicao(raiz, no, desl) {
  const r = document.createRange(); r.selectNodeContents(raiz); r.setEnd(no, desl);
  return r.toString().length;
}
// tira os grifos desenhados (volta ao texto puro) e desenha de novo os do tópico aberto
function pintarGrifos() {
  const raiz = textoTopico(); if (!raiz || !estudo) return;
  raiz.querySelectorAll("mark.grifo").forEach((m) => { const p = m.parentNode; m.replaceWith(...m.childNodes); p.normalize(); });
  const meus = (estudo.grifos || []).filter((g) => g.topico === topico).sort((a, b) => a.ini - b.ini);
  if (!meus.length) return;
  // percorre os pedaços de texto e embrulha a parte de cada um que cai dentro de um grifo
  const nos = []; const w = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
  for (let n, pos = 0; (n = w.nextNode()); pos += n.length) nos.push([n, pos]);
  for (const [n, ini] of nos.reverse()) {
    const fim = ini + n.length;
    for (const g of meus.filter((g) => g.ini < fim && g.fim > ini).reverse()) {
      const a = Math.max(g.ini, ini) - ini, b = Math.min(g.fim, fim) - ini;
      if (!n.data.slice(a, b).trim()) continue;
      const meio = n.splitText(a); meio.splitText(b - a);
      const m = document.createElement("mark");
      m.className = "grifo"; m.dataset.cor = g.cor; m.style.setProperty("--c", CORES_GRIFO[g.cor]?.[1] || "#ffe95c");
      meio.replaceWith(m); m.append(meio);
    }
  }
}
// pinta (ou apaga, com a borracha) o trecho entre ini e fim; a cor nova vence onde houver outra
function grifar(ini, fim, cor) {
  if (fim <= ini) return;
  const resto = [];
  for (const g of estudo.grifos || []) {
    if (g.topico !== topico || g.fim <= ini || g.ini >= fim) { resto.push(g); continue; }
    if (g.ini < ini) resto.push({ ...g, fim: ini });
    if (g.fim > fim) resto.push({ ...g, ini: fim });
  }
  if (cor !== "borracha") resto.push({ topico, ini, fim, cor });
  // grifos encostados e da mesma cor viram um só
  const unidos = [];
  for (const g of resto.sort((a, b) => a.topico - b.topico || a.ini - b.ini)) {
    const u = unidos[unidos.length - 1];
    if (u && u.topico === g.topico && u.cor === g.cor && g.ini <= u.fim) u.fim = Math.max(u.fim, g.fim); else unidos.push({ ...g });
  }
  estudo.grifos = unidos;
  salvarEstudo(estudo);
  pintarGrifos();
}
// a seleção atual dentro do texto do tópico, em posições; null se estiver fora
function selecaoNoTexto() {
  const sel = getSelection(), raiz = textoTopico();
  if (!raiz || !sel.rangeCount || sel.isCollapsed) return null;
  const r = sel.getRangeAt(0);
  if (!raiz.contains(r.commonAncestorContainer) && !r.intersectsNode(raiz)) return null;
  const ini = raiz.contains(r.startContainer) ? posicao(raiz, r.startContainer, r.startOffset) : 0;
  const fim = raiz.contains(r.endContainer) ? posicao(raiz, r.endContainer, r.endOffset) : raiz.textContent.length;
  return fim > ini ? { ini, fim } : null;
}
// modo ligado: soltar o mouse (ou o dedo) depois de selecionar já pinta
const pintarSelecao = () => {
  if (!grifando || !estudo) return;
  setTimeout(() => {
    const s = selecaoNoTexto(); if (!s) return;
    grifar(s.ini, s.fim, corGrifo);
    getSelection().removeAllRanges();
    $("#barraMarca").hidden = true;
  }, 10);
};
document.addEventListener("mouseup", (e) => { if (e.target.closest?.(".folha")) pintarSelecao(); });
document.addEventListener("touchend", (e) => { if (e.target.closest?.(".folha")) setTimeout(pintarSelecao, 350); });
// modo desligado: as bolinhas da barrinha da seleção pintam e já deixam a cor escolhida
$("#coresBarra").onmousedown = (e) => e.preventDefault();
$("#coresBarra").onclick = (e) => {
  const b = e.target.closest("[data-cor]"); if (!b) return;
  const s = selecaoNoTexto(); if (!s) return;
  if (b.dataset.cor !== "borracha") { corGrifo = b.dataset.cor; guardar("corGrifo", corGrifo); mostrarGrifo(); }
  grifar(s.ini, s.fim, b.dataset.cor);
  getSelection().removeAllRanges();
  $("#barraMarca").hidden = true;
};

// ---------- marcar dúvida ----------
// Selecionar um trecho da folha mostra a barrinha; a escolha marca as frases e cria um item em "Minhas dúvidas".
// A IA explica (ou vira flash card) usando o tópico como contexto. Fica salvo em estudo.marcas.
const PEDIDOS = {
  explicar: ["Explicar melhor", "Explique este trecho de forma mais completa e clara, como um professor, ligando-o ao resto do tópico."],
  exemplo: ["Dar exemplo", "Dê um ou dois exemplos concretos do dia a dia ou do trabalho que ilustrem este trecho."],
  simples: ["Mais simples", "Explique este trecho com palavras bem simples, como para alguém que nunca estudou o assunto, sem termos técnicos."],
  pergunta: ["Pergunta", ""],
};
let selecaoAtual = null;
function frasesDaSelecao(sel) {
  const r = sel.getRangeAt(0);
  return [...document.querySelectorAll(".folha .frase")].filter((f) => r.intersectsNode(f)).filter((f) => !f.closest(".pergunta"));
}
document.addEventListener("selectionchange", () => {
  clearTimeout(selecaoAtual?.tm);
  const tm = setTimeout(() => {
    const sel = getSelection();
    const barra = $("#barraMarca");
    if (!estudo || grifando || modo !== "ler" || !sel.rangeCount || sel.isCollapsed || sel.toString().trim().length < 3) { barra.hidden = true; return; }
    const frasesSel = frasesDaSelecao(sel);
    if (!frasesSel.length) { barra.hidden = true; return; }
    selecaoAtual = { texto: sel.toString().trim().replace(/\s+/g, " "), frases: frasesSel.map((f) => f.textContent.trim()) };
    barra.hidden = false;
    const r = sel.getRangeAt(0).getBoundingClientRect(), w = barra.offsetWidth, h = barra.offsetHeight;
    barra.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    // no celular o menu do próprio sistema aparece em cima da seleção: a barrinha vai embaixo
    const embaixo = matchMedia("(pointer: coarse)").matches || r.top - h - 10 < 70;
    barra.style.top = (embaixo ? Math.min(innerHeight - h - 90, r.bottom + 10) : r.top - h - 10) + "px";
  }, 250);
  selecaoAtual = { ...(selecaoAtual || {}), tm };
});
document.querySelectorAll("#barraMarca button[data-acao]").forEach((b) => {
  b.onmousedown = (e) => e.preventDefault(); // não perder a seleção ao clicar
  b.onclick = () => marcar(b.dataset.acao);
});

function marcar(acao) {
  if (!selecaoAtual?.texto) return;
  $("#barraMarca").hidden = true;
  const m = { id: String(Date.now()), topico, trecho: selecaoAtual.texto, frases: selecaoAtual.frases, acao, criado: new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) };
  getSelection().removeAllRanges();
  (estudo.marcas ||= []).push(m);
  salvarEstudo(estudo);
  pintarMarcas();
  abrirDuvidas(m.id);
  if (acao === "comentar") return;
  responderMarca(m);
}

async function responderMarca(m, pergunta) {
  const chave = pedirChave();
  if (!chave) { m.erro = "Coloque a chave do Gemini para a IA responder."; salvarEstudo(estudo); return listarDuvidas(); }
  const e = estudo, tp = e.topicos[m.topico] || {};
  m.carregando = true; delete m.erro; listarDuvidas(m.id);
  const contexto = `TÓPICO: ${tp.titulo}\n${tp.texto}\n\nTRECHO MARCADO PELO ESTUDANTE: "${m.trecho}"`;
  try {
    if (m.acao === "cartao") {
      const o = await gemini(`Crie UM flash card para estudar o trecho marcado, em português do Brasil: frente curta (pergunta direta ou conceito) e verso com a resposta em uma ou duas frases.\n\n${contexto}\n\nResponda SOMENTE com JSON: {"frente":"...","verso":"..."}`,
        chave, () => {}, (o) => o.frente && o.verso);
      (tp.cartoes ||= []).push({ frente: o.frente, verso: o.verso });
      m.resposta = `Flash card criado:\n${o.frente}\n→ ${o.verso}`;
    } else {
      const pedido = m.acao === "pergunta" ? `Responda a pergunta do estudante sobre o trecho: "${pergunta || m.pergunta}"` : PEDIDOS[m.acao][1];
      const o = await gemini(`Você é um professor ajudando alguém a estudar. ${pedido}\nUse o tópico como contexto. Responda em português do Brasil, em texto corrido para ser OUVIDO (sem listas, asteriscos ou markdown), de 3 a 6 frases.\n\n${contexto}\n\nResponda SOMENTE com JSON: {"resposta":"..."}`,
        chave, () => {}, (o) => typeof o.resposta === "string" && o.resposta.trim());
      m.resposta = o.resposta.trim();
    }
  } catch (err) { m.erro = "A IA não respondeu: " + err.message; }
  delete m.carregando;
  salvarEstudo(e);
  if (estudo?.id === e.id) {
    listarDuvidas(m.id);
    const a = $(".abas"); if (a && m.acao === "cartao") { a.outerHTML = abas(); ligarAbas(); } // atualiza "Flash cards (N)"
  }
}
// ouvir a explicação da IA com a mesma voz da leitura. Enquanto toca, o botão vira "Pausar" e o play principal
// mostra ⏸ e pausa ela (antes o play principal começava a leitura e não havia como parar a explicação).
let ouvindo = null; // id da dúvida tocando
function ouvirTexto(texto, id) {
  parar();
  const minha = ++falaCartao;
  ouvindo = id; marcarOuvindo();
  carregando(true);
  sintetizar(texto).then((url) => {
    if (minha !== falaCartao || ouvindo !== id) return;
    audio.src = url;
    audio.onended = audio.onpause = () => { if (ouvindo === id) { ouvindo = null; marcarOuvindo(); } };
    audio.play().catch(() => {});
  }).catch(() => {}).finally(() => carregando(false));
}
function pararOuvir() {
  if (!ouvindo) return;
  ouvindo = null; falaCartao++; audio.onpause = null; audio.pause(); carregando(false); marcarOuvindo();
}
function marcarOuvindo() {
  document.querySelectorAll("[data-ouvir]").forEach((b) => (b.textContent = b.dataset.ouvir === ouvindo ? "⏸ Pausar" : "▶ Ouvir"));
  $("#tocar").innerHTML = ouvindo || tocando ? PAUSA : PLAY;
}

// marca as frases do tópico aberto que fazem parte de algum trecho marcado
function pintarMarcas() {
  if (!estudo) return;
  const minhas = (estudo.marcas || []).filter((m) => m.topico === topico);
  const textos = new Map(); // frase → ids das marcas (uma frase pode ter várias dúvidas)
  minhas.forEach((m) => m.frases.forEach((f) => textos.set(f, [...(textos.get(f) || []), m.id])));
  document.querySelectorAll(".folha .frase").forEach((f) => {
    const ids = textos.get(f.textContent.trim());
    f.classList.toggle("marcada", !!ids);
    if (ids) f.dataset.marca = ids.join(" "); else delete f.dataset.marca;
  });
  const n = (estudo.marcas || []).length;
  $("#contaDuvidas").textContent = n;
  $("#btnDuvidas").classList.toggle("tem", n > 0);
}

function listarDuvidas(novo) {
  const marcas = [...(estudo.marcas || [])].reverse();
  $("#duvidasInfo").textContent = marcas.length ? `${marcas.length} trecho${marcas.length > 1 ? "s" : ""} marcado${marcas.length > 1 ? "s" : ""}` : "Selecione um trecho do texto para marcar";
  $("#listaDuvidas").innerHTML = marcas.length ? marcas.map((m) => {
    const tipo = m.acao === "comentar" ? "Comentário" : m.acao === "cartao" ? "Flash card" : m.acao === "pergunta" ? "Pergunta: " + esc(m.pergunta || "") : PEDIDOS[m.acao]?.[0] || "Dúvida";
    const corpo = m.acao === "comentar"
      ? `<textarea data-coment="${m.id}" placeholder="Escreva sua anotação…">${esc(m.comentario || "")}</textarea>`
      : m.carregando ? `<div class="pensando">A IA está ${m.acao === "cartao" ? "criando o cartão" : "explicando"}…</div>`
      : m.erro ? `<div class="resposta" style="color:var(--erro)">${esc(m.erro)}</div>`
      : `<div class="resposta">${esc(m.resposta || "")}</div>`;
    return `<div class="duvida ${m.id === novo ? "nova" : ""}" data-id="${m.id}">
      <span class="tipo">${tipo} · tópico ${m.topico + 1}</span>
      <blockquote>${esc(m.trecho.length > 220 ? m.trecho.slice(0, 220) + "…" : m.trecho)}</blockquote>${corpo}
      <div class="acoes">
        ${m.resposta && m.acao !== "cartao" ? `<button data-ouvir="${m.id}">▶ Ouvir</button>` : ""}
        <button data-ir="${m.id}">Ir ao trecho</button>
        ${m.acao !== "comentar" && !m.carregando ? `<button data-perguntar="${m.id}">Perguntar mais</button>` : ""}
        ${m.erro ? `<button data-refazer="${m.id}">Tentar de novo</button>` : ""}
        <button class="perigo" data-tirar="${m.id}">Apagar</button>
      </div></div>`;
  }).join("") : `<div class="vazio-duvidas">Não entendeu alguma parte? <b>Selecione o trecho no texto</b> e escolha “Explicar melhor”, “Dar exemplo”, “Mais simples”, “Virar flash card” ou “Comentar”. Tudo fica guardado aqui para revisar antes da prova.</div>`;
  const acha = (id) => estudo.marcas.find((m) => m.id === id);
  document.querySelectorAll("[data-coment]").forEach((t) => (t.oninput = () => { acha(t.dataset.coment).comentario = t.value; salvarEstudo(estudo); }));
  document.querySelectorAll("[data-ouvir]").forEach((b) => (b.onclick = () => (ouvindo === b.dataset.ouvir ? pararOuvir() : ouvirTexto(acha(b.dataset.ouvir).resposta, b.dataset.ouvir))));
  marcarOuvindo();
  document.querySelectorAll("[data-refazer]").forEach((b) => (b.onclick = () => responderMarca(acha(b.dataset.refazer))));
  document.querySelectorAll("[data-tirar]").forEach((b) => (b.onclick = () => {
    estudo.marcas = estudo.marcas.filter((m) => m.id !== b.dataset.tirar); salvarEstudo(estudo); pintarMarcas(); listarDuvidas();
  }));
  // "Perguntar mais": abre um campo dentro do próprio cartão (sem janela do navegador)
  document.querySelectorAll("[data-perguntar]").forEach((b) => (b.onclick = () => {
    const cartao = b.closest(".duvida");
    if (cartao.querySelector(".nova-pergunta")) return cartao.querySelector(".nova-pergunta textarea").focus();
    b.closest(".acoes").insertAdjacentHTML("beforebegin", `<div class="nova-pergunta" style="display:grid;gap:6px">
      <textarea placeholder="O que você quer perguntar sobre este trecho?"></textarea>
      <div class="acoes"><button class="enviar">Perguntar à IA</button><button class="cancelar">Cancelar</button></div></div>`);
    const caixa = cartao.querySelector(".nova-pergunta"), campo = caixa.querySelector("textarea");
    campo.focus();
    caixa.querySelector(".cancelar").onclick = () => caixa.remove();
    const enviar = () => {
      const pergunta = campo.value.trim();
      if (!pergunta) return campo.focus();
      const base = acha(b.dataset.perguntar);
      const m = { id: String(Date.now()), topico: base.topico, trecho: base.trecho, frases: base.frases, acao: "pergunta", pergunta, criado: new Date().toLocaleString("pt-BR") };
      estudo.marcas.push(m); salvarEstudo(estudo); pintarMarcas(); responderMarca(m, pergunta);
    };
    caixa.querySelector(".enviar").onclick = enviar;
    campo.onkeydown = (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); } };
  }));
  document.querySelectorAll("[data-ir]").forEach((b) => (b.onclick = () => {
    const m = acha(b.dataset.ir);
    fecharDuvidas();
    if (modo !== "ler") { modo = "ler"; document.body.classList.remove("modo-cartoes"); }
    if (m.topico !== topico || !document.querySelector(`.frase[data-marca~="${m.id}"]`)) { parar(); montar(m.topico); }
    const f = document.querySelector(`.frase[data-marca~="${m.id}"]`);
    f?.scrollIntoView({ block: "center", behavior: "smooth" });
    document.querySelectorAll(`.frase[data-marca~="${m.id}"]`).forEach((x) => { x.classList.remove("piscar"); void x.offsetWidth; x.classList.add("piscar"); });
  }));
}
function abrirDuvidas(novo) {
  if (!estudo) return;
  fecharMenus(); fecharSumario();
  listarDuvidas(novo);
  $("#duvidas").hidden = $("#fundoDuvidas").hidden = false;
}
function fecharDuvidas() { pararOuvir(); $("#duvidas").hidden = $("#fundoDuvidas").hidden = true; }
$("#btnDuvidas").onclick = () => abrirDuvidas();
$("#fecharDuvidas").onclick = fecharDuvidas;
$("#fundoDuvidas").onclick = fecharDuvidas;
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { fecharDuvidas(); $("#barraMarca").hidden = true; } });

function ir(i) {
  pos = Math.max(0, Math.min(i, fila.length - 1));
  document.querySelectorAll(".frase").forEach((f) => { const n = +f.dataset.i; f.classList.toggle("atual", n === pos); f.classList.toggle("lida", n < pos); });
  fila.forEach((it, n) => { if (it.tipo === "resposta" && n <= pos) document.querySelector(`[data-i="${n}"]`)?.closest(".r")?.classList.remove("oculta"); });
  document.querySelector(".frase.atual")?.scrollIntoView({ block: "center", behavior: "smooth" });
  if (!estudo) return;
  const pct = (topico + (fila.length ? pos / fila.length : 0)) / estudo.topicos.length;
  $("#linhaProgresso").style.width = Math.round(pct * 100) + "%";
  guardar("pos:" + estudo.id, { topico, pos, pct });
  if (fila.length && pos >= fila.length - 1) marcarLido(estudo, topico);
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
  pomoAoEstudar();
  sessaoMidia();
  while (ativa()) {
    const it = fila[pos];
    if (!it) {
      if (modo === "guiado") { marcarLido(estudo, topico); return irEtapa(3); }
      if (topico < estudo.topicos.length - 1) { await virarFolha("frente", () => montar(topico + 1)); if (!ativa()) return; continue; }
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
    const aviso = setTimeout(() => carregando(true), 150); // só mostra se demorar (frase já pronta não pisca)
    let url;
    try { url = await p; } catch (e) { $("#vozTexto").textContent = "Erro na voz: " + e.message; return parar(); }
    finally { clearTimeout(aviso); carregando(false); atual?.classList.remove("gerando"); }
    if (!ativa()) return;
    audio.src = url;
    await audio.play().catch(() => {});
    const terminou = await new Promise((fim) => { audio.onended = () => fim(true); audio.onpause = () => fim(audio.ended); });
    if (!terminou || !ativa()) return;
    pos++;
  }
}
// play com anel girando enquanto a voz gera a frase: o clique funcionou, só está preparando
function carregando(sim) {
  const b = $("#tocar");
  b.classList.toggle("carregando", sim);
  b.setAttribute("aria-busy", sim);
  b.title = sim ? "Gerando a voz…" : "Tocar / pausar (espaço)";
}
function parar() {
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  if (ouvindo) { ouvindo = null; marcarOuvindo(); }
  carregando(false);
  tocando = false; $("#tocar").innerHTML = PLAY; audio.onpause = null; audio.pause();
  if (espera) { espera(false); espera = null; }
}

$("#tocar").onclick = () => {
  if (modo === "guiado" && guia.etapa !== 2 && !ouvindo) return falandoGuia() || $("#tocar").classList.contains("carregando") ? calarGuia() : guia.falar && falarGuia(guia.falar);
  ouvindo ? pararOuvir() : tocando ? parar() : tocar();
};
const pular = (f) => () => { const t = tocando; parar(); f(); if (t) tocar(); };
$("#fraseAnt").onclick = pular(() => ir(pos - 1));
$("#fraseProx").onclick = pular(() => ir(pos + 1));
document.onkeydown = (e) => {
  if (["SELECT", "INPUT"].includes(e.target.tagName)) return;
  if (modo === "guiado" && guia.etapa !== 2) return;
  if (modo === "simulado") return teclaSimulado(e);
  if (modo === "cartoes") { // espaço vira; 1/← não sabia; 2/→ sabia
    if (e.code === "Space") { e.preventDefault(); $("#virar")?.click(); }
    if (["Digit1", "ArrowLeft"].includes(e.code)) $("#naoSabia")?.click();
    if (["Digit2", "ArrowRight"].includes(e.code)) $("#sabia")?.click();
    return;
  }
  if (e.code === "Space") { e.preventDefault(); $("#tocar").click(); }
  if (e.code === "ArrowLeft") $("#fraseAnt").click();
  if (e.code === "ArrowRight") $("#fraseProx").click();
  if (e.code === "KeyM") alternarMudo();
};

// ---------- flash cards ----------
// Baralho = cartões que a IA criou + perguntas de revisão. Caixas (0 a 5) salvas por material: errou volta para a 0
// e reaparece logo na mesma rodada; acertou sobe uma caixa. A rodada começa pelas caixas mais baixas.
let modo = "ler", sessao = [], virado = false, filtroTopico = "todos", falaCartao = 0;
let rodada = { total: 0, acertos: 0, erros: 0 }; // placar da rodada: muda a cada resposta
const DOMINADO = 2; // acertou em 2 rodadas seguidas (errar zera)
const baralho = (e) => e.topicos.flatMap((t, i) => [
  ...(t.cartoes || []).map((c) => ({ t: i, frente: c.frente, verso: c.verso })),
  ...(t.perguntas || []).map((q) => ({ t: i, frente: q.pergunta, verso: q.resposta })),
]).filter((c) => c.frente && c.verso).map((c) => ({ ...c, chave: c.t + "|" + c.frente }));
const caixas = () => lembrar("caixas:" + estudo.id, {});

function abas() {
  const n = baralho(estudo).length;
  return `<div class="abas" role="tablist"><button class="aba ${modo === "ler" ? "ativo" : ""}" data-modo="ler" role="tab">Ler</button>` +
    `<button class="aba ${modo === "guiado" ? "ativo" : ""}" data-modo="guiado" role="tab">Estudo guiado</button>` +
    `<button class="aba ${modo === "cartoes" ? "ativo" : ""}" data-modo="cartoes" role="tab">Flash cards${n ? ` (${n})` : ""}</button>` +
    `<button class="aba ${modo === "simulado" ? "ativo" : ""}" data-modo="simulado" role="tab">Simulado</button></div>`;
}
function ligarAbas() {
  document.querySelectorAll(".aba").forEach((b) => (b.onclick = () => {
    if (b.dataset.modo === modo) return;
    parar(); calarGuia(); calarSimulado(); modo = b.dataset.modo;
    document.body.classList.toggle("modo-cartoes", modo === "cartoes");
    document.body.classList.toggle("modo-simulado", modo === "simulado");
    document.body.classList.remove("guia-passo");
    modo === "cartoes" ? novaRodada() : modo === "guiado" ? iniciarGuiado() : modo === "simulado" ? iniciarSimulado() : montar(topico, pos);
  }));
}

function novaRodada() {
  const cx = caixas();
  const todos = baralho(estudo).filter((c) => filtroTopico === "todos" || c.t === +filtroTopico);
  sessao = todos.map((c) => ({ c, s: (cx[c.chave] || 0) + Math.random() })).sort((a, b) => a.s - b.s).map((x) => x.c);
  rodada = { total: sessao.length, acertos: 0, erros: 0 };
  if (sessao.length) pomoAoEstudar();
  virado = false;
  montarCartoes();
}

function falarCartao(texto) {
  const minha = ++falaCartao;
  audio.pause();
  if (!$("#lerCartao")?.checked) return;
  sintetizar(texto).then((url) => { if (minha === falaCartao && modo === "cartoes") { audio.src = url; audio.play().catch(() => {}); } }).catch(() => {});
}

function montarCartoes() {
  const cx = caixas();
  const todos = baralho(estudo).filter((c) => filtroTopico === "todos" || c.t === +filtroTopico);
  const dominados = todos.filter((c) => (cx[c.chave] || 0) >= DOMINADO).length;
  const feitos = rodada.total - new Set(sessao.map((c) => c.chave)).size; // cartões que já saíram desta rodada
  const semIa = !estudo.topicos.some((t) => t.cartoes?.length);
  const filtro = `<select id="filtro"><option value="todos">Todos os tópicos</option>${estudo.topicos.map((t, i) =>
    `<option value="${i}" ${String(i) === filtroTopico ? "selected" : ""}>${i + 1}. ${esc(t.titulo)}</option>`).join("")}</select>`;
  const gerar = semIa ? `<button class="sec" id="gerarCartoes">${todos.length ? "Gerar mais cartões com IA" : "Gerar flash cards com IA"}</button>` : "";
  let corpo;
  if (!todos.length) corpo = `<div class="vazio"><h2>Ainda não há flash cards</h2><p>Gere os cartões com IA a partir deste material.</p></div>`;
  else if (!sessao.length) { revisoesFeitas(); corpo = `<div class="fim-rodada"><h2>Rodada concluída</h2>
    <p>${rodada.acertos} acertos e ${rodada.erros} erros nesta rodada · ${dominados} de ${todos.length} cartões dominados.</p>
    <button class="pri" id="recomecar">Nova rodada</button></div>`; }
  else {
    const c = sessao[0];
    corpo = `<div class="flash ${virado ? "virado" : ""} ${entrar ? "entrando" : ""}" id="virar" role="button" tabindex="0" aria-label="Virar cartão">
        <span class="lado">${virado ? "Resposta" : "Pergunta"} · ${esc(estudo.topicos[c.t]?.titulo || "")}</span>
        <div class="frente">${esc(c.frente)}</div>
        ${virado ? `<div class="verso">${esc(c.verso)}</div>` : `<small>Toque para ver a resposta (espaço)</small>`}
      </div>
      <div class="respostas">${virado
        ? `<button class="nao" id="naoSabia">Não sabia <kbd>1</kbd></button><button class="sim" id="sabia">Sabia <kbd>2</kbd></button>`
        : `<span>Pense na resposta antes de virar.</span>`}</div>`;
  }
  $("#coluna").innerHTML = faixaIa() + abas() +
    `<div class="cartoes-topo">${filtro}<label><input type="checkbox" id="lerCartao" ${lembrar("lerCartao", true) ? "checked" : ""}> Ler em voz alta</label>${gerar}</div>` +
    (todos.length ? `<div class="placar" aria-live="polite">
        <span>${sessao.length ? `Cartão ${Math.min(feitos + 1, rodada.total)} de ${rodada.total}` : `${rodada.total} de ${rodada.total}`} · <b class="ok">✓ ${rodada.acertos}</b> · <b class="erro">✗ ${rodada.erros}</b></span>
        <span title="Dominado = acertou o cartão em 2 rodadas seguidas (errar zera)">${dominados} de ${todos.length} dominados</span></div>
      <div class="barra-dominio"><i style="width:${rodada.total ? Math.round((feitos / rodada.total) * 100) : 0}%"></i></div>` : "") + corpo;
  entrar = false;
  if (ultima) { $(".placar b." + ultima)?.classList.add("pulo"); ultima = null; }
  ligarAbas();
  $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
  $("#filtro").onchange = (e) => { filtroTopico = e.target.value; novaRodada(); };
  $("#lerCartao").onchange = (e) => { guardar("lerCartao", e.target.checked); if (!e.target.checked) audio.pause(); };
  $("#recomecar") && ($("#recomecar").onclick = novaRodada);
  $("#gerarCartoes") && ($("#gerarCartoes").onclick = gerarCartoes);
  if (sessao.length) {
    $("#virar").onclick = () => { if (virado) return; virado = true; montarCartoes(); falarCartao(sessao[0].verso); };
    $("#naoSabia") && ($("#naoSabia").onclick = () => responder(false));
    $("#sabia") && ($("#sabia").onclick = () => responder(true));
  }
}

// a resposta anima o cartão antes de trocar: acertou brilha verde e sai para a direita, errou balança e sai à esquerda
let animando = false, entrar = false, ultima = null;
function responder(sabia) {
  if (animando) return;
  const el = $("#virar");
  if (el && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    animando = true;
    el.classList.add(sabia ? "acertou" : "errou");
    document.querySelectorAll(".respostas button").forEach((b) => (b.disabled = true));
    setTimeout(() => { animando = false; entrar = true; registrarResposta(sabia); }, 480);
  } else registrarResposta(sabia);
}
function registrarResposta(sabia) {
  const c = sessao.shift(), cx = caixas();
  cx[c.chave] = sabia ? Math.min(5, (cx[c.chave] || 0) + 1) : 0;
  guardar("caixas:" + estudo.id, cx);
  sabia ? rodada.acertos++ : rodada.erros++;
  ultima = sabia ? "ok" : "erro";
  if (!sabia) sessao.splice(Math.min(3, sessao.length), 0, c); // errou: volta daqui a 3 cartões
  virado = false;
  montarCartoes();
  if (sessao.length) falarCartao(sessao[0].frente);
}

// material sem cartões (aberto sem IA ou organizado antes desta função): a IA cria os cartões a partir dos tópicos
async function gerarCartoes() {
  const chave = pedirChave();
  if (!chave) return;
  const e = estudo, st = $("#estado"); st.className = "estado";
  const grupos = []; let atual = "";
  e.topicos.forEach((t, i) => {
    const bloco = `## ${i}. ${t.titulo}\n${t.texto}\n\n`;
    if (atual && atual.length + bloco.length > 20000) { grupos.push(atual); atual = ""; }
    atual += bloco;
  });
  if (atual) grupos.push(atual);
  $("#gerarCartoes").disabled = true;
  try {
    for (let g = 0; g < grupos.length; g++) {
      const aviso = (t) => (st.textContent = `Flash cards, parte ${g + 1} de ${grupos.length}: ${t}`);
      aviso("gerando…");
      const o = await gemini(INSTRUCAO_CARTOES + "\n\nMATERIAL:\n" + grupos[g], chave, aviso, (o) => Array.isArray(o.cartoes) && o.cartoes.length);
      for (const c of o.cartoes) {
        const t = e.topicos[+c.topico] || e.topicos.at(-1);
        (t.cartoes ||= []).push({ frente: c.frente, verso: c.verso });
      }
      salvarEstudo(e);
    }
    st.textContent = "";
  } catch (err) { st.className = "estado erro"; st.textContent = "Flash cards: " + err.message; }
  if (estudo?.id === e.id && modo === "cartoes") novaRodada();
}
{ const v = lembrar("pensar", null); if (v !== null) $("#pensar").value = v; }
$("#pensar").onchange = () => guardar("pensar", $("#pensar").value);
// preferências de estudo: com ou sem perguntas de revisão e resumo (somem da tela e da leitura)
for (const id of ["prefPerguntas", "prefResumo"]) {
  $("#" + id).checked = lembrar(id, true);
  $("#" + id).onchange = () => {
    guardar(id, $("#" + id).checked);
    $("#linhaPensar").hidden = !$("#prefPerguntas").checked;
    if (estudo && modo === "ler") { const t = tocando; parar(); montar(topico, 0); if (t) tocar(); }
  };
}
$("#linhaPensar").hidden = !$("#prefPerguntas").checked;


// ---------- objetivo do estudo ----------
// A organização muda conforme o objetivo (prova, entrevista, trabalho, aprender). Padrão: a IA identifica.
const OBJETIVOS = {
  prova: ["Prova ou concurso", "O estudante vai fazer uma PROVA ou CONCURSO: priorize definições, números, datas, listas, exceções e pegadinhas que costumam cair; perguntas e flash cards no estilo de prova."],
  entrevista: ["Entrevista de emprego", "O estudante vai fazer uma ENTREVISTA DE EMPREGO sobre este assunto: em cada tópico, diga como ele costuma aparecer numa entrevista; as perguntas de revisão são perguntas que um entrevistador faria, com respostas-modelo curtas, em primeira pessoa, com um exemplo prático."],
  trabalho: ["Trabalho / atualização", "O estudante quer se ATUALIZAR para o TRABALHO: foque no que muda na prática, aplicações, cuidados e boas práticas; menos decoreba."],
  aprender: ["Aprender por conta", "O estudante quer APRENDER por interesse próprio: explique com calma, com exemplos e analogias do dia a dia; perguntas de compreensão, não de decoreba."],
};
function linhaObjetivo(obj) {
  if (!obj || obj.tipo === "auto")
    return `- Identifique o objetivo mais provável de quem estuda este material entre: prova (prova ou concurso), entrevista (entrevista de emprego), trabalho (atualização profissional), aprender (interesse próprio). Organize pensando nele e informe no JSON em "objetivo" (uma dessas palavras).\n`;
  if (obj.tipo === "outro") return `- Objetivo do estudante, nas palavras dele: "${obj.texto}". Organize pensando nisso.\n`;
  return `- ${OBJETIVOS[obj.tipo][1]}\n`;
}
const nomeObjetivo = (obj) => (!obj ? "" : obj.tipo === "outro" ? obj.texto : OBJETIVOS[obj.tipo]?.[0] || "");
let objetivoNovo = lembrar("objetivo", { tipo: "auto" });
function desenharObjetivo() {
  document.querySelectorAll("[data-obj]").forEach((b) => b.classList.toggle("ativo", b.dataset.obj === objetivoNovo.tipo));
  $("#objOutro").hidden = objetivoNovo.tipo !== "outro";
  $("#objetivoBox").hidden = !$("#usarIa").checked;
}
document.querySelectorAll("[data-obj]").forEach((b) => (b.onclick = () => {
  objetivoNovo = b.dataset.obj === "outro" ? { tipo: "outro", texto: $("#objOutro").value.trim() } : { tipo: b.dataset.obj };
  guardar("objetivo", objetivoNovo); desenharObjetivo();
  if (b.dataset.obj === "outro") $("#objOutro").focus();
}));
$("#objOutro").value = objetivoNovo.texto || "";
$("#objOutro").oninput = () => { objetivoNovo = { tipo: "outro", texto: $("#objOutro").value.trim() }; guardar("objetivo", objetivoNovo); };
$("#usarIa").addEventListener("change", desenharObjetivo);
desenharObjetivo();
// objetivo escolhido para o próximo material ("Outro" sem texto vira "A IA identifica")
const objetivoEscolhido = () => (objetivoNovo.tipo === "outro" && !objetivoNovo.texto ? { tipo: "auto" } : objetivoNovo);

// faixa no material: "Organizado pensando em… · Mudar" (mudar cria uma versão nova, organizada de novo pela IA)
function faixaObjetivo() {
  if (!estudo?.objetivo || estudo.organizado_por === "sem IA" || organizando.has(estudo.id)) return "";
  const auto = estudo.objetivo.tipo === "auto";
  return `<div class="faixa-obj" id="faixaObj"><span>🎯 Organizado pensando em: <b>${esc(auto ? "objetivo identificado pela IA" : nomeObjetivo(estudo.objetivo))}</b>${estudo.objetivo.detectado ? " <small>(a IA identificou)</small>" : ""}</span>
    <button class="link" id="mudarObj">Mudar</button></div>`;
}
function ligarObjetivo() {
  const b = $("#mudarObj"); if (!b) return;
  b.onclick = () => {
    $("#faixaObj").outerHTML = `<div class="faixa-obj aberta" id="faixaObj"><span>Organizar de novo pensando em:</span>
      <div class="chips-obj">${Object.entries(OBJETIVOS).map(([k, [n]]) => `<button data-reorg="${k}" class="${estudo.objetivo.tipo === k ? "ativo" : ""}">${n}</button>`).join("")}</div>
      <small>Cria uma versão nova deste material (usa a IA de novo). A atual continua na biblioteca.</small>
      <button class="link" id="cancelarObj">Cancelar</button></div>`;
    $("#cancelarObj").onclick = () => montar(topico, pos);
    document.querySelectorAll("[data-reorg]").forEach((c) => (c.onclick = () => {
      const chave = pedirChave(); if (!chave) return;
      const texto = estudo.original || estudo.topicos.map((t) => t.texto).join("\n\n");
      criarMaterial(estudo.titulo, texto, estudo.tipo, { tipo: c.dataset.reorg }, true);
    }));
  };
}

// ---------- tópico lido (base do plano): marca quando a leitura chega ao fim do tópico ----------
const dataLocal = (d = new Date()) => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
const hojeISO = () => dataLocal();
const somaDias = (iso, n) => { const d = new Date(iso + "T12:00"); d.setDate(d.getDate() + n); return dataLocal(d); };
const diasEntre = (a, b) => Math.round((new Date(b + "T12:00") - new Date(a + "T12:00")) / 86400000);
const dataBR = (iso) => new Date(iso + "T12:00").toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
function marcarLido(e, t) {
  if (!e || e.lidosEm?.[t]) return;
  (e.lidosEm ||= {})[t] = hojeISO();
  salvarEstudo(e);
}

// ---------- meu plano ----------
// Data da prova + materiais + minutos por dia da semana → distribui a leitura dos tópicos até a véspera e encaixa
// revisões dos flash cards 1, 3 e 7 dias depois de cada tópico lido; a véspera é de revisão geral. Recalcula todo dia
// com o que falta (atrasar ou adiantar só redistribui). Fica no localStorage ("plano") e vai no backup.
const DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const ESPACOS = [1, 3, 7];
const conta = (t) => (t || "").split(/\s+/).filter(Boolean).length;
const minTopico = (t) => Math.max(3, Math.round((conta(t.texto) + conta(t.resumo)) / 130 + (t.perguntas?.length || 0) + 1));
let naTelaPlano = false, rascunho = null;

function calcularPlano(pl, hoje = hojeISO()) {
  const mats = pl.materiais.map((id) => lembrar("estudo:" + id, null)).filter(Boolean);
  const pendentes = [], lidos = [];
  mats.forEach((e) => e.topicos.forEach((t, i) => (e.lidosEm?.[i] ? lidos : pendentes).push({ e, i, t, min: minTopico(t) })));
  const vespera = somaDias(pl.data, -1);
  const dias = [];
  for (let d = hoje; d <= vespera; d = somaDias(d, 1)) dias.push(d);
  const revGeral = dias.length >= 2 ? vespera : null;
  const agenda = Object.fromEntries(dias.map((d) => [d, { leitura: [], revisao: [], min: 0, cap: pl.minutos[new Date(d + "T12:00").getDay()] || 0 }]));
  const feito = (k) => !!pl.feitos?.[k];
  const marcarRevisoes = (e, i, base) => {
    if (!pl.revisoes) return;
    for (const n of ESPACOS) {
      const k = `${e.id}|${i}|${n}`, d = somaDias(base, n);
      if (feito(k) || d >= pl.data) continue;
      const dia = d < hoje ? hoje : d;
      if (agenda[dia] && dia !== revGeral) { agenda[dia].revisao.push({ e, i, k }); agenda[dia].min += 3; }
    }
  };
  lidos.forEach(({ e, i }) => marcarRevisoes(e, i, e.lidosEm[i]));
  // tópico fraco no simulado: revisão dos flash cards dele no dia marcado (as questões erradas viraram cartões)
  mats.forEach((e) => Object.entries(e.revisarEm || {}).forEach(([i, d]) => {
    const k = `${e.id}|${i}|sim${d}`, dia = d < hoje ? hoje : d;
    if (feito(k) || d >= pl.data || !agenda[dia] || dia === revGeral || agenda[dia].revisao.some((r) => r.e.id === e.id && r.i === +i)) return;
    agenda[dia].revisao.push({ e, i: +i, k }); agenda[dia].min += 3;
  }));
  const proximo = pendentes[0] || null; // para "Quer adiantar?"
  // espalha a leitura até a data (não enche o primeiro dia): a meta de cada dia é o que falta ÷ os dias de leitura que restam
  const diasLeitura = dias.filter((d) => d !== revGeral && agenda[d].cap > 0);
  let disponivel = 0;
  for (const d of dias) {
    const a = agenda[d];
    if (d === revGeral) { a.geral = true; a.min = a.cap; disponivel += a.cap; continue; }
    disponivel += a.cap;
    const restam = diasLeitura.length - diasLeitura.indexOf(d);
    const alvo = a.cap > 0 ? pendentes.reduce((n, p) => n + p.min, 0) / restam : 0;
    let lendo = 0;
    while (pendentes.length && a.cap > 0 && (!a.leitura.length ? a.min < a.cap : a.min + pendentes[0].min <= a.cap && lendo + pendentes[0].min <= alvo + 2)) {
      const p = pendentes.shift();
      a.leitura.push(p); a.min += p.min; lendo += p.min;
      marcarRevisoes(p.e, p.i, d); // revisões futuras desse tópico entram na conta dos próximos dias
    }
  }
  const total = mats.reduce((n, e) => n + e.topicos.length, 0);
  return { mats, agenda, dias, revGeral, proximo, falta: pendentes.reduce((n, p) => n + p.min, 0), sobra: pendentes.length,
    lidos: lidos.length, total, aLer: [...pendentes, ...Object.values(agenda).flatMap((a) => a.leitura)].reduce((n, p) => n + p.min, 0), disponivel };
}
// agrupa tópicos seguidos do mesmo material: "tópicos 5–8"
function grupos(itens) {
  const g = [];
  for (const it of itens) {
    const ult = g.at(-1);
    if (ult && ult.e.id === it.e.id) { ult.itens.push(it); ult.min += it.min || 3; } else g.push({ e: it.e, itens: [it], min: it.min || 3 });
  }
  return g;
}
const faixaTopicos = (is) => {
  const n = is.map((x) => x + 1).sort((a, b) => a - b);
  return n.length === 1 ? `tópico ${n[0]}` : n.every((x, k) => !k || x === n[k - 1] + 1) ? `tópicos ${n[0]}–${n.at(-1)}` : `tópicos ${n.join(", ")}`;
};
const horas = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`);

function mostrarPlano(editar = false) {
  parar(); estudo = null; preparo = null; naTelaPlano = true; modo = "ler";
  document.body.classList.add("na-biblioteca"); document.body.classList.remove("modo-cartoes", "modo-simulado");
  $("#navBiblioteca").classList.remove("ativo"); $("#navPlano").classList.add("ativo");
  $("#tituloTopo").textContent = "Meu plano"; $("#linhaProgresso").style.width = "0";
  const pl = lembrar("plano", null);
  if (!pl || editar) return formPlano(pl);
  const c = calcularPlano(pl), hoje = hojeISO(), a = c.agenda[hoje], faltam = diasEntre(hoje, pl.data);
  const focoHoje = lembrar(hojeChave(), 0) * pomo.foco;
  const lidosHoje = c.mats.flatMap((e) => Object.entries(e.lidosEm || {}).filter(([, d]) => d === hoje).map(([i]) => ({ e, i: +i })));
  const tarefa = (tipo, g) => {
    const is = g.itens.map((x) => x.i);
    const titulo = tipo === "ler" ? `Ler: ${esc(g.e.titulo)}` : `Revisar flash cards: ${esc(g.e.titulo)}`;
    return `<div class="tarefa"><button class="check" data-check="${tipo}|${g.e.id}|${is.join(",")}" aria-label="Marcar como feito"></button>
      <div class="info-t"><b>${titulo}</b><small>${faixaTopicos(is)} · ~${horas(g.min)}</small></div>
      <button class="pri" data-comecar="${tipo}|${g.e.id}|${is[0]}|${is.length}">Começar</button></div>`;
  };
  let tarefas = "";
  if (faltam < 0) tarefas = `<p class="vazio-t">A data do plano já passou. Edite o plano para uma nova data.</p>`;
  else if (faltam === 0) tarefas = `<p class="vazio-t">É hoje! Faça uma revisão leve dos flash cards e confie no que você estudou. Boa sorte! 🍀</p>`;
  else if (!a) tarefas = "";
  else if (a.geral) tarefas = `<div class="tarefa"><span class="check feito-ic">★</span><div class="info-t"><b>Revisão geral</b><small>Flash cards de todos os materiais e as suas dúvidas marcadas</small></div>
      <button class="pri" data-comecar="geral|${c.mats[0]?.id || ""}|0">Começar</button></div>`;
  else {
    tarefas = grupos(a.revisao).map((g) => tarefa("rev", g)).join("") + grupos(a.leitura).map((g) => tarefa("ler", g)).join("");
    if (!tarefas) tarefas = `<p class="vazio-t">${a.cap ? "Nada pendente para hoje. 🎉" : "Hoje é folga no seu plano. Descanse! 😌"}</p>` +
      (c.proximo ? `<div class="tarefa"><span class="check feito-ic" style="background:var(--destaque);border-color:var(--destaque)">+</span><div class="info-t"><b>Quer adiantar? ${esc(c.proximo.e.titulo)}</b><small>${faixaTopicos([c.proximo.i])} · ~${horas(c.proximo.min)}</small></div>
        <button class="sec" data-comecar="ler|${c.proximo.e.id}|${c.proximo.i}|1">Adiantar</button></div>` : "");
  }
  const feitosHoje = grupos(lidosHoje).map((g) => `<div class="tarefa feita"><span class="check feito-ic">✓</span><div class="info-t"><b>Lido: ${esc(g.e.titulo)}</b><small>${faixaTopicos(g.itens.map((x) => x.i))}</small></div></div>`).join("");
  const proximos = c.dias.slice(1, 8).map((d) => {
    const x = c.agenda[d], dt = new Date(d + "T12:00");
    const desc = x.geral ? "Revisão geral" : !x.cap ? "Folga" : [x.leitura.length && `ler ${x.leitura.length} tópico${x.leitura.length > 1 ? "s" : ""}`, x.revisao.length && `revisar ${x.revisao.length}`].filter(Boolean).join(" · ") || "livre";
    return `<li><span class="dia">${DIAS[dt.getDay()]} <small>${dataBR(d)}</small></span><span class="desc">${desc}</span><span class="min">${x.cap ? horas(Math.min(x.min || 0, x.cap) || 0) : "—"}</span></li>`;
  }).join("");
  const pct = c.total ? Math.round((c.lidos / c.total) * 100) : 0;
  $("#coluna").innerHTML = `<div class="plano">
    <div class="plano-cab"><div><small>🎯 Meu plano</small><h1>${esc(pl.titulo)}</h1>
      <span>${new Date(pl.data + "T12:00").toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" })} · ${faltam > 1 ? `faltam ${faltam} dias` : faltam === 1 ? "é amanhã!" : faltam === 0 ? "é hoje!" : "já passou"}</span></div>
      <button class="sec" id="editarPlano">Editar</button></div>
    <div class="plano-prog"><div class="rot"><span>${c.lidos} de ${c.total} tópicos lidos</span><b>${pct}%</b></div><div class="barra-dominio"><i style="width:${pct}%"></i></div></div>
    ${c.sobra ? `<div class="alerta-plano">⚠️ Não dá tempo de ler tudo até a prova: faltam ~${horas(c.falta)} de leitura além do que cabe nos seus dias. Aumente o tempo por dia em <b>Editar</b>, ou foque nos tópicos principais e use os flash cards nos outros.</div>` : ""}
    <section class="hoje-card"><div class="hoje-cab"><h2>Hoje <small>${DIAS[new Date().getDay()]} ${dataBR(hoje)}</small></h2>
      <span class="meta-hoje">${a && a.cap ? `${horas(Math.min(a.min, a.cap))} planejados` : ""}${focoHoje ? ` · 🍅 ${horas(focoHoje)} de foco` : ""}</span></div>
      ${tarefas}${feitosHoje}</section>
    ${proximos ? `<section class="proximos"><h2>Próximos dias</h2><ul>${proximos}</ul></section>` : ""}
    <button class="link perigo" id="apagarPlano">Apagar plano</button></div>`;
  $("#editarPlano").onclick = () => mostrarPlano(true);
  $("#apagarPlano").onclick = () => {
    const b = $("#apagarPlano");
    if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Clique de novo para apagar o plano"; return; }
    try { localStorage.removeItem("plano"); } catch {} mostrarPlano();
  };
  document.querySelectorAll("[data-check]").forEach((b) => (b.onclick = () => {
    const [tipo, id, is] = b.dataset.check.split("|"), e = lembrar("estudo:" + id, null);
    if (!e) return;
    if (tipo === "ler") is.split(",").forEach((i) => marcarLido(e, +i));
    else { pl.feitos ||= {}; is.split(",").forEach((i) => { ESPACOS.forEach((n) => { if (somaDias(e.lidosEm?.[i] || hoje, n) <= hoje) pl.feitos[`${id}|${i}|${n}`] = true; }); simFeito(pl, e, i, hoje); }); guardar("plano", pl); }
    b.closest(".tarefa").classList.add("concluindo");
    setTimeout(() => mostrarPlano(), 380);
  }));
  document.querySelectorAll("[data-comecar]").forEach((b) => (b.onclick = () => {
    const [tipo, id, i, n] = b.dataset.comecar.split("|");
    if (!lembrar("estudo:" + id, null)) return;
    abrir(id);
    if (tipo === "ler") { montar(+i, 0); tocar(); }
    else { modo = "cartoes"; document.body.classList.add("modo-cartoes"); filtroTopico = tipo === "rev" && n === "1" ? i : "todos"; novaRodada(); }
  }));
}

function formPlano(pl) {
  const lista = indice();
  const base = pl || { titulo: "", data: somaDias(hojeISO(), 14), materiais: lista[0] ? [lista[0].id] : [], minutos: { 0: 0, 1: 60, 2: 60, 3: 60, 4: 60, 5: 60, 6: 90 }, revisoes: true, feitos: {} };
  rascunho = JSON.parse(JSON.stringify(base));
  const OPCOES = [0, 15, 30, 45, 60, 90, 120, 180, 240];
  $("#coluna").innerHTML = `<div class="plano form-plano">
    <div class="plano-cab"><div><small>🎯 Meu plano</small><h1>${pl ? "Editar plano" : "Montar meu plano de estudo"}</h1>
      <span>Diga a data e quanto tempo você tem: o plano distribui os tópicos e as revisões até lá.</span></div></div>
    ${!lista.length ? `<div class="alerta-plano">Primeiro adicione um material na biblioteca; depois volte aqui para montar o plano.</div>` : ""}
    <label class="campo">O que você vai fazer?<input type="text" id="plTitulo" placeholder="Ex.: Prova de Banco de Dados, entrevista na empresa X…" value="${esc(rascunho.titulo)}"></label>
    <label class="campo">Quando?<input type="date" id="plData" min="${somaDias(hojeISO(), 1)}" value="${rascunho.data}"></label>
    <div class="campo">Materiais que entram no plano
      <div class="lista-mat">${lista.map((e) => `<label class="mat-check"><input type="checkbox" value="${esc(e.id)}" ${rascunho.materiais.includes(e.id) ? "checked" : ""}><span>${esc(e.titulo)}</span><small>${e.topicos} tópicos${e.objetivo ? ` · ${esc(e.objetivo)}` : ""} · ${esc(String(e.criado).split(",")[0])}</small></label>`).join("") || '<small class="ajuda">Nenhum material ainda.</small>'}</div></div>
    <div class="campo">Tempo de estudo por dia
      <div class="grade-dias">${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><span>${DIAS[d]}</span><select data-dia="${d}">${OPCOES.map((m) => `<option value="${m}" ${+rascunho.minutos[d] === m ? "selected" : ""}>${m ? horas(m) : "folga"}</option>`).join("")}</select></label>`).join("")}</div></div>
    <label class="interruptor"><span class="txt"><b>Revisões espaçadas</b><small>Revisa os flash cards de cada tópico 1, 3 e 7 dias depois de ler (é o que mais ajuda a lembrar na prova)</small></span>
      <input type="checkbox" id="plRev" ${rascunho.revisoes ? "checked" : ""}><span class="trilho"></span></label>
    <div class="previa-plano" id="previaPlano"></div>
    <div class="linha-botoes">${pl ? '<button class="sec" id="cancelarPlano">Cancelar</button>' : ""}<button class="pri" id="salvarPlano">${pl ? "Salvar plano" : "Criar meu plano"}</button></div></div>`;
  const ler = () => {
    rascunho.titulo = $("#plTitulo").value.trim();
    rascunho.data = $("#plData").value;
    rascunho.materiais = [...document.querySelectorAll(".mat-check input:checked")].map((c) => c.value);
    document.querySelectorAll("[data-dia]").forEach((s) => (rascunho.minutos[s.dataset.dia] = +s.value));
    rascunho.revisoes = $("#plRev").checked;
  };
  const previa = () => {
    ler();
    const ok = rascunho.data > hojeISO() && rascunho.materiais.length;
    $("#salvarPlano").disabled = !ok || !rascunho.titulo;
    if (!ok) { $("#previaPlano").innerHTML = `<small class="ajuda">Escolha uma data futura e pelo menos um material.</small>`; return; }
    const c = calcularPlano(rascunho);
    $("#previaPlano").innerHTML = `<div class="${c.sobra ? "alerta-plano" : "ok-plano"}">${c.sobra
      ? `⚠️ Leitura: ~${horas(c.aLer)} · tempo até a prova: ~${horas(c.disponivel)}. Não cabe tudo: aumente o tempo por dia ou escolha menos materiais.`
      : `✓ Leitura: ~${horas(c.aLer)} em ${c.dias.length} dias · tempo disponível: ~${horas(c.disponivel)}${c.revGeral ? " · véspera reservada para revisão geral" : ""}.`}</div>`;
  };
  $("#coluna").querySelectorAll("input, select").forEach((x) => (x.oninput = x.onchange = previa));
  previa();
  $("#cancelarPlano") && ($("#cancelarPlano").onclick = () => mostrarPlano());
  $("#salvarPlano").onclick = () => {
    ler(); rascunho.criado ||= hojeISO();
    guardar("plano", rascunho); toast("Plano criado! Toda vez que abrir, a tarefa do dia aparece aqui e na biblioteca.", [], 5000);
    mostrarPlano();
  };
}
$("#navPlano").onclick = () => mostrarPlano();

// faixa do plano no topo da biblioteca
function faixaPlano() {
  const pl = lembrar("plano", null);
  if (!pl) return `<button class="faixa-plano vazio" id="faixaPlano"><span>🎯</span><div><b>Tem prova ou entrevista marcada?</b><small>Monte um plano: diga a data e quanto tempo tem por dia</small></div><span class="seta">›</span></button>`;
  const c = calcularPlano(pl), hoje = hojeISO(), a = c.agenda[hoje], faltam = diasEntre(hoje, pl.data);
  const n = a ? grupos(a.leitura).length + grupos(a.revisao).length + (a.geral ? 1 : 0) : 0;
  const quando = faltam > 1 ? `faltam ${faltam} dias` : faltam === 1 ? "é amanhã" : faltam === 0 ? "é hoje" : "já passou";
  return `<button class="faixa-plano" id="faixaPlano"><span>🎯</span><div><b>${esc(pl.titulo)}: ${quando}</b>
    <small>${faltam < 0 ? "Edite o plano para uma nova data" : n ? `Hoje: ${n} tarefa${n > 1 ? "s" : ""} · ~${horas(Math.min(a.min, a.cap) || a.min)}` : a && !a.cap ? "Hoje é folga" : "Nada pendente para hoje 🎉"} · ${c.lidos} de ${c.total} tópicos lidos</small></div><span class="seta">›</span></button>`;
}

// rodada de flash cards terminada: as revisões do plano que venciam até hoje para este material contam como feitas
function revisoesFeitas() {
  const pl = lembrar("plano", null);
  if (!pl || !estudo || !pl.materiais.includes(estudo.id)) return;
  const hoje = hojeISO(); pl.feitos ||= {};
  Object.entries(estudo.lidosEm || {}).forEach(([i, d]) => ESPACOS.forEach((n) => { if (somaDias(d, n) <= hoje) pl.feitos[`${estudo.id}|${i}|${n}`] = true; }));
  Object.keys(estudo.revisarEm || {}).forEach((i) => simFeito(pl, estudo, i, hoje));
  guardar("plano", pl);
}
// revisão pedida pelo simulado que já venceu conta como feita
function simFeito(pl, e, i, hoje) {
  const d = e.revisarEm?.[i];
  if (d && d <= hoje) pl.feitos[`${e.id}|${i}|sim${d}`] = true;
}


// ---------- estudo guiado (SQ3R + recordar sem olhar) ----------
// Por tópico: 1) visão geral (título + resumo), 2) pergunta-guia, 3) leitura (sem o resumo e as perguntas, que ficam
// para depois), 4) recordar de cabeça (Lembrei / Não lembrei, resposta escrita opcional), 5) conferir: o que não lembrou
// volta para o início dos flash cards. Tentar lembrar antes de ver é o que mais fixa (efeito de testagem).
const PASSOS_GUIA = ["Visão geral", "Pergunta", "Leitura", "Recordar", "Conferir"];
let guia = { etapa: 0, itens: [] };
let falaGuia = 0;
// fala da etapa (visão geral, pergunta…): o ▶/⏸ do player controla ela, e o player mostra ⏸ enquanto fala
function falarGuia(texto) {
  const minha = ++falaGuia;
  guia.falar = texto;
  audio.pause();
  carregando(true); $("#tocar").innerHTML = PAUSA;
  sintetizar(texto).then((url) => {
    if (minha !== falaGuia || modo !== "guiado") return;
    audio.src = url;
    audio.onended = () => { if (minha === falaGuia) $("#tocar").innerHTML = PLAY; };
    audio.onpause = null;
    audio.play().catch(() => {});
  }).catch(() => { $("#tocar").innerHTML = PLAY; }).finally(() => carregando(false));
}
const calarGuia = () => { falaGuia++; audio.pause(); carregando(false); $("#tocar").innerHTML = PLAY; };
const falandoGuia = () => !audio.paused && !audio.ended;
function perguntaGuia(tp) {
  if (tp.perguntas?.[0]) return tp.perguntas[0].pergunta;
  if (tp.cartoes?.[0]) return /\?$/.test(tp.cartoes[0].frente) ? tp.cartoes[0].frente : `O que é “${tp.cartoes[0].frente}”?`;
  return `Qual é a ideia mais importante sobre “${tp.titulo}”?`;
}
// o que recordar: perguntas de revisão e os flash cards do tópico (até 5)
const itensRecordar = (tp, t) => [
  ...(tp.perguntas || []).map((q) => ({ p: q.pergunta, r: q.resposta, chave: t + "|" + q.pergunta })),
  ...(tp.cartoes || []).map((c) => ({ p: /\?$/.test(c.frente) ? c.frente : `O que é “${c.frente}”?`, r: c.verso, chave: t + "|" + c.frente })),
].filter((x) => x.p && x.r).slice(0, 5);
function stepper() {
  return `<ol class="passos-guia" aria-label="Etapas do estudo guiado">${PASSOS_GUIA.map((p, i) =>
    `<li class="${i < guia.etapa ? "feito" : i === guia.etapa ? "agora" : ""}" ${i === guia.etapa ? 'aria-current="step"' : ""}><span>${i < guia.etapa ? "✓" : i + 1}</span><b>${p}</b></li>`).join("")}</ol>`;
}
function iniciarGuiado(t = topico) {
  calarGuia(); parar();
  modo = "guiado"; topico = Math.max(0, Math.min(t, estudo.topicos.length - 1));
  guia = { etapa: 0, itens: itensRecordar(estudo.topicos[topico], topico) };
  pomoAoEstudar();
  montarGuiado();
}
function irEtapa(n) {
  calarGuia(); parar();
  guia.etapa = n;
  if (n === 2) { document.body.classList.remove("guia-passo"); montar(topico, 0); tocar(); }
  else montarGuiado();
}
function montarGuiado() {
  const tp = estudo.topicos[topico], n = estudo.topicos.length;
  document.body.classList.add("guia-passo"); document.body.classList.remove("modo-cartoes");
  const cab = `<div class="guia-cab"><button class="icone" id="guiaAnt" aria-label="Tópico anterior" ${topico ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
    <div><small>Tópico ${topico + 1} de ${n}</small><h2>${esc(tp.titulo)}</h2></div>
    <button class="icone" id="guiaProx" aria-label="Próximo tópico" ${topico < n - 1 ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg></button></div>`;
  let corpo = "", falar = "";
  if (guia.etapa === 0) {
    const visao = tp.resumo || frases(tp.texto).slice(0, 2).join(" ");
    falar = `${tp.titulo}. ${visao}`;
    corpo = `<div class="guia-cartao"><span class="guia-rot">Antes de ler, uma visão geral</span><p class="texto">${esc(visao)}</p>
      <div class="guia-acoes"><button class="sec" id="guiaOuvir">▶ Ouvir de novo</button><button class="pri" id="guiaSeguir">Continuar →</button></div></div>`;
  } else if (guia.etapa === 1) {
    const q = perguntaGuia(tp);
    falar = `Ao ler, tente descobrir: ${q}`;
    corpo = `<div class="guia-cartao destaque-q"><span class="guia-rot">Ao ler, tente descobrir</span><p class="pergunta-guia">${esc(q)}</p>
      <small class="ajuda">Ler procurando uma resposta prende mais a atenção.</small>
      <div class="guia-acoes"><button class="sec" id="guiaOuvir">▶ Ouvir de novo</button><button class="pri" id="guiaSeguir">Começar a leitura →</button></div></div>`;
  } else if (guia.etapa === 3) {
    falar = guia.itens.length ? "Agora, sem olhar o texto, tente lembrar." : "";
    corpo = guia.itens.length ? `<div class="guia-cartao"><span class="guia-rot">Sem olhar o texto: você lembra?</span>
      ${guia.itens.map((it, k) => `<div class="recordar ${it.lembrou === true ? "sim" : it.lembrou === false ? "nao" : ""}">
        <b>${k + 1}. ${esc(it.p)}</b>
        <textarea data-resp="${k}" placeholder="Sua resposta (opcional: escrever ajuda a fixar)">${esc(it.escrita || "")}</textarea>
        <div class="guia-acoes esq"><button class="nao-l" data-lembrou="${k}|0">Não lembrei</button><button class="sim-l" data-lembrou="${k}|1">Lembrei</button></div></div>`).join("")}
      <div class="guia-acoes"><button class="pri" id="guiaSeguir">Conferir respostas →</button></div></div>`
      : `<div class="guia-cartao"><p>Este tópico não tem perguntas nem flash cards para recordar.</p><div class="guia-acoes"><button class="pri" id="guiaSeguir">Continuar →</button></div></div>`;
  } else {
    const certos = guia.itens.filter((x) => x.lembrou).length, total = guia.itens.length;
    const emoji = !total ? "📘" : certos === total ? "🎉" : certos >= total / 2 ? "👍" : "💪";
    corpo = `<div class="guia-cartao"><div class="placar-guia"><span>${emoji}</span><div><b>${total ? `Você lembrou ${certos} de ${total}` : "Tópico concluído"}</b>
        <small>${!total ? "" : certos === total ? "Excelente! Este tópico está firme." : "O que você não lembrou foi para o começo dos flash cards."}</small></div></div>
      ${guia.itens.map((it) => `<div class="conferir ${it.lembrou ? "sim" : "nao"}"><span class="selo-c">${it.lembrou ? "✓" : "✗"}</span><div>
        <b>${esc(it.p)}</b>${it.escrita ? `<small>Você escreveu: ${esc(it.escrita)}</small>` : ""}<p>${esc(it.r)}</p></div></div>`).join("")}
      <div class="guia-acoes">${guia.itens.some((x) => !x.lembrou) ? '<button class="sec" id="guiaCartoes">Revisar com flash cards</button>' : ""}
        <button class="sec" id="guiaReler">Ler de novo</button>
        ${topico < n - 1 ? '<button class="pri" id="guiaProxTopico">Próximo tópico →</button>' : '<button class="pri" id="guiaFim">Concluir</button>'}</div></div>`;
  }
  $("#coluna").innerHTML = faixaIa() + faixaObjetivo() + abas() + stepper() + cab + `<div class="guia-corpo entra">${corpo}</div>`;
  ligarAbas(); ligarObjetivo();
  $("#guiaAnt").onclick = () => virarFolha("tras", () => iniciarGuiado(topico - 1));
  $("#guiaProx").onclick = () => virarFolha("frente", () => iniciarGuiado(topico + 1));
  $("#guiaOuvir") && ($("#guiaOuvir").onclick = () => falarGuia(falar));
  $("#guiaSeguir") && ($("#guiaSeguir").onclick = () => {
    if (guia.etapa === 3) guia.itens.forEach((x) => (x.lembrou ??= false)); // sem marcar conta como "não lembrei"
    irEtapa(guia.etapa === 3 ? 4 : guia.etapa + 1);
  });
  document.querySelectorAll("[data-resp]").forEach((t) => (t.oninput = () => (guia.itens[+t.dataset.resp].escrita = t.value.trim())));
  document.querySelectorAll("[data-lembrou]").forEach((b) => (b.onclick = () => {
    const [k, v] = b.dataset.lembrou.split("|");
    guia.itens[+k].lembrou = v === "1";
    const caixa = b.closest(".recordar");
    caixa.classList.toggle("sim", v === "1"); caixa.classList.toggle("nao", v === "0");
  }));
  if (guia.etapa === 4) {
    // conferido: o que não lembrou volta para a caixa 0 dos flash cards (vem primeiro); o tópico conta como lido no plano
    const cx = caixas();
    guia.itens.forEach((x) => { cx[x.chave] = x.lembrou ? Math.max(1, cx[x.chave] || 0) : 0; }); // lembrou sobe; não lembrou vem primeiro
    guardar("caixas:" + estudo.id, cx);
    marcarLido(estudo, topico);
    $("#guiaCartoes") && ($("#guiaCartoes").onclick = () => { document.body.classList.remove("guia-passo"); modo = "cartoes"; document.body.classList.add("modo-cartoes"); filtroTopico = String(topico); novaRodada(); });
    $("#guiaReler").onclick = () => irEtapa(2);
    $("#guiaProxTopico") && ($("#guiaProxTopico").onclick = () => virarFolha("frente", () => iniciarGuiado(topico + 1)));
    $("#guiaFim") && ($("#guiaFim").onclick = () => { toast("Material concluído no estudo guiado! 🎉 As revisões seguem no seu plano.", [], 5000); document.body.classList.remove("guia-passo"); modo = "ler"; montar(topico, 0); });
  }
  guia.falar = falar;
  if (falar) falarGuia(falar);
  $(".conteudo").scrollTop = 0;
}

// ---------- simulado (questões de prova com correção) ----------
// A IA cria questões de múltipla escolha (A a E) e de certo ou errado (estilo Cebraspe) a partir dos tópicos. Elas
// ficam guardadas por material ("simulado:<id>") e voltam nos próximos simulados, primeiro as que a pessoa errou.
// No fim: nota por tópico e gabarito comentado; as erradas viram flash cards e os tópicos fracos ganham revisão no plano.
const INSTRUCAO_SIMULADO = `Crie questões de prova (estilo concurso e vestibular brasileiro) a partir do material abaixo, em português do Brasil.
Para cada tópico indicado ("## número. título"), crie exatamente as quantidades pedidas em QUANTIDADES:
- "multipla": enunciado e 5 alternativas, com UMA só correta. As erradas devem ser plausíveis (as pegadinhas que
  costumam cair: número trocado, exceção esquecida, conceito parecido). Nada de "todas as anteriores" ou "nenhuma".
  Não escreva a letra no começo da alternativa.
- "ce": uma afirmação para julgar como Certo (C) ou Errado (E), estilo Cebraspe. Faça cerca de metade erradas, com erro sutil.
Cobre só o que está no material. Varie entre definições, números, datas, listas, exceções e aplicação em um caso.
Para cada questão, um comentário de 1 a 3 frases explicando a resposta (na múltipla, diga também por que a pegadinha principal está errada).
Responda SOMENTE com JSON válido: {"questoes":[{"topico":0,"tipo":"multipla","enunciado":"...","alternativas":["...","...","...","...","..."],"correta":0,"comentario":"..."},{"topico":0,"tipo":"ce","enunciado":"...","correta":"C","comentario":"..."}]}
(topico = número do tópico; na múltipla, correta = posição da alternativa certa, começando em 0).`;
const LETRAS = "ABCDE";
const FRACO = 0.6; // acerto abaixo de 60% no tópico: pede revisão no plano
let sim = { fase: "config" }, simTopico = "todos", falaSim = 0;
let ajusteSim = { qtd: 10, tipo: "misto", correcao: "fim", ...lembrar("ajusteSimulado", {}) };
const bancoSim = (id = estudo.id) => lembrar("simulado:" + id, { questoes: [], historico: [] });
const tiposDe = (tipo) => (tipo === "misto" ? ["multipla", "ce"] : [tipo]);
const topicosSim = () => (simTopico === "todos" ? estudo.topicos.map((_, i) => i) : [+simTopico]);
const letra = (q, k) => (q.tipo === "ce" ? (k ? "Errado" : "Certo") : `${LETRAS[k]}) ${q.alternativas[k]}`);
function embaralhar(lista) {
  const a = [...lista];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// confere o que a IA mandou e embaralha as alternativas (ela tende a pôr a certa nas primeiras letras)
function normalizarQuestao(q, nTopicos) {
  const enunciado = String(q?.enunciado || "").trim(), comentario = String(q?.comentario || "").trim();
  if (!enunciado) return null;
  const base = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7), t: Math.max(0, Math.min(nTopicos - 1, +q.topico || 0)), enunciado, comentario };
  if (q.tipo === "ce") {
    const c = String(q.correta).trim().toUpperCase()[0];
    return c === "C" || c === "E" ? { ...base, tipo: "ce", alternativas: ["Certo", "Errado"], correta: c === "C" ? 0 : 1 } : null;
  }
  const alts = Array.isArray(q.alternativas) ? q.alternativas.map((a) => String(a).replace(/^\s*[A-Ea-e][).:-]\s+/, "").trim()) : [];
  const c = typeof q.correta === "string" && /^[A-E]$/i.test(q.correta.trim()) ? LETRAS.indexOf(q.correta.trim().toUpperCase()) : +q.correta;
  if (alts.length < 4 || alts.length > 5 || alts.some((a) => !a) || !(c >= 0 && c < alts.length)) return null;
  const ordem = embaralhar(alts.map((_, i) => i));
  return { ...base, tipo: "multipla", alternativas: ordem.map((i) => alts[i]), correta: ordem.indexOf(c) };
}

// quantas questões de cada tipo faltam no banco, por tópico, para um simulado de `qtd` (novas = só as nunca respondidas)
function faltando(b, qtd, tipo, novas) {
  const ts = topicosSim(), porTopico = Math.ceil(qtd / ts.length), f = {};
  for (const t of ts) {
    const m = t % 2 ? Math.floor(porTopico / 2) : Math.ceil(porTopico / 2); // no misto, alterna qual tipo leva a sobra
    const quer = { multipla: tipo === "ce" ? 0 : tipo === "multipla" ? porTopico : m, ce: tipo === "multipla" ? 0 : tipo === "ce" ? porTopico : porTopico - m };
    const tem = (tp) => b.questoes.filter((q) => q.t === t && q.tipo === tp && (!novas || !q.vistas)).length;
    const x = { multipla: Math.max(0, quer.multipla - tem("multipla")), ce: Math.max(0, quer.ce - tem("ce")) };
    if (x.multipla + x.ce) f[t] = x;
  }
  return f;
}

async function gerarQuestoes(faltam, chave, aviso) {
  const e = estudo, b = bancoSim(e.id);
  const grupos = []; let texto = "", pedidos = [];
  for (const [i, f] of Object.entries(faltam)) {
    const t = e.topicos[i], bloco = `## ${i}. ${t.titulo}\n${t.texto}\n\n`;
    if (texto && texto.length + bloco.length > 20000) { grupos.push([texto, pedidos]); texto = ""; pedidos = []; }
    texto += bloco; pedidos.push(`tópico ${i}: ${f.multipla} de múltipla escolha e ${f.ce} de certo ou errado`);
  }
  if (texto) grupos.push([texto, pedidos]);
  for (let g = 0; g < grupos.length; g++) {
    const av = (t) => aviso(grupos.length > 1 ? `Parte ${g + 1} de ${grupos.length}: ${t}` : t);
    av("criando as questões…");
    const o = await gemini(`${INSTRUCAO_SIMULADO}\n\nQUANTIDADES:\n${grupos[g][1].join("\n")}\n\nMATERIAL:\n${grupos[g][0]}`, chave, av,
      (o) => Array.isArray(o.questoes) && o.questoes.length);
    const novas = o.questoes.map((q) => normalizarQuestao(q, e.topicos.length)).filter((q) => q && !b.questoes.some((x) => x.enunciado === q.enunciado));
    b.questoes.push(...novas);
    guardar("simulado:" + e.id, b);
  }
}

// escolhe as questões: primeiro as que errou da última vez, depois as nunca vistas; um tópico de cada vez, para cobrir a matéria
function sortear(b, qtd, tipo, novas) {
  const ts = new Set(topicosSim()), tipos = tiposDe(tipo), filas = new Map();
  const prio = (q) => (novas ? (q.vistas ? 1 : 0) : q.ultima === false ? 0 : !q.vistas ? 1 : 2 + (q.acertos || 0)) + Math.random();
  b.questoes.filter((q) => ts.has(q.t) && tipos.includes(q.tipo)).map((q) => [prio(q), q]).sort((a, z) => a[0] - z[0])
    .forEach(([, q]) => { if (!filas.has(q.t)) filas.set(q.t, []); filas.get(q.t).push(q); });
  const ordem = embaralhar([...filas.values()]), escolhidas = [];
  while (escolhidas.length < qtd && ordem.some((f) => f.length))
    for (const f of ordem) if (f.length && escolhidas.length < qtd) escolhidas.push(f.shift());
  return embaralhar(escolhidas);
}

function iniciarSimulado() {
  modo = "simulado"; document.body.classList.add("modo-simulado");
  if (sim.id !== estudo.id) { sim = { id: estudo.id, fase: "config" }; simTopico = "todos"; }
  montarSimulado();
}

async function comecarSimulado(novas = false) {
  const e = estudo, chave = $("#chave").value.trim();
  const falta = faltando(bancoSim(), ajusteSim.qtd, ajusteSim.tipo, novas);
  if (Object.keys(falta).length) {
    const tem = sortear(bancoSim(), ajusteSim.qtd, ajusteSim.tipo, novas).length;
    if (!chave && (novas || !tem)) return pedirChave(); // sem chave dá para usar as questões que já existem
    if (chave) {
      sim = { id: e.id, fase: "gerando", aviso: "Criando as questões…" };
      montarSimulado();
      try {
        await gerarQuestoes(falta, chave, (t) => { sim.aviso = t; const el = $("#simAviso"); if (el && sim.id === e.id) el.textContent = t; });
      } catch (err) {
        if (sim.id === e.id) sim = { id: e.id, fase: "config", erro: "Não consegui criar as questões: " + err.message };
        if (estudo?.id === e.id && modo === "simulado") montarSimulado();
        return;
      }
      if (estudo?.id !== e.id || modo !== "simulado") { if (sim.id === e.id) sim = { id: e.id, fase: "config" }; return; }
    }
  }
  const qs = sortear(bancoSim(), ajusteSim.qtd, ajusteSim.tipo, novas);
  if (!qs.length) { sim = { id: e.id, fase: "config", erro: "Não há questões para essa escolha. Tente outro tipo ou tópico." }; return montarSimulado(); }
  sim = { id: e.id, fase: "prova", itens: qs.map((q) => ({ q, resp: null })), atual: 0, inicio: Date.now(), correcao: ajusteSim.correcao };
  pomoAoEstudar();
  montarSimulado();
  falarSim(textoQuestao(qs[0]));
}

function telaConfigSim() {
  const b = bancoSim(), ts = new Set(topicosSim()), tipos = tiposDe(ajusteSim.tipo);
  const prontas = b.questoes.filter((q) => ts.has(q.t) && tipos.includes(q.tipo)).length;
  const hist = b.historico.slice(-5);
  const pct = (h) => Math.round((h.acertos / h.total) * 100);
  const chips = (campo, opcoes) => `<div class="chips-obj" role="radiogroup">${opcoes.map(([v, n]) =>
    `<button data-sim="${campo}|${v}" class="${String(ajusteSim[campo]) === String(v) ? "ativo" : ""}" role="radio" aria-checked="${String(ajusteSim[campo]) === String(v)}">${n}</button>`).join("")}</div>`;
  return `<div class="guia-cartao sim-config entra">
    <div><span class="guia-rot">Simulado</span><h2 class="sim-tit">Teste-se como na prova</h2>
      <p class="ajuda-sim">A IA cria questões a partir deste material. No fim você vê a nota por tópico e o gabarito comentado, e o que errar vira flash card.</p></div>
    <label class="campo-sim">Tópicos<select id="simTopico"><option value="todos">Todos os tópicos</option>${estudo.topicos.map((t, i) =>
      `<option value="${i}" ${String(i) === simTopico ? "selected" : ""}>${i + 1}. ${esc(t.titulo)}</option>`).join("")}</select></label>
    <div class="campo-sim">Quantidade de questões${chips("qtd", [[5, "5"], [10, "10"], [20, "20"], [30, "30"]])}</div>
    <div class="campo-sim">Tipo${chips("tipo", [["misto", "Misto"], ["multipla", "Múltipla escolha"], ["ce", "Certo ou errado"]])}</div>
    <div class="campo-sim">Correção${chips("correcao", [["fim", "No fim, como na prova"], ["hora", "A cada questão"]])}</div>
    <label class="campo-check"><input type="checkbox" id="lerSim" ${lembrar("lerSimulado", false) ? "checked" : ""}> Ler as questões em voz alta</label>
    <small class="ajuda">${prontas ? `${prontas} ${prontas === 1 ? "questão pronta" : "questões prontas"} para essa escolha; se faltar, a IA cria o resto.` : "Na primeira vez a IA cria as questões (leva alguns segundos)."}</small>
    ${hist.length ? `<div class="sim-hist"><span>Últimos simulados</span>${hist.map((h) => `<b class="${h.acertos / h.total < FRACO ? "baixo" : ""}" title="${h.acertos} de ${h.total} em ${dataBR(h.data)}">${pct(h)}%</b>`).join("")}</div>` : ""}
    ${sim.erro ? `<div class="alerta-plano">${esc(sim.erro)}</div>` : ""}
    <div class="guia-acoes">${prontas ? '<button class="sec" id="simNovas" title="Pede à IA questões que você ainda não viu">Só questões novas</button>' : ""}<button class="pri" id="simComecar">Começar simulado</button></div></div>`;
}

function telaProva() {
  const n = sim.itens.length, it = sim.itens[sim.atual], q = it.q, hora = sim.correcao === "hora";
  const respondidas = sim.itens.filter((x) => x.resp != null).length;
  const mostrou = hora && it.resp != null, acertou = it.resp === q.correta;
  const alts = q.alternativas.map((a, k) => {
    const cls = mostrou ? (k === q.correta ? "certa" : it.resp === k ? "errada" : "apagada") : it.resp === k ? "marcada" : "";
    return `<button class="alt ${cls}" data-alt="${k}" role="radio" aria-checked="${it.resp === k}" ${mostrou ? "disabled" : ""}>
      <span class="letra">${q.tipo === "ce" ? "CE"[k] : LETRAS[k]}</span><span>${esc(a)}</span></button>`;
  }).join("");
  const ultima = sim.atual === n - 1;
  const seguir = hora
    ? (mostrou ? `<button class="pri" id="${ultima ? "simEntregar" : "simProx"}">${ultima ? "Ver resultado" : "Próxima →"}</button>` : "")
    : ultima ? '<button class="pri" id="simEntregar">Entregar simulado</button>' : `<button class="pri" id="simProx">${it.resp != null ? "Próxima →" : "Pular →"}</button>`;
  return `<div class="placar"><span>Questão ${sim.atual + 1} de ${n} · ${respondidas} respondida${respondidas === 1 ? "" : "s"}</span><span id="simRelogio">⏱ ${mmss(Date.now() - sim.inicio)}</span></div>
    <div class="barra-dominio"><i style="width:${Math.round((respondidas / n) * 100)}%"></i></div>
    <div class="guia-cartao questao">
      <span class="guia-rot">${q.tipo === "ce" ? "Certo ou errado" : "Múltipla escolha"} · ${esc(estudo.topicos[q.t]?.titulo || "")}</span>
      <p class="enunciado">${esc(q.enunciado)}</p>
      <div class="alts" role="radiogroup" aria-label="Alternativas">${alts}</div>
      ${mostrou ? `<div class="sim-coment ${acertou ? "sim" : "nao"}"><b>${acertou ? "✓ Você acertou" : `✗ A resposta é ${esc(letra(q, q.correta))}`}</b><p>${esc(q.comentario)}</p></div>` : ""}
      <div class="guia-acoes sim-nav"><button class="link" id="simSair">Sair do simulado</button>
        ${!hora && sim.atual ? '<button class="sec" id="simAnt">← Anterior</button>' : ""}${seguir}</div>
    </div>
    ${hora ? "" : `<div class="sim-mapa" aria-label="Ir para a questão">${sim.itens.map((x, k) =>
      `<button data-ir="${k}" class="${k === sim.atual ? "agora" : ""} ${x.resp != null ? "feita" : ""}" aria-label="Questão ${k + 1}${x.resp != null ? ", respondida" : ""}">${k + 1}</button>`).join("")}</div>`}`;
}

function telaFimSim() {
  const n = sim.itens.length, pct = Math.round((sim.acertos / n) * 100), antes = bancoSim().historico.at(-2);
  const emoji = pct >= 80 ? "🎉" : pct >= FRACO * 100 ? "👍" : "💪";
  const erradas = sim.itens.filter((x) => x.resp !== x.q.correta);
  const noPlano = lembrar("plano", null)?.materiais.includes(estudo.id);
  const topicos = Object.entries(sim.por).sort(([, a], [, z]) => a[0] / a[1] - z[0] / z[1]).map(([t, [a, m]]) =>
    `<li class="${a / m < FRACO ? "fraco" : ""}"><span>${+t + 1}. ${esc(estudo.topicos[t]?.titulo || "")}</span><b>${a} de ${m}</b>
      <div class="barra-dominio"><i style="width:${Math.round((a / m) * 100)}%"></i></div></li>`).join("");
  const gabarito = sim.itens.map((it, k) => {
    const ok = it.resp === it.q.correta;
    return `<div class="conferir ${ok ? "sim" : "nao"}"><span class="selo-c">${ok ? "✓" : "✗"}</span><div>
      <b>${k + 1}. ${esc(it.q.enunciado)}</b>
      <small>${it.resp == null ? "Sem resposta" : `Você marcou: ${esc(letra(it.q, it.resp))}`}${ok ? "" : ` · Certa: ${esc(letra(it.q, it.q.correta))}`}</small>
      <p>${esc(it.q.comentario)}</p></div></div>`;
  }).join("");
  return `<div class="guia-cartao entra">
      <div class="placar-guia"><span>${emoji}</span><div><b>Você acertou ${sim.acertos} de ${n} (${pct}%)</b>
        <small>Em ${horas(Math.max(1, Math.round(sim.seg / 60)))}${antes ? ` · no simulado anterior: ${Math.round((antes.acertos / antes.total) * 100)}%` : ""}</small></div></div>
      ${erradas.length ? `<p class="ajuda-sim">${erradas.length === 1 ? "A questão que você errou virou flash card" : `As ${erradas.length} questões que você errou viraram flash cards`} e aparece${erradas.length === 1 ? "" : "m"} primeiro na próxima rodada.${sim.fracos.length && noPlano ? " Os tópicos abaixo de 60% ganharam uma revisão amanhã no seu plano." : ""}</p>` : ""}
      <div class="campo-sim">Por tópico<ul class="sim-topicos">${topicos}</ul></div>
      <div class="guia-acoes">
        ${erradas.length ? '<button class="sec" id="simRefazer">Refazer as erradas</button><button class="sec" id="simCartoes">Revisar com flash cards</button>' : ""}
        ${sim.fracos.length ? `<button class="sec" id="simLer">Ler o tópico ${sim.fracos[0] + 1}</button>` : ""}
        <button class="pri" id="simNovo">Novo simulado</button></div></div>
    <div class="guia-cartao sim-gabarito"><span class="guia-rot">Gabarito comentado</span>${gabarito}</div>`;
}

function montarSimulado() {
  document.body.classList.add("modo-simulado");
  let corpo;
  if (sim.fase === "gerando") corpo = `<div class="guia-cartao sim-gerando"><span class="pensando"></span><b>Montando o seu simulado</b><small id="simAviso">${esc(sim.aviso || "")}</small></div>`;
  else if (sim.fase === "prova") corpo = telaProva();
  else if (sim.fase === "fim") corpo = telaFimSim();
  else corpo = telaConfigSim();
  $("#coluna").innerHTML = faixaIa() + abas() + corpo;
  ligarAbas();
  $("#btnIa") && ($("#btnIa").onclick = organizarDepois);
  const clique = (id, f) => $(id) && ($(id).onclick = f);
  if (sim.fase === "config") {
    $("#simTopico").onchange = (ev) => { simTopico = ev.target.value; montarSimulado(); };
    document.querySelectorAll("[data-sim]").forEach((b) => (b.onclick = () => {
      const [campo, v] = b.dataset.sim.split("|");
      ajusteSim[campo] = campo === "qtd" ? +v : v; guardar("ajusteSimulado", ajusteSim); montarSimulado();
    }));
    $("#lerSim").onchange = (ev) => guardar("lerSimulado", ev.target.checked);
    clique("#simComecar", () => comecarSimulado());
    clique("#simNovas", () => comecarSimulado(true));
  } else if (sim.fase === "prova") {
    const it = sim.itens[sim.atual];
    document.querySelectorAll("[data-alt]").forEach((b) => (b.onclick = () => {
      if (sim.correcao === "hora" && it.resp != null) return;
      it.resp = +b.dataset.alt;
      montarSimulado();
      if (sim.correcao === "hora") falarSim(`${it.resp === it.q.correta ? "Certo!" : `Errado. A resposta é ${letra(it.q, it.q.correta)}.`} ${it.q.comentario}`);
    }));
    const ir = (k) => { sim.atual = k; montarSimulado(); falarSim(textoQuestao(sim.itens[k].q)); $(".conteudo").scrollTop = 0; };
    clique("#simProx", () => ir(sim.atual + 1));
    clique("#simAnt", () => ir(sim.atual - 1));
    document.querySelectorAll("[data-ir]").forEach((b) => (b.onclick = () => ir(+b.dataset.ir)));
    clique("#simEntregar", () => {
      const b = $("#simEntregar"), vazias = sim.itens.filter((x) => x.resp == null).length;
      if (vazias && !b.dataset.ok) { b.dataset.ok = 1; b.textContent = `${vazias} sem resposta. Toque de novo para entregar`; return; }
      entregarSimulado();
    });
    clique("#simSair", () => {
      const b = $("#simSair");
      if (!b.dataset.ok) { b.dataset.ok = 1; b.textContent = "Toque de novo para sair (este simulado não conta)"; return; }
      calarSimulado(); sim = { id: estudo.id, fase: "config" }; montarSimulado();
    });
  } else if (sim.fase === "fim") {
    clique("#simRefazer", () => {
      sim = { id: estudo.id, fase: "prova", itens: embaralhar(sim.itens.filter((x) => x.resp !== x.q.correta)).map((x) => ({ q: x.q, resp: null })), atual: 0, inicio: Date.now(), correcao: sim.correcao };
      montarSimulado(); falarSim(textoQuestao(sim.itens[0].q));
    });
    const sair = (novo, f) => () => { modo = novo; document.body.classList.remove("modo-simulado"); document.body.classList.toggle("modo-cartoes", novo === "cartoes"); f(); };
    clique("#simCartoes", sair("cartoes", () => { filtroTopico = "todos"; novaRodada(); }));
    clique("#simLer", sair("ler", () => montar(sim.fracos[0], 0)));
    clique("#simNovo", () => { sim = { id: estudo.id, fase: "config" }; montarSimulado(); });
  }
}

// corrige: atualiza o banco de questões, as erradas viram flash cards (caixa 0) e os tópicos fracos ganham revisão amanhã
function entregarSimulado() {
  calarSimulado();
  const e = estudo, b = bancoSim(), cx = caixas(), hoje = hojeISO(), por = {};
  let acertos = 0;
  for (const it of sim.itens) {
    const q = it.q, ok = it.resp === q.correta;
    if (ok) acertos++;
    (por[q.t] ||= [0, 0])[1]++; if (ok) por[q.t][0]++;
    const guardada = b.questoes.find((x) => x.id === q.id);
    if (guardada) { guardada.vistas = (guardada.vistas || 0) + 1; guardada.acertos = (guardada.acertos || 0) + (ok ? 1 : 0); guardada.ultima = ok; }
    const tp = e.topicos[q.t];
    if (ok || !tp) continue;
    const frente = q.tipo === "ce" ? `Certo ou errado? ${q.enunciado}` : q.enunciado;
    if (!(tp.cartoes || []).some((c) => c.frente === frente))
      (tp.cartoes ||= []).push({ frente, verso: `${q.tipo === "ce" ? (q.correta ? "Errado" : "Certo") : q.alternativas[q.correta]}. ${q.comentario}`.trim() });
    cx[q.t + "|" + frente] = 0;
  }
  const fracos = Object.entries(por).filter(([, [a, n]]) => a / n < FRACO).sort(([, a], [, z]) => a[0] / a[1] - z[0] / z[1]).map(([t]) => +t);
  fracos.forEach((t) => ((e.revisarEm ||= {})[t] = somaDias(hoje, 1)));
  const seg = Math.round((Date.now() - sim.inicio) / 1000);
  b.historico = [...b.historico, { data: hoje, acertos, total: sim.itens.length, seg, por }].slice(-30);
  guardar("simulado:" + e.id, b); guardar("caixas:" + e.id, cx); salvarEstudo(e);
  sim = { ...sim, fase: "fim", acertos, por, fracos, seg };
  montarSimulado();
  $(".conteudo").scrollTop = 0;
  falarSim(`Você acertou ${acertos} de ${sim.itens.length}.`);
}

const textoQuestao = (q) => (q.tipo === "ce" ? `Certo ou errado? ${q.enunciado}` : `${q.enunciado} ${q.alternativas.map((a, k) => `${LETRAS[k]}: ${a}.`).join(" ")}`);
function falarSim(texto) {
  const minha = ++falaSim;
  audio.pause();
  if (!lembrar("lerSimulado", false)) return;
  sintetizar(texto).then((url) => {
    if (minha !== falaSim || modo !== "simulado") return;
    audio.onended = audio.onpause = null; audio.src = url; audio.play().catch(() => {});
  }).catch(() => {});
}
function calarSimulado() { falaSim++; if (modo === "simulado") audio.pause(); }

// teclado: A–E ou 1–5 marcam (C/E no certo ou errado), Enter ou → avança, ← volta
function teclaSimulado(e) {
  if (sim.fase !== "prova" || e.target.tagName === "TEXTAREA" || (e.target.tagName === "BUTTON" && ["Enter", "Space"].includes(e.code))) return;
  const q = sim.itens[sim.atual].q;
  const k = q.tipo === "ce" ? { KeyC: 0, KeyE: 1, Digit1: 0, Digit2: 1 }[e.code]
    : /^Key[A-E]$/.test(e.code) ? LETRAS.indexOf(e.code[3]) : /^Digit[1-5]$/.test(e.code) ? +e.code[5] - 1 : undefined;
  if (k != null && k < q.alternativas.length) return document.querySelector(`[data-alt="${k}"]`)?.click();
  if (e.code === "Enter" || e.code === "ArrowRight") { e.preventDefault(); ($("#simProx") || $("#simEntregar"))?.click(); }
  if (e.code === "ArrowLeft") $("#simAnt")?.click();
}
setInterval(() => { if (modo === "simulado" && sim.fase === "prova") { const r = $("#simRelogio"); if (r) r.textContent = "⏱ " + mmss(Date.now() - sim.inicio); } }, 1000);

mostrarVoz();
aplicarVolume(); // aqui embaixo: o elemento de áudio só existe depois do bloco da leitura
mostrarBiblioteca();
if (lembrar("voz", null) === null && location.hash !== "#migrar") boasVindas(); // vindo do endereço antigo: a voz chega junto
function boasVindas() {
  let escolha = vozAtual;
  const desenhar = () => {
    $("#opcoesVoz").innerHTML = VOZES.map(([id, nome, g]) => `<div class="voz-card ${id === escolha ? "ativo" : ""}" data-escolher="${id}" role="radio" aria-checked="${id === escolha}" tabindex="0">
        <span class="avatar grande ${id}">${nome[0]}</span><b>${nome}</b><small>${g}</small>
        <button class="ouvir" data-amostra="${id}" aria-label="Ouvir ${nome}"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button></div>`).join("");
    document.querySelectorAll("[data-escolher]").forEach((c) => {
      c.onclick = () => { escolha = c.dataset.escolher; amostra.src = `amostras/${escolha}.mp3`; amostra.play().catch(() => {}); desenhar(); };
      c.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); c.click(); } };
    });
    document.querySelectorAll("[data-amostra]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); amostra.src = `amostras/${b.dataset.amostra}.mp3`; amostra.play().catch(() => {}); }));
  };
  desenhar();
  $("#modalVoz").hidden = false;
  $("#salvarVoz").onclick = () => { amostra.pause(); vozAtual = escolha; guardar("voz", vozAtual); mostrarVoz(); $("#modalVoz").hidden = true; };
}

// ---------- pomodoro ----------
// Foco/pausa com relógio flutuante (pode ocultar). O fim é calculado pela hora marcada (não por contagem), então
// continua certo com a aba em segundo plano e depois de recarregar. Aviso: som + notificação, só notificação ou só visual.
const POMO_PADRAO = { foco: 25, pausa: 5, longa: 15, aviso: "som", mostrar: true, pararLeitura: true, auto: true };
let pomo = { ...POMO_PADRAO, ...lembrar("pomo", {}) }; // ajustes + estado { fase, fimEm, restante, rodando, ciclo }
pomo.fase ??= "foco"; pomo.ciclo ??= 0;
const NOMES_FASE = { foco: "Foco", pausa: "Pausa", longa: "Pausa longa" };
const duracao = (f) => (pomo[f] || POMO_PADRAO[f]) * 60000;
const salvarPomo = () => guardar("pomo", pomo);
const hojeChave = () => "pomoHoje:" + dataLocal();
const mmss = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const restante = () => (pomo.rodando ? pomo.fimEm - Date.now() : pomo.restante ?? duracao(pomo.fase));

function desenharPomo() {
  const r = restante(), total = duracao(pomo.fase), pausa = pomo.fase !== "foco";
  const ativo = pomo.rodando || (pomo.restante != null && pomo.restante < total);
  $("#pomoTempo").textContent = mmss(r);
  $("#pomoFase").textContent = NOMES_FASE[pomo.fase];
  $("#pomoCiclos").textContent = "●".repeat(pomo.ciclo % 4) + "○".repeat(4 - (pomo.ciclo % 4));
  const c = 2 * Math.PI * 52;
  $("#pomoAnel").style.strokeDasharray = c;
  $("#pomoAnel").style.strokeDashoffset = c * (1 - Math.max(0, Math.min(1, r / total)));
  $("#relogio").classList.toggle("pausa", pausa);
  $("#relogio").classList.toggle("parado", !pomo.rodando);
  $("#relogio").hidden = !(pomo.mostrar && ativo);
  // minimizado: bolinha com o tempo no mesmo canto (antes sumia e a pessoa não achava mais)
  $("#relogioMini").hidden = !(!pomo.mostrar && ativo);
  $("#relogioMini").classList.toggle("pausa", pausa);
  $("#pomoTempoMini").textContent = mmss(r);
  $("#pomoFaseMini").textContent = pausa ? "Pausa" : "Foco";
  const cm = 2 * Math.PI * 15;
  $("#pomoAnelMini").style.strokeDasharray = cm;
  $("#pomoAnelMini").style.strokeDashoffset = cm * (1 - Math.max(0, Math.min(1, r / total)));
  $("#pomoPlay").innerHTML = pomo.rodando ? PAUSA : PLAY;
  $("#pomoPlay").title = pomo.rodando ? "Pausar" : "Continuar";
  // no topo: tempo pequeno quando está ativo (é o único sinal quando o relógio está oculto)
  $("#pomoMini").textContent = ativo ? mmss(r) : "Pomodoro"; // parado, o botão diz o que é (senão ninguém descobre)
  $("#btnPomo").classList.toggle("parado-topo", !ativo);
  $("#pomoMiniNav").textContent = ativo ? mmss(r) : "";
  $("#btnPomo").classList.toggle("ativo", ativo);
  $("#btnPomo").classList.toggle("pausa", ativo && pausa);
  $("#pomoComecar").textContent = pomo.rodando ? "Pausar" : ativo ? "Continuar" : `Começar ${NOMES_FASE[pomo.fase].toLowerCase()}`;
  const feitos = lembrar(hojeChave(), 0);
  $("#pomoHoje").textContent = feitos ? `Hoje: ${feitos} pomodoro${feitos > 1 ? "s" : ""} de foco (${feitos * pomo.foco} min)` : "Dica: 25 min de foco e 5 de pausa; a cada 4 focos, uma pausa longa.";
}
function iniciarPomo() {
  pomo.fimEm = Date.now() + (pomo.restante ?? duracao(pomo.fase));
  pomo.rodando = true; delete pomo.restante;
  salvarPomo(); desenharPomo();
  if (pomo.aviso !== "visual" && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
}
function pausarPomo() { pomo.restante = restante(); pomo.rodando = false; salvarPomo(); desenharPomo(); }
function zerarPomo() { pomo.rodando = false; delete pomo.restante; pomo.fase = "foco"; pomo.ciclo = 0; salvarPomo(); desenharPomo(); }
function proximaFase(contar) {
  if (pomo.fase === "foco") {
    if (contar) guardar(hojeChave(), lembrar(hojeChave(), 0) + 1);
    pomo.ciclo++;
    pomo.fase = pomo.ciclo % 4 === 0 ? "longa" : "pausa";
  } else pomo.fase = "foco";
  pomo.rodando = false; delete pomo.restante; salvarPomo(); desenharPomo();
}
// sininho suave feito no próprio navegador (sem arquivo de som)
function sininho() {
  try {
    const ctx = new AudioContext();
    [[880, 0], [1318.5, 0.18]].forEach(([f, t]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 1.2);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 1.3);
    });
  } catch {}
}
function fimDeFase() {
  const eraFoco = pomo.fase === "foco";
  proximaFase(true);
  if (eraFoco && pomo.pararLeitura) parar();
  const titulo = eraFoco ? (pomo.fase === "longa" ? "Hora da pausa longa!" : "Hora da pausa!") : "Pausa terminada";
  const texto = eraFoco ? `Você completou ${pomo.ciclo % 4 || 4} de 4 focos. Levante, beba água: ${pomo[pomo.fase]} min de pausa.` : `Pronto para mais ${pomo.foco} min de foco?`;
  if (pomo.aviso === "som") sininho();
  if (pomo.aviso !== "visual" && "Notification" in window && Notification.permission === "granted" && document.hidden) {
    try { new Notification(titulo, { body: texto, tag: "pomodoro", icon: $('link[rel="icon"]').href }); } catch {}
  }
  $("#alertaIcone").textContent = eraFoco ? "☕" : "📚";
  $("#tAlerta").textContent = titulo; $("#alertaTexto").textContent = texto;
  $("#alertaSeguir").textContent = `Começar ${NOMES_FASE[pomo.fase].toLowerCase()}`;
  $("#alertaPomo").hidden = false;
  $("#relogio").classList.remove("terminou"); void $("#relogio").offsetWidth; $("#relogio").classList.add("terminou");
}
$("#alertaSeguir").onclick = () => { $("#alertaPomo").hidden = true; iniciarPomo(); };
$("#alertaPular").onclick = () => { $("#alertaPomo").hidden = true; proximaFase(false); iniciarPomo(); };
setInterval(() => {
  if (pomo.rodando && restante() <= 0) fimDeFase();
  desenharPomo();
}, 500);

$("#btnPomo").onclick = () => abrirMenu("#popPomo", $("#btnPomo"));
$("#btnPomoNav").onclick = () => abrirMenu("#popPomo", $("#btnPomoNav")); // celular: na biblioteca o topo some
$("#pomoComecar").onclick = () => { pomo.rodando ? pausarPomo() : iniciarPomo(); fecharMenus(); };
$("#pomoZerar").onclick = zerarPomo;
$("#pomoPlay").onclick = () => (pomo.rodando ? pausarPomo() : iniciarPomo());
$("#pomoPular").onclick = () => { proximaFase(false); iniciarPomo(); };
$("#pomoOcultar").onclick = () => { pomo.mostrar = false; $("#pomoMostrar").checked = false; salvarPomo(); desenharPomo(); };
$("#relogioMini").onclick = () => { pomo.mostrar = true; $("#pomoMostrar").checked = true; salvarPomo(); desenharPomo(); };
for (const [id, campo] of [["#pomoFoco", "foco"], ["#pomoPausa", "pausa"], ["#pomoLonga", "longa"]]) {
  $(id).value = pomo[campo];
  $(id).onchange = () => {
    const v = Math.round(+$(id).value);
    if (v >= +$(id).min && v <= +$(id).max) { pomo[campo] = v; if (!pomo.rodando && pomo.fase === campo) delete pomo.restante; salvarPomo(); desenharPomo(); }
    else $(id).value = pomo[campo];
  };
}
$("#pomoAviso").value = pomo.aviso;
$("#pomoAviso").onchange = () => {
  pomo.aviso = $("#pomoAviso").value; salvarPomo();
  if (pomo.aviso !== "visual" && "Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  if (pomo.aviso === "som") sininho(); // amostra do som
};
$("#pomoMostrar").checked = pomo.mostrar;
$("#pomoMostrar").onchange = () => { pomo.mostrar = $("#pomoMostrar").checked; salvarPomo(); desenharPomo(); };
$("#pomoAuto").checked = pomo.auto;
$("#pomoAuto").onchange = () => { pomo.auto = $("#pomoAuto").checked; salvarPomo(); };
$("#pomoPararLeitura").checked = pomo.pararLeitura;
$("#pomoPararLeitura").onchange = () => { pomo.pararLeitura = $("#pomoPararLeitura").checked; salvarPomo(); };
// arrastar o relógio para outro canto (a posição fica salva)
{
  const r = $("#relogio"), pos = lembrar("pomoPos", null);
  const colocar = (x, y) => Object.assign(r.style, { left: Math.max(4, Math.min(innerWidth - r.offsetWidth - 4, x)) + "px", top: Math.max(4, Math.min(innerHeight - r.offsetHeight - 4, y)) + "px", right: "auto", bottom: "auto" });
  if (pos && !matchMedia("(max-width: 820px)").matches) Object.assign(r.style, { left: pos.x + "px", top: pos.y + "px", right: "auto", bottom: "auto" });
  let ini = null;
  r.querySelector(".arrastar").onpointerdown = (e) => { const b = r.getBoundingClientRect(); ini = { dx: e.clientX - b.left, dy: e.clientY - b.top }; r.setPointerCapture(e.pointerId); };
  r.onpointermove = (e) => { if (ini) colocar(e.clientX - ini.dx, e.clientY - ini.dy); };
  const moverMini = () => { // a bolinha fica onde o relógio foi deixado (posição salva; escondido ele não tem tamanho)
    const p = lembrar("pomoPos", null);
    if (!p || matchMedia("(max-width: 820px)").matches) return;
    Object.assign($("#relogioMini").style, { left: p.x + "px", top: Math.min(innerHeight - 52, p.y) + "px", right: "auto", bottom: "auto" });
  };
  moverMini();
  r.onpointerup = () => { if (!ini) return; ini = null; guardar("pomoPos", { x: parseInt(r.style.left), y: parseInt(r.style.top) }); moverMini(); };
  new MutationObserver(moverMini).observe(r, { attributes: true, attributeFilter: ["hidden"] });
  addEventListener("resize", () => { if (r.style.left) colocar(parseInt(r.style.left), parseInt(r.style.top)); });
}
document.addEventListener("click", (e) => { if (!e.target.closest("#popPomo, #btnPomo, #btnPomoNav, #toast")) $("#popPomo").hidden = true; });

// começa sozinho quando a pessoa começa a estudar (ler ou flash cards), se não houver um em andamento nem pausado por ela
function pomoAoEstudar() {
  const ativo = pomo.rodando || (pomo.restante != null && pomo.restante < duracao(pomo.fase));
  if (!pomo.auto || ativo || pomo.fase !== "foco") return;
  iniciarPomo();
  const primeira = !lembrar("pomoApresentado", false);
  guardar("pomoApresentado", true);
  toast(primeira ? `🍅 Pomodoro de ${pomo.foco} min começou junto com a leitura: foco agora, pausa de ${pomo.pausa} min depois.` : `🍅 Pomodoro de ${pomo.foco} min começou.`,
    [["Ajustar", () => abrirMenu("#popPomo", matchMedia("(max-width: 820px)").matches && document.body.classList.contains("na-biblioteca") ? $("#btnPomoNav") : $("#btnPomo"))],
     ["Não iniciar sozinho", () => { pomo.auto = false; $("#pomoAuto").checked = false; pausarPomo(); zerarPomo(); salvarPomo(); toast("Ok, o Pomodoro só começa quando você tocar no botão dele.", [], 4000); }]],
    primeira ? 9000 : 4000);
}
// aviso rápido embaixo da tela, com botões opcionais
let toastTm;
function toast(texto, botoes = [], ms = 5000) {
  clearTimeout(toastTm);
  $("#toastTexto").textContent = texto;
  $("#toastBotoes").innerHTML = "";
  botoes.forEach(([rotulo, f]) => {
    const b = document.createElement("button"); b.textContent = rotulo;
    b.onclick = (e) => { e.stopPropagation(); $("#toast").hidden = true; f(); };
    $("#toastBotoes").append(b);
  });
  $("#toast").hidden = false;
  toastTm = setTimeout(() => ($("#toast").hidden = true), ms);
}
desenharPomo();


// ---------- tela de bloqueio do celular: título do tópico e controles (play/pause, frase anterior/próxima) ----------
function sessaoMidia() {
  if (!("mediaSession" in navigator) || !estudo) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: estudo.topicos[topico]?.titulo || estudo.titulo, artist: estudo.titulo, album: "saber.ia",
    artwork: [{ src: "icone-192.png", sizes: "192x192", type: "image/png" }, { src: "icone-512.png", sizes: "512x512", type: "image/png" }],
  });
  navigator.mediaSession.playbackState = "playing";
}
if ("mediaSession" in navigator) {
  const acao = (nome, f) => { try { navigator.mediaSession.setActionHandler(nome, f); } catch {} };
  acao("play", () => { if (estudo && !tocando) tocar(); });
  acao("pause", () => parar());
  acao("previoustrack", () => $("#fraseAnt").click());
  acao("nexttrack", () => $("#fraseProx").click());
}

// ---------- desligar a leitura depois de X minutos (ou no fim do tópico), para ouvir antes de dormir ----------
let sono = { fim: 0, topico: null };
$("#sonoTimer").onchange = () => {
  const v = $("#sonoTimer").value;
  sono = v === "0" ? { fim: 0, topico: null } : v === "topico" ? { fim: 0, topico: estudo ? topico : null } : { fim: Date.now() + +v * 60000, topico: null };
  if (v !== "0") toast(v === "topico" ? "A leitura vai parar no fim deste tópico." : `A leitura vai parar em ${v} minutos.`, [], 3000);
  desenharSono();
};
function desenharSono() {
  const r = sono.fim ? sono.fim - Date.now() : 0;
  $("#sonoResta").textContent = sono.fim ? `para em ${Math.ceil(r / 60000)} min` : sono.topico != null ? "para no fim deste tópico" : "";
}
function encerrarSono(msg) {
  sono = { fim: 0, topico: null }; $("#sonoTimer").value = "0"; desenharSono();
  // abaixa o volume aos poucos antes de parar (não acordar com um corte seco)
  let v = audio.volume; const passo = v / 10; const t = setInterval(() => { v -= passo; audio.volume = Math.max(0, v); if (v <= 0.001) { clearInterval(t); parar(); aplicarVolume(); toast(msg, [], 6000); } }, 200);
}
setInterval(() => {
  if (sono.fim && Date.now() >= sono.fim && tocando) encerrarSono("Leitura desligada pelo timer. Boa noite!");
  else if (sono.fim && Date.now() >= sono.fim) { sono = { fim: 0, topico: null }; $("#sonoTimer").value = "0"; }
  if (sono.topico != null && estudo && topico !== sono.topico && tocando) encerrarSono("Fim do tópico: leitura desligada pelo timer.");
  desenharSono();
}, 1000);

// ---------- aparência: tema e tamanho da letra ----------
function aplicarTema() {
  const t = lembrar("tema", "sistema");
  if (t === "sistema") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  document.querySelectorAll("[data-tema]").forEach((b) => b.classList.toggle("ativo", b.dataset.tema === t));
  const escuro = t === "dark" || (t === "sistema" && matchMedia("(prefers-color-scheme: dark)").matches);
  $('meta[name="theme-color"]').content = escuro ? "#0a2140" : "#0053FA";
}
document.querySelectorAll("[data-tema]").forEach((b) => (b.onclick = () => { guardar("tema", b.dataset.tema); aplicarTema(); }));
const ESCALAS = [0.85, 0.92, 1, 1.1, 1.2, 1.35, 1.5];
function aplicarLetra() {
  const e = lembrar("escalaTexto", 1);
  document.documentElement.style.setProperty("--escala-texto", e);
  $("#letraValor").textContent = Math.round(e * 100) + "%";
  $("#letraMenos").disabled = e <= ESCALAS[0]; $("#letraMais").disabled = e >= ESCALAS.at(-1);
}
const passoLetra = (d) => { const i = ESCALAS.indexOf(lembrar("escalaTexto", 1)); guardar("escalaTexto", ESCALAS[Math.max(0, Math.min(ESCALAS.length - 1, (i < 0 ? 2 : i) + d))]); aplicarLetra(); };
$("#letraMenos").onclick = () => passoLetra(-1);
$("#letraMais").onclick = () => passoLetra(1);
aplicarTema(); aplicarLetra();
$("#animarFolha").checked = lembrar("animarFolha", true);
$("#animarFolha").onchange = () => guardar("animarFolha", $("#animarFolha").checked);

// ---------- backup: exportar e importar a biblioteca (um arquivo .json) ----------
const PREFS_BACKUP = ["voz", "vel", "pensar", "prefPerguntas", "prefResumo", "usarIa", "lerCartao", "pomo", "tema", "escalaTexto", "ultimo", "plano", "objetivo", "animarFolha", "volume", "mudo"];
// o backup inteiro (materiais + preferências). A chave da IA só vai na mudança de endereço (é a mesma pessoa, de
// navegador para navegador, sem passar por arquivo); no arquivo .json fica de fora de propósito
function montarBackup(comChave = false) {
  const dados = {};
  for (const k of espelho.keys()) dados[k] = espelho.get(k);
  if (!banco) for (const k of Object.keys(localStorage).filter((k) => NO_BANCO.test(k))) dados[k] = localStorage.getItem(k);
  for (const k of PREFS_BACKUP) { const v = localStorage.getItem(k); if (v != null) dados[k] = v; }
  if (comChave) for (const k of ["chave", "alteradoEm"]) { const v = localStorage.getItem(k); if (v != null) dados[k] = v; }
  return { app: "leitor-estudo", versao: 1, criado: new Date().toISOString(), dados };
}
function baixarBackup() {
  const arquivo = new Blob([JSON.stringify(montarBackup())], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(arquivo), download: `leitor-estudo-backup-${new Date().toISOString().slice(0, 10)}.json` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast(`Backup salvo: ${indice().length} materiais. A chave da IA não vai junto.`, [], 5000);
}
$("#exportar").onclick = baixarBackup;
$("#importar").onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  try {
    const b = JSON.parse(await f.text());
    if (b.app !== "leitor-estudo" || !b.dados) throw new Error("este arquivo não é um backup do saber.ia");
    const atuais = indice(), vindos = JSON.parse(b.dados.estudos || "[]");
    for (const [k, v] of Object.entries(b.dados)) {
      if (k === "estudos") continue;
      if (NO_BANCO.test(k)) guardar(k, JSON.parse(v)); else if (PREFS_BACKUP.includes(k)) try { localStorage.setItem(k, v); } catch {}
    }
    // junta as listas: o que veio do backup substitui o material de mesmo id; o resto continua
    guardar("estudos", [...vindos, ...atuais.filter((e) => !vindos.some((x) => x.id === e.id))]);
    fecharModais(); aplicarTema(); aplicarLetra(); aplicarVolume(); $("#animarFolha").checked = lembrar("animarFolha", true); mostrarVoz(); mostrarBiblioteca();
    toast(`Backup importado: ${vindos.length} materiais.`, [], 5000);
  } catch (err) { toast("Não deu para importar: " + err.message, [], 7000); }
};
async function mostrarEspaco() {
  try { const { usage } = await navigator.storage.estimate(); $("#espacoUsado").textContent = `Espaço usado neste navegador: ${(usage / 1048576).toFixed(1).replace(".", ",")} MB (inclui a voz).`; } catch {}
}

// ---------- instalar como app (PWA): funciona sem internet para o que já está salvo ----------
let pedidoInstalar = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); pedidoInstalar = e; textoInstalar(); });
addEventListener("appinstalled", () => { pedidoInstalar = null; textoInstalar(); toast("saber.ia instalado! Ele aparece junto com os seus apps.", [], 5000); });
function textoInstalar() {
  const instalado = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $("#btnInstalar").hidden = !pedidoInstalar || instalado;
  $("#textoInstalar").textContent = instalado ? "Você já está usando o app instalado. Ele abre sem a barra do navegador e funciona sem internet para os materiais salvos."
    : pedidoInstalar ? "Instale para abrir pelo ícone, sem a barra do navegador, e estudar até sem internet (os materiais já salvos)."
    : ios ? "No iPhone: toque em Compartilhar (quadrado com seta) e depois em “Adicionar à Tela de Início”."
    : "No Chrome ou Edge: menu ⋮ → “Instalar app” (ou o ícone de instalar na barra de endereço). No celular Android: menu ⋮ → “Adicionar à tela inicial”.";
}
$("#btnInstalar").onclick = async () => { if (!pedidoInstalar) return; pedidoInstalar.prompt(); await pedidoInstalar.userChoice.catch(() => {}); pedidoInstalar = null; textoInstalar(); };
$("#btnConfig").addEventListener("click", () => { textoInstalar(); mostrarEspaco(); });
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
textoInstalar();

// ---------- mudança de endereço: ericcoutinho.github.io/leitor-estudo → saberia.regra32.tec.br ----------
// Cada endereço tem o próprio armazenamento, então os materiais são levados em 1 clique: o antigo abre o novo em outra
// aba (#migrar); o novo avisa que está pronto (postMessage), o antigo manda o backup completo + chave da IA, e o novo
// junta com o que já tiver lá e confirma. Os dois lados só aceitam mensagens da origem do outro e só mandam para ela.
const ENDERECOS = { antigo: "https://ericcoutinho.github.io", novo: "https://saberia.regra32.tec.br" };
// teste no próprio computador: sirva a pasta em duas portas (antigo e novo). Só vale quando a página roda em localhost.
const ENDERECOS_TESTE = { antigo: "http://localhost:8101", novo: "http://localhost:8102" };
const END = ["localhost", "127.0.0.1"].includes(location.hostname) ? ENDERECOS_TESTE : ENDERECOS;
const NOVO_URL = END.novo + "/", NOVO_NOME = new URL(END.novo).host;
const ICONE_MUDOU = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const ICONE_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>';
const ICONE_ATENCAO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>';
const nMateriais = (n) => (n === 1 ? "1 material" : `${n} materiais`);
function avisoMudou(tipo, icone, html, ligar = {}) {
  const el = $("#mudou");
  el.className = "mudou" + (tipo ? " " + tipo : ""); el.innerHTML = icone + `<div>${html}</div>`; el.hidden = false;
  for (const [id, f] of Object.entries(ligar)) { const b = el.querySelector("#" + id); if (b) b.onclick = f; }
}

// confere o formato do que chegou e devolve só as chaves conhecidas (o resto é ignorado)
function lerBackupRecebido(b) {
  if (!b || b.app !== "leitor-estudo" || !b.dados || typeof b.dados !== "object") return null;
  const dados = {};
  for (const [k, v] of Object.entries(b.dados)) {
    if (typeof v !== "string") continue;
    if (!(NO_BANCO.test(k) || PREFS_BACKUP.includes(k) || k === "chave" || k === "alteradoEm")) continue;
    try { JSON.parse(v); } catch { continue; }
    dados[k] = v;
  }
  let lista; try { lista = JSON.parse(dados.estudos || "[]"); } catch { return null; }
  if (!Array.isArray(lista) || lista.some((e) => !e || typeof e.id !== "string")) return null;
  return { dados, lista };
}

// junta os materiais recebidos com os deste navegador, sem apagar nada: material novo entra; o que existe nos dois
// lados fica com a versão alterada por último (sem carimbo, a que tem mais tópicos organizados ou mais leitura)
const PARTES = ["estudo:", "pos:", "caixas:", "simulado:"];
function mesclarRecebido({ dados, lista }) {
  const meus = carimbos(), atuais = indice();
  let deles = {}; try { deles = JSON.parse(dados.alteradoEm || "{}") || {}; } catch {}
  const prontos = (e) => (e ? (e.topicos?.length || 0) - (e.pendentes?.length || 0) : -1);
  const vence = (id) => {
    if (deles[id] && meus[id]) return deles[id] > meus[id];
    if (deles[id] || meus[id]) return !!deles[id];
    const ev = JSON.parse(dados["estudo:" + id]), ea = lembrar("estudo:" + id, null);
    if (prontos(ev) !== prontos(ea)) return prontos(ev) > prontos(ea);
    return (JSON.parse(dados["pos:" + id] || "{}")?.pct || 0) > (lembrar("pos:" + id, {}).pct || 0);
  };
  const atual = (k) => (banco ? espelho.get(k) : localStorage.getItem(k)) ?? null;
  let novos = 0, atualizados = 0, iguais = 0;
  const resumos = new Map(atuais.map((e) => [e.id, e])), carimbosFinais = { ...meus };
  for (const r of lista) {
    if (!dados["estudo:" + r.id]) continue;
    const existe = atual("estudo:" + r.id) != null;
    if (existe && PARTES.every((p) => (dados[p + r.id] ?? null) === atual(p + r.id))) { iguais++; resumos.set(r.id, resumos.get(r.id) || r); continue; }
    const ganha = !existe || vence(r.id);
    // ganhou: fica a versão que chegou; perdeu: só completa o que faltar aqui
    for (const p of PARTES) { const v = dados[p + r.id]; if (v != null && (ganha || atual(p + r.id) == null)) guardar(p + r.id, JSON.parse(v)); }
    if (!existe) novos++; else if (ganha) atualizados++;
    if (ganha) { resumos.set(r.id, r); if (deles[r.id]) carimbosFinais[r.id] = deles[r.id]; else delete carimbosFinais[r.id]; }
    else carimbosFinais[r.id] = meus[r.id] || carimbosFinais[r.id];
  }
  // a lista: os daqui na ordem de sempre, e os que chegaram agora logo depois
  guardar("estudos", [...atuais.map((e) => resumos.get(e.id)), ...[...resumos.values()].filter((e) => !atuais.some((a) => a.id === e.id))]);
  try { localStorage.setItem("alteradoEm", JSON.stringify(carimbosFinais)); } catch {}
  // preferências, plano e chave da IA: só entram se ainda não existirem aqui (não sobrescreve o que já foi ajustado)
  for (const k of [...PREFS_BACKUP, "chave"]) if (dados[k] != null && localStorage.getItem(k) == null) try { localStorage.setItem(k, dados[k]); } catch {}
  $("#chave").value = lembrar("chave", "");
  vozAtual = lembrar("voz", vozAtual); velAtual = VELS.includes(lembrar("vel", velAtual)) ? lembrar("vel", velAtual) : velAtual;
  aplicarTema(); aplicarLetra(); aplicarVolume(); $("#animarFolha").checked = lembrar("animarFolha", true); mostrarVoz();
  if (!estudo) mostrarBiblioteca();
  return { total: lista.length, novos, atualizados, iguais };
}

// lado NOVO: aberto pelo antigo com #migrar
function receberMigracao() {
  history.replaceState(null, "", location.pathname + location.search);
  if (!window.opener) return;
  avisoMudou("", ICONE_MUDOU, `<b>Recebendo seus materiais do endereço antigo…</b><p>Deixe a outra aba aberta por alguns segundos.</p><div class="progresso"><i></i></div>`);
  let recebido = false, tentativas = 0;
  addEventListener("message", (ev) => {
    if (ev.origin !== END.antigo || ev.source !== window.opener || ev.data?.tipo !== "saberia-dados" || recebido) return;
    recebido = true;
    const responder = (msg) => { try { ev.source.postMessage(msg, END.antigo); } catch {} };
    const b = lerBackupRecebido(ev.data.backup);
    if (!b) {
      avisoMudou("erro", ICONE_ATENCAO, `<b>Os dados do endereço antigo não vieram certos.</b><p>Use o caminho manual: lá, em Configurações → Exportar backup; aqui, Configurações → Importar backup.</p>`);
      return responder({ tipo: "saberia-erro" });
    }
    try {
      const r = mesclarRecebido(b);
      const detalhe = [r.novos && `${r.novos} ${r.novos === 1 ? "novo" : "novos"}`, r.atualizados && `${r.atualizados} ${r.atualizados === 1 ? "atualizado" : "atualizados"}`,
        r.iguais && `${r.iguais} já ${r.iguais === 1 ? "estava" : "estavam"} aqui`].filter(Boolean).join(", ");
      avisoMudou("ok", ICONE_OK, `<b>${r.total === 1 ? "Chegou 1 material" : `Chegaram ${r.total} materiais`} do endereço antigo${detalhe ? ` (${detalhe})` : ""}.</b>
        <p>A partir de agora use este endereço, ${esc(NOVO_NOME)}. Flash cards, progresso, plano e a chave da IA vieram junto.</p>
        <div class="acoes"><button id="mudouFechar">Ver minha biblioteca</button></div>`, { mudouFechar: () => { $("#mudou").hidden = true; if (!estudo) mostrarBiblioteca(); } });
      responder({ tipo: "saberia-ok", materiais: r.total });
      if (lembrar("voz", null) === null) boasVindas(); // o antigo nem tinha voz escolhida: pergunta agora
    } catch (err) {
      avisoMudou("erro", ICONE_ATENCAO, `<b>Não deu para guardar os materiais aqui.</b><p>${esc(err.message || err)}</p>`);
      responder({ tipo: "saberia-erro" });
    }
  });
  // avisa o antigo que está pronto (repete algumas vezes, caso a primeira mensagem se perca)
  const avisar = () => { if (recebido || tentativas++ > 10 || !window.opener) return; try { window.opener.postMessage({ tipo: "saberia-pronto" }, END.antigo); } catch {} setTimeout(avisar, 1500); };
  avisar();
}

// lado ANTIGO
function avisoEnderecoAntigo() {
  const params = new URLSearchParams(location.search);
  if (params.has("ficar")) { try { localStorage.removeItem("migrado"); } catch {} } // ?ficar: cancela o redirecionamento
  else if (localStorage.getItem("migrado")) return location.replace(NOVO_URL);
  const n = indice().length, temAlgo = n || localStorage.getItem("chave") || localStorage.getItem("plano");
  if (!temAlgo) {
    if (!params.has("ficar")) return location.replace(NOVO_URL); // nada guardado aqui: vai direto
    return avisoMudou("", ICONE_MUDOU, `<b>O saber.ia mudou de endereço: ${esc(NOVO_NOME)}</b><p>Use o novo endereço daqui em diante.</p>
      <div class="acoes"><a class="botao" href="${NOVO_URL}">Abrir o novo endereço</a></div>`);
  }
  const manual = (motivo) => avisoMudou("erro", ICONE_ATENCAO, `<b>${motivo}</b>
    <p>Tente de novo (se o navegador avisar que bloqueou uma janela, permita para este site). Ou faça à mão: baixe o backup aqui; depois, no novo endereço, abra Configurações → Importar backup e escolha o arquivo. A chave da IA você coloca de novo lá, em Chave da IA.</p>
    <div class="acoes"><button id="mudouLevar">Tentar de novo</button><button class="sec" id="mudouBaixar">Baixar backup</button><a href="${NOVO_URL}" target="_blank" rel="noopener">Abrir o novo endereço</a></div>`,
    { mudouLevar: levar, mudouBaixar: baixarBackup });
  let ouvinte = null, prazo = 0;
  function levar() {
    if (ouvinte) removeEventListener("message", ouvinte);
    clearTimeout(prazo);
    const janela = window.open(NOVO_URL + "#migrar", "_blank");
    if (!janela) return manual("O navegador bloqueou a abertura do novo endereço.");
    avisoMudou("", ICONE_MUDOU, `<b>Levando seus materiais para ${esc(NOVO_NOME)}…</b><p>O novo endereço abriu em outra aba. Não feche esta aba até aparecer “Pronto”.</p><div class="progresso"><i></i></div>`);
    let enviado = false;
    ouvinte = (ev) => {
      if (ev.origin !== END.novo || ev.source !== janela) return; // só o novo endereço, e só a aba que abrimos
      if (ev.data?.tipo === "saberia-pronto" && !enviado) {
        enviado = true;
        janela.postMessage({ tipo: "saberia-dados", backup: montarBackup(true) }, END.novo);
      } else if (ev.data?.tipo === "saberia-ok") {
        clearTimeout(prazo); removeEventListener("message", ouvinte); ouvinte = null;
        try { localStorage.setItem("migrado", new Date().toISOString()); } catch {}
        const m = Number(ev.data.materiais) || 0;
        avisoMudou("ok", ICONE_OK, `<b>Pronto! ${nMateriais(m)} ${m === 1 ? "levado" : "levados"} para ${esc(NOVO_NOME)}.</b>
          <p>Daqui em diante, este endereço abre o novo direto. Nada foi apagado daqui.</p>
          <div class="acoes"><a class="botao" href="${NOVO_URL}">Ir para o novo endereço</a></div>`);
      } else if (ev.data?.tipo === "saberia-erro") {
        clearTimeout(prazo); removeEventListener("message", ouvinte); ouvinte = null;
        manual("O novo endereço não conseguiu receber os materiais.");
      }
    };
    addEventListener("message", ouvinte);
    prazo = setTimeout(() => { removeEventListener("message", ouvinte); ouvinte = null; manual("O novo endereço não respondeu."); }, 20000);
  }
  avisoMudou("", ICONE_MUDOU, `<b>O saber.ia mudou de endereço: ${esc(NOVO_NOME)}</b>
    <p>${n === 1 ? "Seu material está guardado neste navegador, neste endereço." : n ? `Seus ${n} materiais estão guardados neste navegador, neste endereço.` : "Seu plano e seus ajustes estão guardados neste navegador, neste endereço."} Leve tudo para o novo em 1 clique: flash cards, progresso, plano e a chave da IA vão junto.</p>
    <div class="acoes"><button id="mudouLevar">Levar meus materiais</button><a href="${NOVO_URL}">Só abrir o novo endereço</a></div>`, { mudouLevar: levar });
}

if (location.origin === END.antigo) avisoEnderecoAntigo();
else if (location.origin === END.novo && location.hash === "#migrar") receberMigracao();
