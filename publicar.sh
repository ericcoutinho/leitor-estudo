#!/bin/bash
# Publica o saber.ia: VPS (https://saberia.regra32.tec.br/$CAMINHO/) e GitHub Pages. Antes, troca o ?v= de app.js, texto.js e
# voz-worker.js pela hora atual: o navegador guarda os .js em cache, e sem isso abre a página nova com o código antigo.
#
# CAMINHO: onde o saber.ia mora em saberia.regra32.tec.br (desde nov/2026 a raiz é a entrada da Saberia). Trocar o nome:
#   1. aqui (carimba o app.js: link de migração do endereço antigo);
#   2. em /opt/stack/sites/saberia/.env na VPS (ESTUDO=...; o Traefik manda /$ESTUDO/ para o nginx e tira o prefixo)
#      e `docker compose up -d` lá;
#   3. no espaço "externo" do banco (tela Espaços da plataforma ou: update espacos.espacos set url='/novo/' where tipo='externo').
# Os arquivos continuam na raiz de html/: o prefixo é tirado pelo Traefik, então nada muda na pasta.
CAMINHO=estudo
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i -E "s#^const CAMINHO = \"/[a-z0-9-]+/\";#const CAMINHO = \"/$CAMINHO/\";#" app.js
sed -i -E "s#(app\.js|texto\.js|voz-worker\.js)\?v=[0-9]+#\1?v=$V#g" index.html app.js
git add -A && git commit -q -m "${1:-Atualização}" && git push -q origin main
# VPS: só os arquivos do repositório (sem .git nem este script). Esvazia e preenche a própria html/, porque ela é
# montada no container (trocar a pasta por outra deixaria o nginx servindo a antiga)
git ls-files | grep -v '^publicar\.sh$' | tar -cf - -T - | ssh vps 'set -e; cd /opt/stack/sites/saberia; find html -mindepth 1 -delete; tar -xf - -C html'
echo "VPS publicada (https://saberia.regra32.tec.br/$CAMINHO/)"
until s=$(gh api repos/ericcoutinho/leitor-estudo/pages/builds/latest --jq '.status+" "+.commit' 2>/dev/null); echo "$s" | grep -q "^built $(git rev-parse HEAD)"; do sleep 3; done
echo "publicado (versão $V)"
