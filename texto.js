// Prepara o texto para a voz: números por extenso, abreviações e termos em inglês aportuguesados.
// Mesma lógica de ../normalizar.py e ../pronuncia.py (versão com servidor).

const UNI = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze",
  "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZ = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CEM = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const GRUPOS = [["", ""], ["mil", "mil"], ["milhão", "milhões"], ["bilhão", "bilhões"], ["trilhão", "trilhões"]];

function ate999(n) {
  if (n === 100) return "cem";
  const c = Math.floor(n / 100), r = n % 100, partes = [];
  if (c) partes.push(CEM[c]);
  if (r) partes.push(r < 20 ? UNI[r] : DEZ[Math.floor(r / 10)] + (r % 10 ? " e " + UNI[r % 10] : ""));
  return partes.join(" e ");
}

export function inteiro(n) {
  if (n === 0) return "zero";
  const grupos = [];
  for (let g = 0; n > 0; g++, n = Math.floor(n / 1000)) grupos.push([n % 1000, g]);
  const ditos = grupos.filter(([v]) => v).reverse().map(([v, g]) => {
    if (g === 1 && v === 1) return { t: "mil", v };
    return { t: ate999(v) + (g ? " " + GRUPOS[g][v === 1 ? 0 : 1] : ""), v };
  });
  // "e" antes do último grupo quando ele é menor que 100 ou centena redonda (mil e quinhentos, dois mil e vinte e seis)
  return ditos.map((d, i) => (i && i === ditos.length - 1 && (d.v < 100 || d.v % 100 === 0) ? "e " : "") + d.t).join(" ");
}

function decimal(txt) {
  const [i, d] = txt.split(",");
  const zeros = d.match(/^0*/)[0].length;
  return inteiro(+i) + " vírgula " + "zero ".repeat(zeros) + (d.slice(zeros) ? inteiro(+d.slice(zeros)) : "");
}

const ORD_U = ["", "primeiro", "segundo", "terceiro", "quarto", "quinto", "sexto", "sétimo", "oitavo", "nono"];
const ORD_D = ["", "décimo", "vigésimo", "trigésimo", "quadragésimo", "quinquagésimo", "sexagésimo", "septuagésimo", "octogésimo", "nonagésimo"];
const ORD_C = ["", "centésimo", "ducentésimo", "trecentésimo", "quadringentésimo", "quingentésimo", "sexcentésimo", "septingentésimo", "octingentésimo", "noningentésimo"];
const ordinal = (n) => [ORD_C[Math.floor(n / 100) % 10], ORD_D[Math.floor(n / 10) % 10], ORD_U[n % 10]].filter(Boolean).join(" ");

const FEMININAS = new Set(("pessoa pessoas hora horas vez vezes casa casas família famílias criança crianças tonelada toneladas " +
  "estação estações cidade cidades semana semanas etapa etapas ligação ligações empresa empresas residência residências " +
  "unidade unidades bacia bacias nascente nascentes pergunta perguntas questão questões página páginas aula aulas " +
  "lei leis regra regras área áreas escola escolas").split(" "));
const feminino = (t) => t.replace(/\bum\b/g, "uma").replace(/\bdois\b/g, "duas").replace(/entos\b/g, "entas");

