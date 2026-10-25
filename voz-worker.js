// Voz Kokoro rodando no navegador, fora da página (a geração não trava a tela).
// O kokoro-js só fonetiza inglês; a fonética do português vem do espeak-ng em WASM, com as mesmas trocas
// que o pacote Python do Kokoro faz (misaki EspeakG2P) — conferido: fonemas idênticos.
import { KokoroTTS } from "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js";
import ESpeakNg from "https://cdn.jsdelivr.net/npm/espeak-ng@1.0.2/dist/espeak-ng.js";

const MODELO = "onnx-community/Kokoro-82M-v1.0-ONNX";
const TROCAS = [["a^ɪ", "I"], ["a^ʊ", "W"], ["d^z", "ʣ"], ["d^ʒ", "ʤ"], ["e^ɪ", "A"], ["o^ʊ", "O"], ["ə^ʊ", "Q"],
  ["s^s", "S"], ["t^s", "ʦ"], ["t^ʃ", "ʧ"], ["ɔ^ɪ", "Y"], ["^", ""], ["-", ""]];
let tts = null;

async function fonetizar(texto) {
  const e = await ESpeakNg({ arguments: ["--phonout", "saida", "-q", "--ipa", "--tie=^", "-v", "pt-br", texto] });
  // o espeak quebra linha em cada vírgula/ponto e some com a pontuação; ela volta aqui, na ordem do texto
  const linhas = e.FS.readFile("saida", { encoding: "utf8" }).split("\n").map((l) => l.trim()).filter(Boolean);
  const pont = texto.match(/[,.;:!?]+/g) || [];
  let ps = linhas.map((l, i) => l + (pont[i] ?? (i < linhas.length - 1 ? "," : ""))).join(" ");
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
  const partes = texto.split(/(?<=[,;:])\s+/);
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
