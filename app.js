// Leitor de Estudo (versão web, sem servidor): extrai o texto do arquivo, a IA (Gemini, chave do próprio usuário)
// organiza em tópicos e a voz Kokoro lê no aparelho (voz-worker.js). Materiais ficam salvos neste navegador.
import * as pdfjs from "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
import { paraFala } from "./texto.js?v=20261025024134";

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

async function organizar(trecho, chave, aviso) {
  const o = await gemini(INSTRUCAO + "\n\nTRECHO:\n" + trecho, chave, aviso, (o) => Array.isArray(o.topicos) && o.topicos.length);
  return { topicos: o.topicos, ingles: Array.isArray(o.ingles) ? o.ingles : [] };
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
  const resumo = { id: e.id, titulo: e.titulo, criado: e.criado, organizado_por: e.organizado_por, topicos: e.topicos.length, faltam: e.pendentes?.length || 0 };
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
      const o = await organizar(e.pendentes[0], chave, aviso);
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

async function criarMaterial(titulo, texto, tipo) {
  const st = $("#estado"); st.className = "estado";
  const chave = $("#chave").value.trim();
  const querIa = $("#usarIa").checked, usarIa = querIa && chave;
  const agora = new Date();
  const e = { id: String(agora.getTime()), titulo, tipo, criado: agora.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }),
    organizado_por: usarIa ? "Gemini" : "sem IA", topicos: [], pronuncia: {}, pendentes: [], partes_total: 0 };
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
  carregarLista();
}

