// Voz Kokoro rodando no navegador, fora da página (a geração não trava a tela).
// O kokoro-js só fonetiza inglês; a fonética do português vem do espeak-ng em WASM, com as mesmas trocas
// que o pacote Python do Kokoro faz (misaki EspeakG2P) — conferido: fonemas idênticos.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import ESpeakNg from "https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.js";

const MODELO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const TROCAS = [["a^ɪ", "I"], ["a^ʊ", "W"], ["d^z", "ʣ"], ["d^ʒ", "ʤ"], ["e^ɪ", "A"], ["o^ʊ", "O"], ["ə^ʊ", "Q"],
  ["s^s", "S"], ["t^s", "ʦ"], ["t^ʃ", "ʧ"], ["ɔ^ɪ", "Y"], ["^", ""], ["-", ""]];
let tts = null;

// Termos em inglês chegam marcados ⟦assim⟧ (texto.js): ganham a fonética do INGLÊS (espeak en-us) e a mesma voz
// os fala como um brasileiro que sabe inglês. Grafia aportuguesada ("sófituer") soava errada — o usuário reprovou.
// Trocas do misaki EspeakFallback (inglês americano), na mesma ordem do pacote Python.
const TROCAS_EN = [["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"], ["a^ɪ", "I"], ["a^ʊ", "W"], ["d^ʒ", "ʤ"], ["e^ɪ", "A"], ["t^ʃ", "ʧ"],
  ["ɔ^ɪ", "Y"], ["ə^l", "ᵊl"], ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""], ["ɚ", "əɹ"], ["e", "A"], ["r", "ɹ"], ["x", "k"], ["ç", "k"],
  ["ɐ", "ə"], ["ɬ", "l"], ["̃", ""]];
function trocasIngles(ps) {
  for (const [a, b] of TROCAS_EN) ps = ps.split(a).join(b);
  ps = ps.replace(/(\S)̩/g, "ᵊ$1").replace(/̩/g, "");
  ps = ps.split("o^ʊ").join("O").split("ɜːɹ").join("ɜɹ").split("ɜː").join("ɜɹ").split("ɪə").join("iə").split("ː").join("");
  return ps.split("o").join("ɔ").split("ɾ").join("T").split("ʔ").join("t").split("^").join("");
}
// palavrinha logo antes de um termo em inglês sairia tônica ("usa o | Spoon" → "usa ó"): vai átona, como na fala
const ATONAS = { o: "ʊ", os: "ʊs", a: "a", as: "as", e: "i", de: "ʤi", do: "dʊ", da: "da", dos: "dʊs", das: "das",
  no: "nʊ", na: "na", nos: "nʊs", nas: "nas", em: "ẽj", um: "ũ", uma: "ˈumæ", ou: "ow", com: "kõ", para: "pˌaɾæ", pelo: "pelʊ", pela: "pelæ" };

