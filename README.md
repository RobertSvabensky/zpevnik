
# Zpěvník na GitHub Pages

- Čistý statický web (Pages), bez serveru.
- Písně (Guitar Pro) vkládáš tak, že je nahraješ do složky `/songs`.
- GitHub Action po každém commitu přegeneruje `data/songs.json`.
- `index.html` = seznam + hledání + řazení (číslo / název / autor).
- `song.html` = zobrazení + přehrávání (alphaTab).

## Jak zprovoznit
1) **Vytvoř repo** na GitHubu (např. `zpevnik`).  
2) **Nahraj soubory** z této složky do repa (přes *Add file → Upload files* nebo Git).  
3) V *Settings → Pages* zapni GitHub Pages: *Deploy from branch → main → /(root)*.  
4) Vlož první skladbu do `/songs` (třeba `001-wonderwall-oasis.gpx`).  
5) Po doběhnutí GitHub Action otevři `https://<user>.github.io/<repo>/`.

### Pojmenování souborů
`NNN-nazev-pisne-autor.gpx`  
- `NNN` = číslo pro pořadí (volitelné).  
- `nazev-pisne` a `autor` slouží k zobrazení a vyhledávání.

### Poznámky
- Podporované formáty: `.gp, .gp3, .gp4, .gp5, .gpx`.
- Lze rozšířit o YAML s metadaty, nebo Issues → Action → PR (pohodlné vkládání).

