# Raccord PV

Outil cartographique de pré-étude de raccordement d'un projet photovoltaïque en injection.

1. Cliquer sur la carte (ou chercher une adresse / des coordonnées) pour placer le site envisagé.
2. L'outil affiche les 3 à 5 postes sources les plus proches à vol d'oiseau avec, pour chacun, la **capacité d'accueil réservée au titre du S3REnR qui reste à affecter** (Capareseau, champ `INFO_NA`).
3. Il calcule le **trajet piéton** site → poste (IGN Géoplateforme, BD TOPO ; secours OSRM/OSM) et un lien Google Maps pour vérifier.
4. Il chiffre un **coût de raccordement indicatif** : quote-part S3REnR du poste + liaison HTA souterraine sur la longueur du trajet + une cellule départ au poste source et un poste de livraison par câble triphasé. Les ratios sont modifiables dans « Hypothèses de coût ».
   Valeurs par défaut : liaison HTA en 3×1×240 mm² Alu à 140 €/m ou 3×1×400 mm² Alu à 230 €/m selon le calcul de câble, cellule départ 90 k€ et poste de livraison 180 k€ par câble triphasé.
6. Il **dimensionne le câble HTA** : pour la tension de raccordement (20 kV par défaut, Capareseau ne la publie pas), la longueur de la liaison et la puissance par départ, il calcule la chute de tension ΔU/U = (R·P + X·Q)·L / U² et le courant, puis retient la section la moins chère qui reste sous 6 % de chute de tension et sous l'intensité admissible. Règles : 17 MW au plus par câble, au-delà la liaison est doublée (parts égales, câble supplémentaire à 110 €/m en 240 mm² ou 190 €/m en 400 mm², un câble de plus seulement si la chute de tension l'impose ; chaque câble a sa cellule départ et son poste de livraison) ; le 240 mm² est limité à 11,8 MW par câble. Câbles : valeurs typiques de catalogue (240 mm² : R 0,161 Ω/km à 90 °C, X 0,11 Ω/km, Iz 375 A ; 400 mm² : R 0,102 Ω/km, X 0,105 Ω/km, Iz 480 A), réglables dans « Câble HTA » (tension, chute max., tan φ, coefficient de pose sur Iz, seuil du 240 mm²) et « Hypothèses de coût » (prix des câbles et des câbles doublés, puissance max par câble).
5. Il positionne les **projets voisins en injection** (PV, éolien, stockage ≥ 1 MW) autour du site et du poste sélectionné, avec leur poste de raccordement envisagé quand il est publié (voir plus bas).

Le bouton « Copier le tableau » met les résultats dans le presse-papiers au format tableur.

## Rapport PDF

Renseigner le **nom du projet** (en haut du panneau ; il est gardé dans le lien), puis cliquer sur **Rapport PDF** dans la fiche d'un poste. Le PDF (A4, 2 pages en général) est généré dans le navigateur et téléchargé directement. Il contient :