async function espeak(texto, voz) {
  const e = await ESpeakNg({ arguments: ["--phonout", "saida", "-q", "--ipa", "--tie=^", "-v", voz, texto] });
  return e.FS.readFile("saida", { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
}
// o espeak quebra linha em cada vírgula/ponto e some com a pontuação; ela volta aqui, na ordem do texto
const comPontuacao = (linhas, texto) => {
  const antes = texto.match(/^\s*([,.;:!?]+)/)?.[1] ?? ""; // ", segundo" → a vírgula fica na frente
  const pont = texto.slice(texto.indexOf(antes) + antes.length).match(/[,.;:!?]+/g) || [];
  return (antes ? antes + " " : "") + linhas.map((l, i) => l + (pont[i] ?? (i < linhas.length - 1 ? "," : ""))).join(" ");
};
// vários trechos do mesmo idioma numa chamada só (cada chamada custa ~80 ms): entre eles vai uma palavra-marca
// isolada por pontos, e a saída é cortada nas linhas dela
const MARCA = "kapok", marcas = {};
async function lote(textos, voz) {
  if (!textos.length) return [];
  if (textos.length === 1) return [comPontuacao(await espeak(textos[0], voz), textos[0])];
  marcas[voz] ??= (await espeak(MARCA, voz)).join(" ");
  const grupos = [[]];
  for (const l of await espeak(textos.join(` . ${MARCA} . `), voz)) l === marcas[voz] ? grupos.push([]) : grupos.at(-1).push(l);
  if (grupos.length !== textos.length) return Promise.all(textos.map(async (t) => comPontuacao(await espeak(t, voz), t))); // garantia
  return grupos.map((g, i) => comPontuacao(g, textos[i]));
}

async function fonetizar(texto) {
  const partes = texto.split(/⟦|⟧/); // pares = português, ímpares = inglês
  const pt = [], fim = [];
  partes.forEach((t, i) => {
    if (i % 2) return;
    const pedacos = t.match(/[\p{L}\d]+|[^\p{L}\d\s]+/gu) || [], atonas = [];
    if (i < partes.length - 1) while (pedacos.length && ATONAS[pedacos.at(-1).toLowerCase()]) atonas.unshift(ATONAS[pedacos.pop().toLowerCase()]);
    pt.push(atonas.length ? pedacos.join(" ") : t);
    fim.push(atonas.join(" "));
  });
  const temPalavra = (t) => /[\p{L}\d]/u.test(t);
  const ptFon = await lote(pt.filter(temPalavra), "pt-br");
  const enFon = await lote(partes.filter((_, i) => i % 2), "en-us");
  let p = 0, e = 0;
  let ps = partes.map((t, i) => {
    if (i % 2) return trocasIngles(enFon[e++]);
    const base = temPalavra(pt[i / 2]) ? ptFon[p++] : pt[i / 2].trim();
    return [base, fim[i / 2]].filter(Boolean).join(" ");
  }).filter(Boolean).join(" ");
  for (const [a, b] of TROCAS) ps = ps.split(a).join(b);
  return ps;
}

async function carregar() {
  let device = "wasm";
  try { if (navigator.gpu && (await navigator.gpu.requestAdapter())) device = "webgpu"; } catch {}
  const arquivos = {}; // soma o download de todos os arquivos do modelo (o maior é o .onnx)
  tts = await KokoroTTS.from_pretrained(MODELO, {
    dtype: device === "webgpu" ? "fp32" : "q8",
    device,
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      arquivos[p.file] = [p.loaded, p.total];
      const [carregado, total] = Object.values(arquivos).reduce((s, [l, t]) => [s[0] + l, s[1] + t], [0, 0]);
      postMessage({ tipo: "progresso", carregado, total });
    },
  });
  postMessage({ tipo: "fase", texto: "Preparando a voz no seu aparelho…" });
  await gerar("Pronto.", "pf_dora", 1); // aquecimento: a 1ª geração compila tudo
  postMessage({ tipo: "pronto", device });
}

async function gerar(texto, voz, vel) {
  const ps = await fonetizar(texto);
  const { input_ids } = tts.tokenizer(ps, { truncation: true });
  const r = await tts.generate_from_ids(input_ids, { voice: voz, speed: vel });
  return { amostras: r.audio, taxa: r.sampling_rate };
}

// frase longa demais para o modelo (limite ~500 fonemas) é dividida nas vírgulas
function dividir(texto) {
  if (texto.length < 300) return [texto];
  const partes = texto.split(/(?<=[,;:])\s+(?![^⟦]*⟧)/); // nunca no meio de um termo em inglês
  const saida = [];
  for (const p of partes) {
    if (saida.length && (saida.at(-1) + " " + p).length < 300) saida[saida.length - 1] += " " + p;
    else saida.push(p);
  }
  return saida;
}

function wav(amostras, taxa) {
  const buf = new ArrayBuffer(44 + amostras.length * 2), v = new DataView(buf);
  const txt = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  txt(0, "RIFF"); v.setUint32(4, 36 + amostras.length * 2, true); txt(8, "WAVE"); txt(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, taxa, true);
  v.setUint32(28, taxa * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); txt(36, "data");
  v.setUint32(40, amostras.length * 2, true);
  amostras.forEach((s, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return buf;
}

async function falar({ id, texto, voz, vel }) {
  const pedacos = [];
  let taxa = 24000;
  for (const parte of dividir(texto)) {
    const g = await gerar(parte, voz, vel);
    pedacos.push(g.amostras); taxa = g.taxa;
  }
  const total = new Float32Array(pedacos.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of pedacos) { total.set(p, o); o += p.length; }
  const buf = wav(total, taxa);
  postMessage({ tipo: "audio", id, buf }, [buf]);
}

let fila = Promise.resolve();
onmessage = ({ data }) => {
  if (data.tipo === "carregar") carregar().catch((e) => postMessage({ tipo: "erro", msg: e.message }));
  if (data.tipo === "falar") fila = fila.then(() => falar(data)).catch((e) => postMessage({ tipo: "erro", id: data.id, msg: e.message }));
};
