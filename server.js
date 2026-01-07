// server.js
import express from "express";
import client from "prom-client";
import dotenv from "dotenv";
import helmet from "helmet";
import cors from "cors";
import mqtt from "mqtt";
import { WebSocketServer } from "ws";
import crypto from "crypto";

dotenv.config();

/*
.env attendu (exemple)
API_KEY=supercleAPI
MQTT_URL=mqtt://mosquitto:1883
PORT=3200
API_BASE_URL=https://apidatabasesae-...
RETRY_INTERVAL_MS=10000
# Nouveaux champs pour le Gist :
GIST_ID=aaaaaaaaaaaaaaaaa
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxx
*/

// Configuration
const API_KEY = process.env.API_KEY || "";
const MQTT_URL = process.env.MQTT_URL || "mqtt:///172.19.136.3:1883:";
const PORT = parseInt(process.env.PORT || "3200", 10);
const API_BASE = process.env.API_BASE_URL || "";
const RETRY_INTERVAL_MS = parseInt(
  process.env.RETRY_INTERVAL_MS || "10000",
  10
);

// --- CONFIGURATION GIST ---
const GIST_ID = process.env.GIST_ID || "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
// "ngrok" est le nom du service dans docker-compose
const NGROK_API_URL = "http://ngrok:4040/api/tunnels";

// ======================
// PROMETHEUS SETUP
// ======================
// Collecte les métriques par défaut (CPU, RAM, Event Loop)
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// (Optionnel) Histogramme pour mesurer la durée des requêtes HTTP
const httpRequestDurationMicroseconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "code"],
  buckets: [0.1, 0.5, 1, 1.5],
});

// ======================
// Express + middleware
// ======================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on("finish", () => {
    // On évite d'enregistrer les appels vers /metrics pour ne pas polluer
    if (req.path === "/metrics") return;

    end({
      method: req.method,
      route: req.route ? req.route.path : req.path,
      code: res.statusCode,
    });
  });
  next();
});

// simple API key middleware for protected REST endpoints
function apiKeyMiddleware(req, res, next) {
  const key = req.headers["api_key"];
  if (!API_KEY) {
    return next();
  }
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }
  next();
}

// ======================
// In-memory cache for patients
// ======================
let patientsCache = null;
let patientsCacheTs = 0;
const PATIENTS_CACHE_TTL_MS = 30_000;

async function fetchAllPatients() {
  const now = Date.now();
  if (patientsCache && now - patientsCacheTs < PATIENTS_CACHE_TTL_MS) {
    return patientsCache;
  }
  if (!API_BASE) {
    console.warn("API_BASE_URL not set. fetchAllPatients will return []");
    return [];
  }
  const url = `${API_BASE}/patients`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    patientsCache = data;
    patientsCacheTs = Date.now();
    return data;
  } catch (err) {
    console.error("Error fetching patients:", err);
    return [];
  }
}

async function getAideForPatient(patientId) {
  try {
    const patients = await fetchAllPatients();
    if (!Array.isArray(patients)) return null;
    const p = patients.find((x) => String(x.id_patient) === String(patientId));
    if (!p) return null;
    return p.fk_aide_soignant || null;
  } catch (err) {
    console.error("getAideForPatient error:", err);
    return null;
  }
}

// ======================
// Start HTTP server
// ======================

export function stopRetryTimer() {
  if (retryTimer) clearInterval(retryTimer);
}

export const server = app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
  // Lance la mise à jour du Gist après le démarrage
  if (process.env.NODE_ENV !== "test") {
    updateGistWithNgrok();
  }
});

// ======================
// WebSocket server + ACK management
// ======================

const wsClients = new Map();
const pendingAlerts = new Map();

export const wss = new WebSocketServer({ server });
console.log(`WebSocket server attached to HTTP server on port ${PORT}`);