- le nom du projet, la commune et les coordonnées du site ;
- un extrait de carte (fond affiché à l'écran : Plan IGN, photographies aériennes ou OSM) avec le site, les postes affichés, le trajet du poste étudié et les projets PV proches ;
- les caractéristiques du projet et les hypothèses de coût ;
- l'estimation du coût de raccordement du poste étudié (distances, quote-part, liaison HTA, cellules, poste de livraison) ;
- les informations Capareseau du poste (capacités, remplissage, file d'attente, quote-part, travaux, date de mise à jour, position corrigée ou non) ;
- le tableau récapitulatif des postes affichés et la liste des projets PV du rayon ;
- les sources, les limites et un lien vers l'analyse en ligne.

Les bibliothèques PDF (jsPDF, jsPDF-AutoTable) ne sont chargées qu'au premier rapport.

## Corriger la position d'un poste

Les coordonnées publiées par Capareseau sont approximatives. Les postes numérotés se déplacent à la souris (fond « Photographies aériennes » conseillé) ; la distance, le trajet piéton et le coût sont recalculés, et la liste est reclassée par distance. « Rétablir la position Capareseau » annule la correction.

Les positions corrigées sont conservées :

1. **Dans le navigateur**, automatiquement, tant qu'elles ne sont pas enregistrées.
2. **Dans le lien** : les corrections des postes affichés sont incluses dans l'URL (paramètre `mv`).
3. **Dans le dépôt**, pour tous les appareils et tous les utilisateurs : bouton **Enregistrer les positions** au-dessus de la liste des postes. La page écrit `data/postes-corrections.json` par l'API GitHub (même principe que carte-pv-bess). Ce fichier n'est pas touché par la mise à jour Capareseau.

Première utilisation : créer un jeton GitHub *fine-grained* (Settings → Developer settings → Fine-grained tokens) limité au dépôt `raccord-pv`, permission **Contents : Read and write**, le coller dans la fenêtre et choisir un mot de passe. Le jeton est chiffré avec ce mot de passe (AES-GCM, PBKDF2) dans `data/editor.json` ; ensuite seul le mot de passe est demandé. Pour changer de jeton (expiré, révoqué), supprimer `data/editor.json` du dépôt et recommencer.

Format du fichier : `{ "84:SSQUE": { "lat": 45.64308, "lon": 5.13182, "n": "ST-QUENTIN-FALLAVIER" } }` (clé = code région : code poste).

## Partager une analyse

L'adresse de la page enregistre le site et tous les réglages ; copier l'URL suffit pour retrouver la même analyse.

```
…/raccord-pv/#45.61000,5.15000&p=15&n=3&min=1&r=30&cap=1&rte=0&y=1&ml=140&ml2=180&seuil=10&dep=12&cell=90&pdl=180&k=1.3&mv=84:SSQUE:45.64308:5.13182
```

| Clé | Réglage | Clé | Réglage |
|---|---|---|---|
| `nom` | nom du projet | `kv`, `du`, `tphi`, `kiz`, `p240` | câble HTA : tension (kV), chute max (%), tan φ, coefficient Iz, seuil 240 mm² (MW) |
| `lat,lon` | position du site (facultative) | `ml` | prix du 3×240 mm² (€/m) |
| | | `ml2` | prix du 3×400 mm² (€/m) |
| `p` | puissance d'injection (MW) | `dep` | puissance max par départ HTA (MW) |
| `n` | postes affichés (3 à 5) | `cell` | cellule départ au poste source (k€) |
| `min` | capacité restante minimum (MW) | `pdl` | poste de livraison (k€) |
| `r` | rayon de recherche des projets (km) | `k` | coefficient de détour sans itinéraire |
| `cap` | uniquement postes avec capacité (1/0) | `rte` | inclure les postes RTE sans GRD (1/0) |
| `y` | projets de moins de 5 ans (1/0) | `mv` | positions corrigées des postes affichés |

Une valeur absente ou invalide reprend la valeur par défaut. Si le lien contient des hypothèses de coût différentes des valeurs par défaut, le bloc « Hypothèses de coût » s'ouvre à l'arrivée sur la page.

## Sources de données

| Donnée | Source | Mise à jour |
|---|---|---|
| Postes, capacités S3REnR, quote-part | [capareseau.fr](https://www.capareseau.fr/) — fichiers JSON régionaux | Instantané dans `data/postes.json`, rafraîchi le 3 de chaque mois par GitHub Actions |
| Projets soumis à évaluation environnementale | [projets-environnement.gouv.fr](https://www.projets-environnement.gouv.fr/) (API Opendatasoft) | Interrogé en direct |
| Itinéraire piéton | [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/itineraire) ; secours [OSRM / FOSSGIS](https://routing.openstreetmap.de/) | En direct |
| Géocodage, fonds Plan IGN, photos aériennes, cadastre | Géoplateforme IGN | En direct |
| États techniques et financiers (ETF) des S3REnR | [Pages régionales RTE](https://www.rte-france.com/projets/schemas-regionaux-s3renr) (et ETF Occitanie publiés par RTE) | `data/etf.json`, rafraîchi le 5 de chaque mois |
| Postes HTB privés (producteurs, clients industriels) | [OpenStreetMap](https://www.openstreetmap.org/) (requête Overpass) + `data/postes-prives-locaux.geojson` | `data/postes-prives.json`, rafraîchi le 5 de chaque mois |

Capareseau n'autorise pas la lecture de ses fichiers depuis un autre site (pas d'en-tête CORS) : la page lit donc l'instantané du dépôt. Pour forcer une mise à jour : onglet **Actions** → « Mise à jour Capareseau » → **Run workflow**.

Champs Capareseau conservés (voir `site/datas/AttributeConfig.json` sur capareseau.fr) :

- `INFO_NA` capacité réservée au titre du S3REnR qui reste à affecter
- `INFO_CR` capacité réservée aux EnR, `INFO_TX` taux de remplissage
- `INFO_FAS3R` / `INFO_ESS3R` puissance en file d'attente / en service dans le S3REnR en cours
- `INFO_QP` quote-part unitaire actualisée (k€/MW)
- `RTE_CDR`, `GRD1_CDR` capacité réservée disponible sans travaux vue de RTE / du GRD
- `RTE_TVX` travaux prévus au schéma

## ETF S3REnR du poste

Sous « Fiche Capareseau », chaque poste affiche un lien vers le **dernier état technique et financier** du S3REnR de sa région qui le cite, ouvert directement à la première page où il apparaît (les autres pages sont indiquées). `scripts/collect_refs.py etf` (workflow « ETF S3REnR et postes privés ») lit les pages régionales de RTE, télécharge les PDF des ETF (année la plus récente d'abord, Basse- et Haute-Normandie séparées) et y cherche le nom de chaque poste Capareseau de la région. Le lien figure aussi dans le rapport PDF.

## Postes sources privés

Les postes HTB privés (≥ 45 kV) absents de Capareseau sont affichés avec un marqueur carré distinct : **brun** pour les postes de producteurs (centrales, parcs éoliens ou solaires raccordés en HTB), **gris** pour les postes de clients industriels. Une liste des postes privés proches du site s'affiche sous les postes sources. Ils proviennent d'OpenStreetMap (`scripts/collect_refs.py prives`), hors postes RTE, Enedis et entreprises locales de distribution : ce recensement contributif n'est pas exhaustif et aucune capacité d'accueil n'est publiée pour ces postes.

Pour ajouter un poste privé connu (poste mutualisé d'un développeur, poste en projet…), compléter `data/postes-prives-locaux.geojson` :

```json
{ "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [2.35, 49.12] },
  "properties": { "nom": "Poste privé de …", "type": "producteur", "exploitant": "…", "tension_kv": "63",
                  "mise_en_service": "2027", "commentaire": "poste mutualisé, 3 parcs éoliens", "source": "https://…" } }
```

`type` : `producteur` ou `industriel`.

## Projets voisins (PV, éolien, stockage de 1 MW et plus)

La page affiche les projets en injection situés dans le rayon choisi **autour du site et autour du poste sélectionné** (les deux cercles sont fusionnés). Sont retenus les projets photovoltaïques, éoliens et de stockage d'au moins 1 MW, ainsi que ceux dont la puissance n'est pas communiquée (case à cocher).

Pour chaque projet, la page indique le **poste de raccordement envisagé** quand les documents publiés le citent. Les projets qui citent le poste sélectionné sont mis en évidence (marqueur cerclé, éclair, trait vers le poste) ; leurs caractéristiques s'affichent au survol. Le bilan compare leur puissance cumulée à la capacité réservée restante du poste.

### Collecte hebdomadaire (GitHub Actions)

`scripts/collect_projets.py`, lancé chaque lundi (onglet **Actions** → « Collecte des projets voisins » → **Run workflow** pour une collecte immédiate), écrit `data/projets.json` à partir de :

| Source | Contenu | Position |
|---|---|---|
| [projets-environnement.gouv.fr](https://www.projets-environnement.gouv.fr/) | dossiers d'étude d'impact | précise |
| [Plateforme de l'évaluation environnementale](https://evaluation-environnementale.ecologie.gouv.fr/) (NOVAE) | avis MRAe et décisions au cas par cas depuis 2025 | centre de la commune |
| [Sites des MRAe](https://www.mrae.developpement-durable.gouv.fr/) | avis rendus sur projets 2022 à 2025 | centre de la commune |
| Sites des préfectures (`www.<département>.gouv.fr`) | participations du public par voie électronique (PPVE), enquêtes publiques | centre de la commune |

Pour chaque projet, l'avis de l'autorité environnementale, le résumé non technique ou l'avis d'enquête (25 Mo au plus) est lu pour en tirer la puissance et les postes sources cités. Un poste n'est retenu que s'il figure dans Capareseau à moins de 55 km du projet ; plusieurs postes cités = options de raccordement. Les doublons entre sources sont fusionnés. Un clic sur un projet ouvre la **liste de tous les documents trouvés**, classés par source avec leur taille : pièces du dossier projets-environnement (avis AE, réponse du maître d'ouvrage, étude d'impact, résumé non technique, plans, décision…), pièces publiées sur NOVAE, avis MRAe, documents téléchargeables de la page de la préfecture. `data/projets-cache.json` garde les documents déjà lus : chaque passage ne lit que les nouveaux.

### Projets non publiés (CDPENAF, permis de construire…)

- **Ponctuellement** : bouton « Importer GeoJSON / CSV » (CSV avec colonnes `lat`, `lon`, et si possible `nom`, `type`, `puissance_mw`, `procedure`, `statut`, `date`, `poste_raccordement`, `source`). L'import reste dans le navigateur.
- **Durablement** : compléter `data/projets-locaux.geojson` dans le dépôt. Exemple :

```json
{ "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [5.15, 45.61] },
  "properties": { "nom": "Centrale PV de …", "type": "pv", "puissance_mw": 8.5, "procedure": "Avis CDPENAF",
                  "statut": "Avis favorable", "date": "2026-09-12", "poste_raccordement": "ST-QUENTIN-FALLAVIER",
                  "source": "https://…" } }
```

## Limites

- Les capacités changent en continu ; seule une demande de raccordement (proposition technique et financière) engage le gestionnaire de réseau.
- Le trajet piéton approxime le tracé d'une liaison souterraine sous voirie ; il ne tient pas compte des traversées (voies ferrées, autoroutes, cours d'eau) ni des contraintes de pose.
- Au-delà de la puissance par départ HTA retenue (12 MW par défaut), l'outil compte plusieurs départs ; au-delà de 17 MW un raccordement HTB doit être étudié.
- Corse et outre-mer ne sont pas couverts par Capareseau / les S3REnR.
- Projets voisins : le poste de raccordement n'est connu que s'il est écrit dans les documents lus ; les projets connus par un avis MRAe ou une publication préfectorale sont placés au centre de la commune ; la puissance est lue dans le titre ou les documents et peut manquer.

## Développement

Site statique (HTML/CSS/JS + Leaflet), aucune compilation. Pour tester en local : `python3 -m http.server` puis http://localhost:8000.
Mise à jour manuelle des données : `python3 scripts/update_capareseau.py`.
