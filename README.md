# sae-s5-but3-iot-g2-api
# SAE S5 — BUT3 — API Backend (Node.js + Azure SQL)

Cette API a été développée dans le cadre de la SAE S5 BUT3 IOT - Groupe 2.  
Elle sert d’interface sécurisée entre une base de données **Azure SQL Database** et une application web/mobile (ex : React).

L’objectif est de fournir des **endpoints REST** permettant de lire et manipuler les données de la base, tout en assurant :

- Sécurité (Helmet, CORS, Azure App Service)
- Connexion fiable à Azure SQL (pool global MSSQL)
- Support pour déploiement cloud (Azure App Service)
- Architecture simple et extensible

## Fonctionnalités principales

- API REST en Node.js / Express
- Connexion sécurisée à Azure SQL Database
- Gestion d’un pool de connexions pour optimiser les performances
- Sécurisation via :
    - helmet
    - cors
    - variables d’environnement uniquement
- Routes simples et propres
- Endpoint de santé (`/health`) pour les probes Azure

## Installation & Développement local

### 1. Cloner le projet
```bash
git clone https://github.com/…/sae-s5-but3-iot-g2-api.git
cd sae-s5-but3-iot-g2-api
```
2. Installer les dépendances
```bash
npm install
```
3. Configurer l'environnement

Créer un fichier .env :
```
DB_USER=xxxx
DB_PASSWORD=xxxx
DB_SERVER=xxxx.database.windows.net
DB_NAME=xxxx
```
Important : Ne jamais mettre ces informations dans le dépôt.
En production, elles doivent être configurées dans Azure App Service → Configuration.
4. Lancer l’API en local
```bash
npm start
```
L’API sera accessible sur :
http://localhost:3000/
Architecture du projet
```
sae-s5-but3-iot-g2-api
│
├── index.js           # Point d'entrée de l'API
├── package.json       # Dépendances + scripts
├── .env (local only)  # Variables d'environnement
└── ...
```
Connexion à Azure SQL

La connexion utilise un pool global :

const pool = await sql.connect(dbConfig);

Cette approche :

    évite de recréer une connexion à chaque requête

    améliore les performances

    est recommandée par Microsoft

Routes disponibles
/health

Vérifie que l’API est opérationnelle.
Usage : probes de démarrage et monitoring Azure.
/api/test

Exemple de route qui interroge la base de données :
```
SELECT * FROM TestItems;
```
Ajouter vos propres routes

Un espace est prévu dans le code pour ajouter les routes :
```
// --- PLACEHOLDER FOR OTHER ROUTES ---

app.get("/api/... ", async (req, res) => {
    ...
});
```
Ici, vous pouvez documenter vos futures routes (GET, POST, PUT, DELETE).
Déploiement sur Azure App Service

    Pousser le code sur GitHub

    Créer un Azure App Service – Node.js

    Configurer les variables d’environnement dans Configuration → Application settings

    Déployer via GitHub Actions ou Zip Deploy

    Vérifier /health pour confirmer le bon fonctionnement

Technologies utilisées

    Node.js

    Express

    mssql (pilotage Azure SQL)

    dotenv

    helmet

    cors

    Azure App Service

    Azure SQL Database

Licence

Projet académique — utilisation interne dans le cadre du BUT Informatique.