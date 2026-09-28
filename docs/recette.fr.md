# Recette manuelle de l'extension


À dérouler dans un espace de travail contenant plusieurs dépôts, sur l'un d'eux, avec une branche locale ayant au moins deux fichiers modifiés.

1. [ ] Tous les dépôts de l'espace de travail apparaissent dans « Local Merge Requests ».
2. [ ] Nouvelle review : défauts `origin/develop` / branche courante ; une ref invalide affiche une erreur.
3. [ ] La review liste les fichiers modifiés avec leur type ; clic → diff natif avec coloration.
4. [ ] Commenter une plage de 3 lignes à droite, gravité « bloquant » : le fil apparaît dans le diff et dans le panneau (💬 1).
5. [ ] Commenter à gauche en vue complète ; répondre ; modifier puis supprimer sa réponse.
6. [ ] Commentaire général depuis « Commentaires généraux ».
7. [ ] Dans un terminal : `lreview show` montre les fils avec leur position ; `lreview address <fil> "ok"` →
      la réponse de Claude et le statut « traité » apparaissent dans VS Code sans recharger.
8. [ ] Résoudre le fil : le compteur 💬 baisse ; rouvrir.
9. [ ] Modifier le fichier sans commiter, vue « en cours » : la modification est visible, le côté droit est éditable,
      on peut y commenter ; après commit, une nouvelle version apparaît (● nouvelle version) et le fil suit.
10. [ ] Modifier une ligne commentée puis commiter : le fil devient obsolète, sa page montre le code d'origine.
11. [ ] Vue « depuis v1 » : seuls les fichiers changés entre les deux versions sont listés.
12. [ ] Suggestion (` ```suggestion `) : bouton baguette → lignes remplacées, fil « traité », `git status` non stagé ;
       après modification des lignes, l'application est refusée avec un message.
13. [ ] Case « vu » cochée, puis le fichier change dans une nouvelle version : décochée.
14. [ ] « Ouvrir tous les fichiers » ouvre l'éditeur multi-diff.
15. [ ] Clore (disparaît), afficher les closes, rouvrir ; supprimer → confirmation, annuler conserve la review.