const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?`;
const valor = (txt) => txt.replace(/\./g, "");
const extenso = (txt, seguinte = "") => {
  const v = valor(txt);
  if (v.includes(",")) return decimal(v);
  const t = inteiro(+v);
  return FEMININAS.has(seguinte.toLowerCase()) ? feminino(t) : t;
};
function reais(txt) {
  const [i, c = "0"] = valor(txt).split(",");
  const r = +i, cent = +c.padEnd(2, "0").slice(0, 2), partes = [];
  if (r) partes.push(inteiro(r) + (/(milhão|milhões|bilhão|bilhões)$/.test(inteiro(r)) ? " de" : "") + (r === 1 ? " real" : " reais"));
  if (cent) partes.push(inteiro(cent) + (cent === 1 ? " centavo" : " centavos"));
  return partes.join(" e ") || "zero reais";
}

const ABREVIACOES = [
  [/\bmg\/L\b/g, "miligramas por litro"], [/\bg\/L\b/g, "gramas por litro"], [/\bm³\/s\b/g, "metros cúbicos por segundo"],
  [/\bL\/s\b/g, "litros por segundo"], [/\bkm²/g, "quilômetros quadrados"], [/\bm³/g, "metros cúbicos"], [/\bm²/g, "metros quadrados"],
  [/\bkm\b/g, "quilômetros"], [/\bkg\b/g, "quilos"], [/\bpH\b/g, "pê agá"], [/\b[Nn][º°o]\.?\s*(?=\d)/g, "número "],
  [/\bart\.\s*(?=\d)/g, "artigo "], [/\binc\.\s*/g, "inciso "], [/\bp\.\s*ex\./g, "por exemplo"], [/\bex\.:/g, "exemplo:"],
  [/\betc\./g, "etcétera."], [/§\s*/g, "parágrafo "],
];

export function normalizar(texto) {
  for (const [re, falado] of ABREVIACOES) texto = texto.replace(re, falado);
  texto = texto.replace(/\b([A-Z]{2,})\/([A-Z]{2,})\b/g, "$1 barra $2");
  texto = texto.replace(new RegExp(String.raw`\b(${NUM})\/((?:19|20)\d{2})\b`, "g"), "$1 de $2");
  texto = texto.replace(new RegExp(String.raw`R\$\s*(${NUM})`, "g"), (_, n) => reais(n));
  texto = texto.replace(new RegExp(String.raw`(${NUM})\s*%`, "g"), (_, n) => extenso(n) + " por cento");
  texto = texto.replace(/\b(\d+)\s*([ºª])/g, (_, n, g) => { const o = ordinal(+n); return g === "ª" ? o.replace(/o\b/g, "a") : o; });
  return texto.replace(new RegExp(String.raw`(${NUM})(\s+([\p{L}]+))?`, "gu"), (_, n, resto, seg) => extenso(n, seg || "") + (resto || ""));
}

// grafias conferidas (as mesmas de ../pronuncia.py); têm prioridade sobre as que a IA sugere
const BASE = {
  "circuit breaker": "sírcuit brêiquer", timeout: "táimaut", thread: "tréd", threads: "tréds", request: "riquést",
  requests: "riquésts", retry: "ritrái", cache: "quéxi", deploy: "diplói", queue: "quiú", worker: "uôrquer",
  endpoint: "éndpóint", token: "tôquen", tokens: "tôquens", spoofing: "spúfin", phishing: "fíxin", software: "sófituer",
  hardware: "rárduer", feedback: "fidbéc", feedbacks: "fidbécs", online: "onláine", offline: "ófeláine", "e-mail": "imêil",
  email: "imêil", site: "sáite", sites: "sáites", link: "línc", links: "líncs", download: "daunlôud", upload: "aplôud",
  marketing: "márquetin", app: "ép", apps: "éps", smartphone: "ismártifôun", notebook: "nôutbuc", design: "dizáin",
  designer: "dizáiner", startup: "estártap", "home office": "rôum ófis", compliance: "complaiâns", stakeholder: "estêiquirôlder",
  stakeholders: "estêiquirôlders", framework: "frêimuorc", mindset: "máindséti", insight: "insáiti", insights: "insáitis",
  benchmark: "bêntimarc", workshop: "uôrquixóp", checklist: "tchéquilist", "check-list": "tchéquilist", "know-how": "nôu ráu",
  layout: "lêiaut", backup: "bécap", login: "lóguin", logout: "logáut", password: "péssuord", cloud: "cláud",
  "big data": "bíg dêita", "machine learning": "maxíne lêrnin", "deep learning": "díp lêrnin", chatbot: "tchétibót",
  web: "uéb", website: "uébsáite", browser: "bráuser", firewall: "fáieruól", malware: "málguer", ransomware: "rânsomuér",
  "wi-fi": "uái fái", wifi: "uái fái", bluetooth: "blutúf", streaming: "istrímin", podcast: "pódiquést",
  performance: "perfórmanci", business: "bíznes", coaching: "cóutchin", networking: "nétuorquin", kpi: "cá pê í",
  roi: "érre ô í", ceo: "ci í ôu", rh: "érre agá", outsourcing: "autsórcin", lean: "líin", kaizen: "cáizen",
  "just in time": "djâst in táime", pipeline: "páiplaine", dashboard: "déchibórd", update: "apdêite", updates: "apdêites",
};
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const padrao = (mapa) => new RegExp(String.raw`(?<![\p{L}\d-])(` + Object.keys(mapa).sort((a, b) => b.length - a.length).map(esc).join("|") + String.raw`)(?![\p{L}\d-])`, "giu");
const BASE_RE = padrao(BASE);

export function pronuncia(texto, extra = {}) {
  texto = texto.replace(BASE_RE, (m) => BASE[m.toLowerCase()]);
  const mapa = Object.fromEntries(Object.entries(extra || {}).filter(([k, v]) => k && v && !(k.toLowerCase() in BASE)).map(([k, v]) => [k.toLowerCase(), v]));
  return Object.keys(mapa).length ? texto.replace(padrao(mapa), (m) => mapa[m.toLowerCase()]) : texto;
}

export const paraFala = (texto, extra) => normalizar(pronuncia(texto, extra));
