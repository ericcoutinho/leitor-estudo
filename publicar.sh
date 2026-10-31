#!/bin/bash
# Publica o saber.ia: VPS (https://saberia.regra32.tec.br) e GitHub Pages. Antes, troca o ?v= de app.js, texto.js e
# voz-worker.js pela hora atual: o navegador guarda os .js em cache, e sem isso abre a página nova com o código antigo.
cd "$(dirname "$0")"
V=$(date +%Y%m%d%H%M%S)
sed -i -E "s#(app\.js|texto\.js|voz-worker\.js)\?v=[0-9]+#\1?v=$V#g" index.html app.js
git add -A && git commit -q -m "${1:-Atualização}" && git push -q origin main
# VPS: só os arquivos do repositório (sem .git nem este script). Esvazia e preenche a própria html/, porque ela é
# montada no container (trocar a pasta por outra deixaria o nginx servindo a antiga)
git ls-files | grep -v '^publicar\.sh$' | tar -cf - -T - | ssh vps 'set -e; cd /opt/stack/sites/saberia; find html -mindepth 1 -delete; tar -xf - -C html'
echo "VPS publicada"
until s=$(gh api repos/ericcoutinho/leitor-estudo/pages/builds/latest --jq '.status+" "+.commit' 2>/dev/null); echo "$s" | grep -q "^built $(git rev-parse HEAD)"; do sleep 3; done
echo "publicado (versão $V)"
