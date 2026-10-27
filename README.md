# Raccord PV

Outil cartographique de pré-étude de raccordement d'un projet photovoltaïque en injection.

1. Cliquer sur la carte (ou chercher une adresse / des coordonnées) pour placer le site envisagé.
2. L'outil affiche les 3 à 5 postes sources les plus proches à vol d'oiseau avec, pour chacun, la **capacité d'accueil réservée au titre du S3REnR qui reste à affecter** (Capareseau, champ `INFO_NA`).
3. Il calcule le **trajet piéton** site → poste (IGN Géoplateforme, BD TOPO ; secours OSRM/OSM) et un lien Google Maps pour vérifier.
4. Il chiffre un **coût de raccordement indicatif** : quote-part S3REnR du poste + liaison HTA souterraine sur la longueur du trajet + cellule(s) départ au poste source (+ poste de livraison). Les ratios sont modifiables dans « Hypothèses de coût ».
5. Il positionne les **projets PV publiés** sur projets-environnement.gouv.fr (études d'impact, avis de l'autorité environnementale, enquêtes et consultations, permis de construire) dans un rayon réglable, ainsi que les projets saisis à la main.

Le bouton « Copier le tableau » met les résultats dans le presse-papiers au format tableur.

## Partager une analyse

L'adresse de la page enregistre le site et tous les réglages ; copier l'URL suffit pour retrouver la même analyse.

```
…/raccord-pv/#45.61000,5.15000&p=15&n=3&min=1&r=30&cap=1&rte=0&y=1&ml=200&dep=12&cell=150&pdl=90&k=1.3
```

| Clé | Réglage | Clé | Réglage |
|---|---|---|---|
| `lat,lon` | position du site (facultative) | `ml` | liaison HTA souterraine (€/m) |
| `p` | puissance d'injection (MW) | `dep` | puissance max par départ HTA (MW) |
| `n` | postes affichés (3 à 5) | `cell` | cellule départ au poste source (k€) |
| `min` | capacité restante minimum (MW) | `pdl` | poste de livraison (k€) |
| `r` | rayon de recherche des projets (km) | `k` | coefficient de détour sans itinéraire |
| `cap` | uniquement postes avec capacité (1/0) | `rte` | inclure les postes RTE sans GRD (1/0) |
| `y` | projets de moins de 5 ans (1/0) | | |

Une valeur absente ou invalide reprend la valeur par défaut. Si le lien contient des hypothèses de coût différentes des valeurs par défaut, le bloc « Hypothèses de coût » s'ouvre à l'arrivée sur la page.

## Sources de données

| Donnée | Source | Mise à jour |
|---|---|---|
| Postes, capacités S3REnR, quote-part | [capareseau.fr](https://www.capareseau.fr/) — fichiers JSON régionaux | Instantané dans `data/postes.json`, rafraîchi le 3 de chaque mois par GitHub Actions |
| Projets soumis à évaluation environnementale | [projets-environnement.gouv.fr](https://www.projets-environnement.gouv.fr/) (API Opendatasoft) | Interrogé en direct |
| Itinéraire piéton | [Géoplateforme IGN](https://geoservices.ign.fr/documentation/services/services-geoplateforme/itineraire) ; secours [OSRM / FOSSGIS](https://routing.openstreetmap.de/) | En direct |
| Géocodage, fonds Plan IGN, photos aériennes, cadastre | Géoplateforme IGN | En direct |

Capareseau n'autorise pas la lecture de ses fichiers depuis un autre site (pas d'en-tête CORS) : la page lit donc l'instantané du dépôt. Pour forcer une mise à jour : onglet **Actions** → « Mise à jour Capareseau » → **Run workflow**.

Champs Capareseau conservés (voir `site/datas/AttributeConfig.json` sur capareseau.fr) :

- `INFO_NA` capacité réservée au titre du S3REnR qui reste à affecter
- `INFO_CR` capacité réservée aux EnR, `INFO_TX` taux de remplissage
- `INFO_FAS3R` / `INFO_ESS3R` puissance en file d'attente / en service dans le S3REnR en cours
- `INFO_QP` quote-part unitaire actualisée (k€/MW)
- `RTE_CDR`, `GRD1_CDR` capacité réservée disponible sans travaux vue de RTE / du GRD
- `RTE_TVX` travaux prévus au schéma

## Projets non publiés sur projets-environnement (CDPENAF, PC sans étude d'impact…)

Il n'existe pas de base nationale des avis CDPENAF ni des permis de construire en cours. Deux façons de les ajouter :

- **Ponctuellement** : bouton « Importer GeoJSON / CSV » (CSV avec colonnes `lat`, `lon`, et si possible `nom`, `procedure`, `statut`, `date`, `puissance_mwc`, `source`). L'import reste dans le navigateur.
- **Durablement** : compléter `data/projets-locaux.geojson` dans le dépôt (mêmes propriétés). Exemple d'objet :

```json
{ "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [5.15, 45.61] },
  "properties": { "nom": "Centrale PV de …", "procedure": "Avis CDPENAF", "statut": "Avis favorable",
                  "date": "2026-09-12", "puissance_mwc": 8.5, "source": "https://…" } }
```

## Limites

- Les capacités changent en continu ; seule une demande de raccordement (proposition technique et financière) engage le gestionnaire de réseau.
- Le trajet piéton approxime le tracé d'une liaison souterraine sous voirie ; il ne tient pas compte des traversées (voies ferrées, autoroutes, cours d'eau) ni des contraintes de pose.
- Au-delà de la puissance par départ HTA retenue (12 MW par défaut), l'outil compte plusieurs départs ; au-delà de 17 MW un raccordement HTB doit être étudié.
- Corse et outre-mer ne sont pas couverts par Capareseau / les S3REnR.

## Développement

Site statique (HTML/CSS/JS + Leaflet), aucune compilation. Pour tester en local : `python3 -m http.server` puis http://localhost:8000.
Mise à jour manuelle des données : `python3 scripts/update_capareseau.py`.
