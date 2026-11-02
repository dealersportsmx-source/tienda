#!/bin/bash
# Guarda el trabajo del robot sin chocar con lo que publiques desde el Catálogo mientras corre.
git config user.name "robot-tallas"
git config user.email "dealersportsmx-source@users.noreply.github.com"
# 1) Tallas aparte: si publicaste mientras corría, gana tu publicación
tallas=$(git diff --name-only -- datos.json borrador/datos.json)
if [ -n "$tallas" ]; then git stash push -q -- $tallas; fi
# 2) Cuadritos, fotos y prendas que ya no existen: se guardan primero, para no perderlos
if ! git diff --quiet; then
  git add -u
  git commit -q -m "Robot: cuadritos y fotos"
fi
git pull -q --rebase || exit 1
git push -q || exit 1
# 3) Tallas: se guardan solo si nadie publicó mientras tanto; si no, se revisan en la siguiente corrida
if [ -n "$tallas" ]; then
  if git stash pop -q 2>/dev/null; then
    git add $tallas
    git commit -q -m "Robot: tallas actualizadas"
    git push -q || { git reset -q --hard origin/main; echo "Tallas para la siguiente corrida"; }
  else
    git checkout -q HEAD -- $tallas
    git stash drop -q
    echo "Publicaste mientras corría: las tallas se revisan en la siguiente corrida"
  fi
fi
