#!/bin/bash
# Guarda el trabajo del robot en UN solo guardado, sin chocar con lo que publiques desde el Catálogo mientras corre.
git config user.name "robot-tallas"
git config user.email "dealersportsmx-source@users.noreply.github.com"
git add -u
git diff --cached --quiet && exit 0
git commit -q -m "Robot: actualización"
if ! git pull -q --rebase; then
  # publicaste mientras corría: gana tu publicación (las tallas se revisan en la siguiente corrida) y se guarda lo demás
  git rebase --abort
  git reset -q --soft HEAD~1
  for f in datos.json borrador/datos.json; do
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then git restore -q --staged "$f"; git checkout -q -- "$f"; fi
  done
  echo "Publicaste mientras corría: las tallas se revisan en la siguiente corrida"
  if ! git diff --cached --quiet; then git commit -q -m "Robot: actualización"; fi
  git pull -q --rebase || { git rebase --abort 2>/dev/null; git reset -q --hard origin/main; echo "No se pudo guardar: se reintenta en la siguiente corrida"; exit 1; }
fi
git push -q || { echo "No se pudo guardar: se reintenta en la siguiente corrida"; exit 1; }