function wsSendSafe(ws, obj) {
  try {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (err) {
    console.warn("wsSendSafe error:", err);
  }
}

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const token = url.searchParams.get("token");
  const aideId = url.searchParams.get("id");
  const password = url.searchParams.get("pwd");

  if (!aideId) {
    wsSendSafe(ws, { error: "Missing 'id' query param" });
    ws.close();
    return;
  }
  if (!password) {
    wsSendSafe(ws, { error: "Missing 'pwd' query param" });
    ws.close();
    return;
  }

  if (API_KEY && token !== API_KEY) {
    wsSendSafe(ws, { error: "Invalid token" });
    ws.close();
    return;
  }

  try {
    const response = await fetch(
      `${API_BASE}/aidesoignants/password/${aideId}`,
      {
        method: "GET",
        headers: {
          api_key: API_KEY,
          "Content-Type": "application/json",
        },
      }
    );

    if (!response.ok) {
      console.error(
        `[WS Auth] API call failed for aide ${aideId}:`,
        response.status
      );
      wsSendSafe(ws, { error: "Authentication failed due to API error" });
      ws.close();
      return;
    }

    const aideData = await response.json();

    if (aideData.mot_de_passe !== password) {
      wsSendSafe(ws, { error: "Invalid password" });
      ws.close();
      return;
    }

    if (!wsClients.has(aideId)) wsClients.set(aideId, new Set());
    wsClients.get(aideId).add(ws);

    if (!pendingAlerts.has(aideId)) pendingAlerts.set(aideId, new Map());

    console.log(`Aide-soignant connected: ${aideId}`);

    const queue = pendingAlerts.get(aideId);
    for (const payload of queue.values()) {
      wsSendSafe(ws, payload);
    }

    ws.on("message", (msgBuf) => {
      let data;
      try {
        data = JSON.parse(msgBuf.toString());
      } catch (err) {
        return;
      }

      if (data && data.type === "ack" && data.alertId) {
        const q = pendingAlerts.get(aideId);
        if (q && q.has(data.alertId)) {
          q.delete(data.alertId);
          console.log(`ACK received: alertId=${data.alertId}`);
        }
        return;
      }

      if (data && data.type === "resend_pending") {
        const q = pendingAlerts.get(aideId);
        if (q) {
          for (const payload of q.values()) wsSendSafe(ws, payload);
        }
      }
    });

    ws.on("close", () => {
      const set = wsClients.get(aideId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) wsClients.delete(aideId);
      }
      console.log(`Aide-soignant disconnected: ${aideId}`);
    });
  } catch (err) {
    console.error("[WS Auth] Error:", err);
    wsSendSafe(ws, { error: "Internal server error." });
    try {
      ws.close();
    } catch (e) {}
  }
});

function sendToAide(aideId, data) {
  if (!pendingAlerts.has(aideId)) pendingAlerts.set(aideId, new Map());

  const clients = wsClients.get(aideId);
  const alertId = crypto.randomUUID();
  const payload = { ...data, alertId, timestamp: new Date().toISOString() };
  pendingAlerts.get(aideId).set(alertId, payload);

  if (!clients || clients.size === 0) {
    console.log(`Aide ${aideId} offline - stored alert ${alertId}`);
    return false;
  }

  clients.forEach((ws) => wsSendSafe(ws, payload));
  console.log(`Sent alert ${alertId} to aide ${aideId}`);
  return true;
}

const retryTimer = setInterval(() => {
  try {
    wsClients.forEach((clientSet, aideId) => {
      const queue = pendingAlerts.get(aideId);
      if (!queue || queue.size === 0) return;
      for (const payload of queue.values()) {
        for (const ws of clientSet) {
          wsSendSafe(ws, payload);
        }
      }
    });
  } catch (err) {
    console.error("Retry interval error:", err);
  }
}, RETRY_INTERVAL_MS);

export { app };

// ======================
// MQTT setup
// ======================
const mqttClient = mqtt.connect(MQTT_URL);
let mqttConnected = false;

mqttClient.on("connect", () => {
  mqttConnected = true;
  console.log("Connected to MQTT broker:", MQTT_URL);
  mqttClient.subscribe("alert/box/+/+", (err) => {
    if (err) console.error("MQTT subscribe error:", err);
    else console.log("Subscribed to MQTT topics: alert/box/+/+");
  });
});

mqttClient.on("reconnect", () => console.log("MQTT reconnecting..."));
mqttClient.on("error", (err) => {
  mqttConnected = false;
  console.error("MQTT error:", err);
});
mqttClient.on("close", () => {
  mqttConnected = false;
  console.log("MQTT connection closed");
});

