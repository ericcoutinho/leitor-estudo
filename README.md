# Leitor de Estudo

Anexe o material da prova (PDF, Word ou texto). A IA organiza em tópicos, resumo e perguntas de revisão, e uma voz em português lê para você, com a frase atual destacada.

**Abrir:** https://ericcoutinho.github.io/leitor-estudo/

- **Flash cards:** a IA cria cartões por tópico, e as perguntas de revisão também entram no baralho. Você vira o cartão, marca "Sabia" ou "Não sabia", e o que você erra volta logo, num sistema de caixas salvo no navegador. A voz pode ler a frente e o verso. Material aberto sem IA ganha o botão "Gerar flash cards com IA".
- **Voz:** Kokoro (pf_dora, pm_alex, pm_santa) rodando no próprio navegador. Usa WebGPU quando disponível e o processador nos outros casos. Na primeira vez baixa uns 300 MB, que ficam guardados.
- **IA:** Gemini, com a chave grátis de cada pessoa (https://aistudio.google.com/apikey). A chave fica salva só no navegador de quem usa. Sem chave, o material é lido como está.
- **Texto para a voz:** números por extenso ("2,4 milhões" → "dois vírgula quatro milhões"), abreviações ("mg/L", "nº") e termos em inglês aportuguesados só no áudio (`texto.js`).
- **Privacidade:** nada vai para servidor próprio. Os materiais ficam no navegador (localStorage). O texto só sai do aparelho para o Gemini, quando a organização com IA está ligada.

Arquivos: `index.html` (tela), `app.js` (leitura e organização), `voz-worker.js` (voz), `texto.js` (preparo do texto para a fala).