// ---------- tela de preparo do material novo ----------
// Em vez de deixar a pessoa no material antigo com um aviso pequeno no topo, a tela vai para o material novo e mostra
// as etapas. Quando a 1ª parte fica pronta, o material abre; as outras continuam chegando enquanto ela lê.
let preparo = null; // { id, titulo, etapa, palavras, erro }
const andamento = new Map(); // id → { n, total, texto } da organização em curso (também aparece na biblioteca)
function mostrarPreparo(mudar = {}) {
  parar(); estudo = null;
  preparo = { ...preparo, ...mudar };
  document.body.classList.add("na-biblioteca"); document.body.classList.remove("modo-cartoes");
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
document.addEventListener("click", (e) => { if (!e.target.closest(".pop, #btnVoz, #btnVel, #btnMais")) fecharMenus(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { fecharMenus(); fecharModais(); } });

const VOZES = [["pf_dora", "Dora", "feminina"], ["pm_alex", "Alex", "masculina"], ["pm_santa", "Santa", "masculina"]];
const VELS = ["0.8", "0.9", "1.0", "1.1", "1.25", "1.5"];
let vozAtual = lembrar("voz", "pf_dora"), velAtual = lembrar("vel", "1.0");
if (!VELS.includes(velAtual)) velAtual = "1.0";
const amostra = new Audio();
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
  const t = tocando; parar(); f(); guardar(chave, chave === "voz" ? vozAtual : velAtual);
  limparPre(); mostrarVoz(); fecharMenus(); if (t) tocar();
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
  parar(); estudo = null; modo = "ler"; preparo = null;
  $("#tituloTopo").textContent = "Biblioteca";
  document.body.classList.add("na-biblioteca"); document.body.classList.remove("modo-cartoes");
  $("#navBiblioteca").classList.add("ativo"); $("#linhaProgresso").style.width = "0";
  const lista = indice();
  const soltar = `<label class="soltar" id="soltarBiblioteca"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3M7 8l5-5 5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></svg>
    <h2>${lista.length ? "Adicionar outro material" : "Comece pelo material da prova"}</h2><p>Arraste um PDF, Word ou texto aqui, ou <b style="color:var(--destaque)">clique para escolher</b></p></label>`;
  $("#coluna").innerHTML = `<div class="cab"><h1>Biblioteca<small>${lista.length || ""}</small></h1>${lista.length ? '<button class="pri" id="novoCab">+ Novo material</button>' : ""}</div>` +
    (lista.length ? `<div class="lista">${lista.map((e) => {
      const salvo = lembrar("pos:" + e.id, {}), pct = Math.round((salvo.pct || 0) * 100);
      const ia = e.organizado_por !== "sem IA";
      return `<div class="material" role="button" tabindex="0" data-id="${esc(e.id)}">
        <span class="miniatura">${ICONE_TIPO[e.tipo === "pdf" ? "pdf" : "txt"]}</span>
        <span class="info"><b>${esc(e.titulo)}</b>
          <small>${andamento.has(e.id) ? `<span class="etiqueta organizando">Organizando parte ${andamento.get(e.id).n} de ${andamento.get(e.id).total}…</span>` : `<span class="etiqueta ${ia ? "ia" : ""}">${ia ? "Organizado com IA" : "Texto original"}</span>`} · ${e.topicos} tópicos${e.faltam ? ` · faltam ${e.faltam} partes` : ""} · ${esc(e.criado)}${pct ? ` · ${pct}% lido` : ""}</small>
          ${pct ? `<span class="barrinha"><i style="width:${pct}%"></i></span>` : ""}</span>
        <button class="apagar-item" data-apagar="${esc(e.id)}" title="Apagar">Apagar</button></div>`;
    }).join("")}</div><div style="margin-top:18px">${soltar}</div>` : soltar);
  // o clique na área de soltar abre a janela, onde fica o interruptor de organizar com IA
  $("#soltarBiblioteca").onclick = (ev) => { ev.preventDefault(); abrirModal("#modalNovo"); };
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
  try { localStorage.removeItem("estudo:" + id); localStorage.removeItem("pos:" + id); localStorage.removeItem("caixas:" + id); } catch {}
  guardar("estudos", indice().filter((e) => e.id !== id));
}
// a lista só aparece na tela da biblioteca; nas outras telas não há o que atualizar
function carregarLista() { if (!estudo && !preparo) mostrarBiblioteca(); }

// ---------- voz ----------
const worker = new Worker(new URL("./voz-worker.js?v=20261025024134", import.meta.url), { type: "module" });
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
  preparo = null;
  modo = "ler"; filtroTopico = "todos"; document.body.classList.remove("modo-cartoes", "na-biblioteca");
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
  if (organizando.has(estudo.id)) return `<div class="continuar">Organizando com IA… o andamento aparece logo abaixo do topo.</div>`;
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
  let html = faixaIa() + abas() + `<div class="nav-topico">
    <button class="icone" id="topAnt" title="Tópico anterior" aria-label="Tópico anterior" ${topico ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m15 18-6-6 6-6"/></svg></button>
    <button class="btn-sumario" id="abrirSumario" title="Ver todos os tópicos"><span class="n">${topico + 1} de ${n}</span><b>${esc(tp.titulo)}</b><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg></button>
    <button class="icone" id="topProx" title="Próximo tópico" aria-label="Próximo tópico" ${topico < n - 1 ? "" : "disabled"}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 18 6-6-6-6"/></svg></button></div>`;
  html += `<div class="folha entra"><h2 class="titulo">${span(tp.titulo, "titulo")}</h2><div class="texto">${(tp.texto || "").split(/\n\s*\n/).map((par) => `<p>${frases(par).map((f) => span(f)).join("")}</p>`).join("")}</div>`;
  if (tp.resumo && lembrar("prefResumo", true)) {
    fila.push({ texto: "Resumindo.", tipo: "aviso" });
    html += `<div class="cartao"><h3>Resumo</h3><div class="texto">${frases(tp.resumo).map((f) => span(f)).join("")}</div></div>`;
  }
  if (tp.perguntas?.length && lembrar("prefPerguntas", true)) {
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
  $("#barraMarca").hidden = true;
  pintarMarcas();
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
  const tocava = tocando; parar(); fecharSumario(); montar(t); if (tocava) tocar();
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
    if (!estudo || modo !== "ler" || !sel.rangeCount || sel.isCollapsed || sel.toString().trim().length < 3) { barra.hidden = true; return; }
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
document.querySelectorAll("#barraMarca button").forEach((b) => {
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
// ouvir a explicação da IA com a mesma voz da leitura
function ouvirTexto(texto) {
  parar();
  const minha = ++falaCartao;
  carregando(true);
  sintetizar(texto).then((url) => { if (minha === falaCartao) { audio.src = url; audio.play().catch(() => {}); } })
    .catch(() => {}).finally(() => carregando(false));
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
  document.querySelectorAll("[data-ouvir]").forEach((b) => (b.onclick = () => ouvirTexto(acha(b.dataset.ouvir).resposta)));
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
function fecharDuvidas() { $("#duvidas").hidden = $("#fundoDuvidas").hidden = true; }
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
  carregando(false);
  tocando = false; $("#tocar").innerHTML = PLAY; audio.onpause = null; audio.pause();
  if (espera) { espera(false); espera = null; }
}

$("#tocar").onclick = () => (tocando ? parar() : tocar());
const pular = (f) => () => { const t = tocando; parar(); f(); if (t) tocar(); };
$("#fraseAnt").onclick = pular(() => ir(pos - 1));
$("#fraseProx").onclick = pular(() => ir(pos + 1));
document.onkeydown = (e) => {
  if (["SELECT", "INPUT"].includes(e.target.tagName)) return;
  if (modo === "cartoes") { // espaço vira; 1/← não sabia; 2/→ sabia
    if (e.code === "Space") { e.preventDefault(); $("#virar")?.click(); }
    if (["Digit1", "ArrowLeft"].includes(e.code)) $("#naoSabia")?.click();
    if (["Digit2", "ArrowRight"].includes(e.code)) $("#sabia")?.click();
    return;
  }
  if (e.code === "Space") { e.preventDefault(); $("#tocar").click(); }
  if (e.code === "ArrowLeft") $("#fraseAnt").click();
  if (e.code === "ArrowRight") $("#fraseProx").click();
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
    `<button class="aba ${modo === "cartoes" ? "ativo" : ""}" data-modo="cartoes" role="tab">Flash cards${n ? ` (${n})` : ""}</button></div>`;
}
function ligarAbas() {
  document.querySelectorAll(".aba").forEach((b) => (b.onclick = () => {
    if (b.dataset.modo === modo) return;
    parar(); modo = b.dataset.modo;
    document.body.classList.toggle("modo-cartoes", modo === "cartoes");
    modo === "cartoes" ? novaRodada() : montar(topico, pos);
  }));
}

function novaRodada() {
  const cx = caixas();
  const todos = baralho(estudo).filter((c) => filtroTopico === "todos" || c.t === +filtroTopico);
  sessao = todos.map((c) => ({ c, s: (cx[c.chave] || 0) + Math.random() })).sort((a, b) => a.s - b.s).map((x) => x.c);
  rodada = { total: sessao.length, acertos: 0, erros: 0 };
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
  else if (!sessao.length) corpo = `<div class="fim-rodada"><h2>Rodada concluída</h2>
    <p>${rodada.acertos} acertos e ${rodada.erros} erros nesta rodada · ${dominados} de ${todos.length} cartões dominados.</p>
    <button class="pri" id="recomecar">Nova rodada</button></div>`;
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
mostrarVoz();
mostrarBiblioteca();