mqttClient.on("message", async (topic, messageBuf) => {
  const message = messageBuf.toString();
  console.log(`[MQTT] ${topic} -> ${message}`);

  // Pour la partie MECANIQUE
  try {
    const data = JSON.parse(message);

    if (data.status === "MECANIQUE") {
      console.log("ALLERTE MECANIQUE");
    }
  } catch (e) {
    console.log("Erreur : ", e);
  }

  const parts = topic.split("/").filter(Boolean);
  if (parts.length >= 4 && parts[0] === "alert" && parts[1] === "box") {
    const patientId = parts[2];
    const alertType = parts.slice(3).join("/");
    const aideId = await getAideForPatient(patientId);

    const payload = {
      type: "box_alert",
      patientId,
      alertType,
      message,
      topic,
    };

    if (aideId) {
      sendToAide(aideId, payload);
    } else {
      console.log(`No aide-soignant found for patient ${patientId}`);
    }
  }
});

// ======================
// PROMETHEUS ENDPOINT
// ======================
app.get("/metrics", async (req, res) => {
  try {
    res.set("Content-Type", client.register.contentType);
    res.end(await client.register.metrics());
  } catch (ex) {
    res.status(500).end(ex);
  }
});

// ======================
// REST endpoints
// ======================

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    mqttConnected,
    wsPort: PORT, // WS is on same port now
    activeAides: Array.from(wsClients.keys()),
  });
});

app.get("/api/clients", apiKeyMiddleware, (req, res) => {
  const summary = {};
  wsClients.forEach((set, aideId) => {
    summary[aideId] = set.size;
  });
  res.json({ clients: summary });
});

app.post("/api/send-alert", apiKeyMiddleware, (req, res) => {
  const { aideId, patientId, alertType, message } = req.body;
  if (!aideId || !patientId || !alertType) {
    return res
      .status(400)
      .json({ error: "aideId, patientId and alertType required" });
  }
  const payload = {
    type: "box_alert",
    patientId,
    alertType,
    message: message || "(manual)",
  };
  const sent = sendToAide(aideId, payload);
  res.json({ sent });
});

app.get("/api/patients/of/:aideId", apiKeyMiddleware, async (req, res) => {
  const aideId = req.params.aideId;
  try {
    const all = await fetchAllPatients();
    const myPatients = (all || [])
      .filter((p) => String(p.fk_aide_soignant) === String(aideId))
      .map((p) => ({
        id_patient: p.id_patient,
        nomFamille: p.nomFamille,
        prenom: p.prenom,
      }));
    res.json({ patients: myPatients });
  } catch (err) {
    console.error("/api/patients/of error:", err);
    res.status(500).json({ error: "failed" });
  }
});

