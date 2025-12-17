# Utilisation de l'image officielle Node.js version Alpine (légère et sécurisée)
# La version 20 correspond aux exigences de tes dépendances
FROM node:20-alpine

# Création du dossier de travail dans le conteneur
WORKDIR /app

# Copie uniquement les fichiers de dépendances pour profiter du cache Docker
COPY package.json package-lock.json ./

# Installation propre des dépendances de production uniquement (sans devDependencies)
# Cela réduit la taille de l'image
RUN npm ci --omit=dev

# Copie du code source (server.js et autres fichiers si nécessaires)
COPY server.js ./

# Pour des raisons de sécurité, on n'utilise pas l'utilisateur root
USER node

# Documentation des ports utilisés (HTTP: 3200, WS: 8000 selon ton server.js)
EXPOSE 3200

# Commande de démarrage
CMD ["node", "server.js"]