app.get("/api/prescriptions/:patientId", apiKeyMiddleware, async (req, res) => {
  const pid = req.params.patientId;
  if (!API_BASE)
    return res.status(500).json({ error: "API_BASE_URL not configured" });
  try {
    const url = `${API_BASE}/prescriptions/${encodeURIComponent(pid)}`;
    const r = await fetch(url);
    if (!r.ok) {
      return res.status(r.status).json({ error: await r.text() });
    }
    const data = await r.json();
    res.json(data);
  } catch (err) {
    console.error("Error fetching prescriptions:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/prescriptions", apiKeyMiddleware, async (req, res) => {
  const pid = req.params.patientId;
  const {
    heure_distrib,
    nom_medoc,
    quantite_totale,
    quantite_restante,
    compartiment,
  } = req.body;

  if (!nom_medoc || !quantite_totale || !quantite_restante || !compartiment) {
    return res.status(400).json({ error: "Champs obligatoires manquants" });
  }

  try {
    if (!API_BASE) {
      return res.status(500).json({ error: "API_BASE_URL non configurée" });
    }
    const url = `${API_BASE}/prescriptions/${encodeURIComponent(pid)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        heure_distrib,
        nom_medoc,
        quantite_totale,
        quantite_restante,
        compartiment,
      }),
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: await r.text() });
    }
    const data = await r.json();
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error posting prescription:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================
// ENDPOINT D'AUTHENTIFICATION
// ======================
app.post("/api/auth/login", async (req, res) => {
  const { id, password, role } = req.body;

  if (!id || !password || !role) {
    return res.status(400).json({
      error: "Paramètres manquants",
      required: ["id", "password", "role"],
    });
  }

  const validRoles = ["medecins", "patients", "aidesoignants"];
  if (!validRoles.includes(role)) {
    return res.status(400).json({
      error: "Rôle invalide",
      validRoles,
    });
  }

  try {
    console.log(`[AUTH] Tentative: ${role}/${id}`);
    const apiUrl = `${API_BASE}/${role}/${id}`;

    const response = await fetch(apiUrl, {
      method: "GET",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      console.log(`[AUTH] Non trouvé: ${response.status}`);
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }

    const userData = await response.json();

    if (!userData || !userData.mot_de_passe) {
      return res.status(404).json({ error: "Utilisateur non trouvé" });
    }

    if (userData.mot_de_passe !== password) {
      console.log(`[AUTH] Mot de passe incorrect`);
      return res.status(401).json({ error: "Mot de passe incorrect" });
    }

    console.log(`[AUTH] ✅ Succès: ${role}/${id}`);

    res.json({
      success: true,
      user: userData,
      role: role,
      message: "Authentification réussie",
    });
  } catch (error) {
    console.error(`[AUTH] Erreur:`, error);
    res.status(500).json({
      error: "Erreur serveur",
      message: error.message,
    });
  }
});

// ======================
// TEST D'ALERTES
// ======================

// Envoyer une alerte de test manuelle
app.post("/api/test/send-alert", apiKeyMiddleware, (req, res) => {
  const { aideId, patientId, alertType, message } = req.body;

  if (!aideId) {
    return res.status(400).json({ error: "aideId requis" });
  }

  const payload = {
    type: "box_alert",
    patientId: patientId || "test-patient",
    alertType: alertType || "test",
    message: message || "Alerte de test",
    topic: "alert/box/test/manual",
  };

  const sent = sendToAide(aideId, payload);
  res.json({
    success: true,
    sent,
    message: sent
      ? "Alerte envoyée"
      : "Aide-soignant hors ligne, alerte en attente",
  });
});

// Démarrer l'envoi d'alertes périodiques (pour tests)
let testAlertInterval = null;

app.post("/api/test/start-periodic-alerts", apiKeyMiddleware, (req, res) => {
  const { aideId, intervalSeconds } = req.body;

  if (!aideId) {
    return res.status(400).json({ error: "aideId requis" });
  }

  const interval = (intervalSeconds || 30) * 1000; // Défaut: 30 secondes

  // Arrêter l'ancien timer s'il existe
  if (testAlertInterval) {
    clearInterval(testAlertInterval);
  }

  let counter = 1;

  testAlertInterval = setInterval(() => {
    const alertTypes = ["empty", "late", "low", "error"];
    const randomType =
      alertTypes[Math.floor(Math.random() * alertTypes.length)];

    const payload = {
      type: "box_alert",
      patientId: "pat-test-" + counter,
      alertType: randomType,
      message: `Alerte de test #${counter} - ${new Date().toLocaleTimeString(
        "fr-FR"
      )}`,
      topic: `alert/box/test/${randomType}`,
    };

    sendToAide(aideId, payload);
    console.log(`[TEST] Alerte ${counter} envoyée à ${aideId}`);
    counter++;
  }, interval);

  res.json({
    success: true,
    message: `Alertes périodiques démarrées pour ${aideId}`,
    interval: `${intervalSeconds || 30} secondes`,
  });
});

// Arrêter les alertes périodiques
app.post("/api/test/stop-periodic-alerts", apiKeyMiddleware, (req, res) => {
  if (testAlertInterval) {
    clearInterval(testAlertInterval);
    testAlertInterval = null;
    res.json({ success: true, message: "Alertes périodiques arrêtées" });
  } else {
    res.json({ success: false, message: "Aucune alerte périodique en cours" });
  }
});

// Vérifier si un patient existe par ID
app.get("/api/patients/:patientId", apiKeyMiddleware, async (req, res) => {
  const patientId = req.params.patientId;

  if (!API_BASE) {
    return res.status(500).json({ error: "API_BASE_URL non configurée" });
  }

  try {
    const url = `${API_BASE}/patients/${encodeURIComponent(patientId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.status(404).json({
          error: "Patient non trouvé",
          patientId,
        });
      }
      return res.status(response.status).json({
        error: "Erreur API",
        status: response.status,
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Erreur récupération patient:", err);
    res.status(500).json({ error: err.message });
  }
});

// Créer un nouveau patient (pour les nouvelles box)
app.post("/api/patients", apiKeyMiddleware, async (req, res) => {
  const { id_patient, mot_de_passe, nomFamille, prenom, sexe, date_naissance } =
    req.body;

  if (!id_patient) {
    return res.status(400).json({
      error: "id_patient requis",
    });
  }

  if (!API_BASE) {
    return res.status(500).json({ error: "API_BASE_URL non configurée" });
  }

  try {
    const url = `${API_BASE}/patients`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id_patient,
        mot_de_passe: mot_de_passe || "default123",
        nomFamille: nomFamille || "Device",
        prenom: prenom || id_patient,
        sexe: sexe || "U",
        date_naissance: date_naissance || null,
        adresse_postale: null,
        adresse_electronique: null,
        fk_aide_soignant: null,
        fk_medecin_traitant: null,
      }),
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Erreur création patient",
        details: await response.text(),
      });
    }

    const data = await response.json();
    res.status(201).json({
      success: true,
      patient: data,
      message: "Patient créé avec succès",
    });
  } catch (err) {
    console.error("Erreur création patient:", err);
    res.status(500).json({ error: err.message });
  }
});

// Récupérer les médicaments d'un patient
app.get("/api/medocs/:patientId", apiKeyMiddleware, async (req, res) => {
  const patientId = req.params.patientId;

  if (!API_BASE) {
    return res.status(500).json({ error: "API_BASE_URL non configurée" });
  }

  try {
    const url = `${API_BASE}/medocpatients/${encodeURIComponent(patientId)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return res.json([]); // Pas de médicaments = liste vide
      }
      return res.status(response.status).json({
        error: "Erreur API",
      });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Erreur récupération médicaments:", err);
    res.status(500).json({ error: err.message });
  }
});

// Mettre à jour la quantité de médicaments après distribution
app.patch(
  "/api/medocs/:medocId/distribute",
  apiKeyMiddleware,
  async (req, res) => {
    const medocId = req.params.medocId;
    const { quantite_distribuee } = req.body;

    if (!quantite_distribuee) {
      return res.status(400).json({
        error: "quantite_distribuee requise",
      });
    }

    if (!API_BASE) {
      return res.status(500).json({ error: "API_BASE_URL non configurée" });
    }

    try {
      // Récupérer d'abord les infos du médicament
      const getUrl = `${API_BASE}/medocpatients/id/${encodeURIComponent(
        medocId
      )}`;
      const getResponse = await fetch(getUrl, {
        method: "GET",
        headers: {
          api_key: API_KEY,
          "Content-Type": "application/json",
        },
      });

      if (!getResponse.ok) {
        return res.status(404).json({ error: "Médicament non trouvé" });
      }

      const medoc = await getResponse.json();
      const newQuantite = medoc.quantite_restante - quantite_distribuee;

      if (newQuantite < 0) {
        return res.status(400).json({
          error: "Stock insuffisant",
          restant: medoc.quantite_restante,
        });
      }

      // Mettre à jour la quantité
      const updateUrl = `${API_BASE}/medocpatients/${encodeURIComponent(
        medocId
      )}`;
      const updateResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          api_key: API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quantite_restante: newQuantite,
        }),
      });

      if (!updateResponse.ok) {
        return res.status(updateResponse.status).json({
          error: "Erreur mise à jour",
        });
      }

      const data = await updateResponse.json();
      res.json({
        success: true,
        quantite_restante: newQuantite,
        data,
      });
    } catch (err) {
      console.error("Erreur distribution médicament:", err);
      res.status(500).json({ error: err.message });
    }
  }
);

// Endpoint pour enregistrer une distribution de médicament
app.post("/api/distributions", apiKeyMiddleware, async (req, res) => {
  const { patientId, medocId, quantite, timestamp } = req.body;

  if (!patientId || !medocId) {
    return res.status(400).json({
      error: "patientId et medocId requis",
    });
  }

  try {
    // Mettre à jour la quantité restante
    const updateUrl = `/api/medocs/${medocId}/distribute`;
    const updateResponse = await fetch(`http://localhost:${PORT}${updateUrl}`, {
      method: "PATCH",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        quantite_distribuee: quantite || 1,
      }),
    });

    if (!updateResponse.ok) {
      return res.status(updateResponse.status).json({
        error: "Erreur mise à jour stock",
      });
    }

    // Envoyer une notification à l'aide-soignant si nécessaire
    const aideId = await getAideForPatient(patientId);
    if (aideId) {
      sendToAide(aideId, {
        type: "distribution_confirmed",
        patientId,
        medocId,
        quantite: quantite || 1,
        timestamp: timestamp || new Date().toISOString(),
      });
    }

    res.json({
      success: true,
      message: "Distribution enregistrée",
    });
  } catch (err) {
    console.error("Erreur enregistrement distribution:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================
// ENDPOINT DE DIAGNOSTIC
// ======================
app.get("/api/device/:deviceId/status", apiKeyMiddleware, async (req, res) => {
  const deviceId = req.params.deviceId;

  try {
    // Vérifier si le device existe en tant que patient
    const patientUrl = `${API_BASE}/patients/${encodeURIComponent(deviceId)}`;
    const patientResponse = await fetch(patientUrl, {
      method: "GET",
      headers: {
        api_key: API_KEY,
        "Content-Type": "application/json",
      },
    });

    const patientExists = patientResponse.ok;
    let patientData = null;

    if (patientExists) {
      patientData = await patientResponse.json();
    }

    // Récupérer les médicaments
    let medocs = [];
    if (patientExists) {
      const medocsUrl = `${API_BASE}/medocpatients/${encodeURIComponent(
        deviceId
      )}`;
      const medocsResponse = await fetch(medocsUrl, {
        method: "GET",
        headers: {
          api_key: API_KEY,
          "Content-Type": "application/json",
        },
      });

      if (medocsResponse.ok) {
        medocs = await medocsResponse.json();
      }
    }

    // Calculer le stock total
    const totalStock = medocs.reduce(
      (sum, m) => sum + (m.quantite_restante || 0),
      0
    );

    res.json({
      deviceId,
      registered: patientExists,
      patient: patientData,
      medicaments: {
        count: medocs.length,
        total_stock: totalStock,
        details: medocs,
      },
      aide_soignant: patientData?.fk_aide_soignant || null,
    });
  } catch (err) {
    console.error("Erreur status device:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================
// AUTOMATIC GIST UPDATE
// ======================
async function updateGistWithNgrok() {
  if (!GIST_ID || !GITHUB_TOKEN) {
    console.log(
      "⚠️ Variables GIST_ID ou GITHUB_TOKEN manquantes. Mise à jour Gist désactivée."
    );
    return;
  }

  console.log("⏳ Attente de 15s pour l'initialisation de Ngrok...");
  await new Promise((r) => setTimeout(r, 15000)); // Attendre que Ngrok démarre

  try {
    // 1. Interroger l'API locale Ngrok (dans le réseau Docker)
    console.log(`🔍 Récupération des tunnels sur ${NGROK_API_URL}...`);
    const ngrokRes = await fetch(NGROK_API_URL);

    if (!ngrokRes.ok) {
      throw new Error(`Erreur Ngrok API: ${ngrokRes.status}`);
    }
    const ngrokData = await ngrokRes.json();

    // 2. Trouver les tunnels
    const httpTunnel = ngrokData.tunnels.find((t) => t.proto === "https");
    const tcpTunnel = ngrokData.tunnels.find((t) => t.proto === "tcp");

    if (!httpTunnel || !tcpTunnel) {
      console.warn(
        "⚠️ Tunnels Ngrok (HTTPS/TCP) introuvables. Vérifie ton fichier ngrok.yml."
      );
      return;
    }

    console.log("✅ Tunnels trouvés :");
    console.log("   API/WS:", httpTunnel.public_url);
    console.log("   MQTT:", tcpTunnel.public_url);

    // 3. Préparer le contenu pour GitHub
    const newConfig = {
      api_url: httpTunnel.public_url,
      mqtt_url: tcpTunnel.public_url,
      updated_at: new Date().toISOString(),
    };

    // 4. Mettre à jour le Gist
    const gistRes = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
      method: "PATCH",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "User-Agent": "RaspberryPi-IoT-Server",
      },
      body: JSON.stringify({
        files: {
          "config.json": {
            content: JSON.stringify(newConfig, null, 2),
          },
        },
      }),
    });

    if (gistRes.ok) {
      console.log(
        "🚀 GitHub Gist mis à jour avec succès ! Les ESP32 peuvent se connecter."
      );
    } else {
      console.error("❌ Erreur GitHub:", await gistRes.text());
    }
  } catch (err) {
    console.error("❌ Erreur COMPLETE:", err); // Affiche tout l'objet erreur
    if (err.cause) console.error("🔍 Cause:", err.cause);

    // Affiche l'URL exacte que le code essaie d'appeler pour vérifier les fautes
    console.log("🔗 URL tentée :", `https://api.github.com/gists/${GIST_ID}`);
  }
}

// ======================
// Shutdown
// ======================
async function shutdown() {
  console.log("Shutting down...");
  try {
    mqttClient.end();
  } catch (e) {}
  try {
    wss.close();
  } catch (e) {}
  process.exit(0);
}

process.on("SIGINT", shutdown);

process.on("SIGTERM", shutdown);
