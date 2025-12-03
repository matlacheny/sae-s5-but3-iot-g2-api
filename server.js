// server.js
import express from "express";
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
MQTT_URL=mqtt://localhost:1883
PORT=3000
WS_PORT=8080
API_BASE_URL=https://apidatabasesae-aee3egcmdke2b6a2.germanywestcentral-01.azurewebsites.net/api
RETRY_INTERVAL_MS=10000
*/

const API_KEY = process.env.API_KEY || "";
const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";
const HTTP_PORT = parseInt(process.env.PORT || "3200", 10);
const WS_PORT = parseInt(process.env.WS_PORT || "8000", 10);
const API_BASE = process.env.API_BASE_URL || "";
const RETRY_INTERVAL_MS = parseInt(process.env.RETRY_INTERVAL_MS || "10000", 10);

// ======================
// Express + middleware
// ======================
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// simple API key middleware for protected REST endpoints
function apiKeyMiddleware(req, res, next) {
    const key = req.headers["api_key"];
    if (!API_KEY) {
        // no API key configured -> dev mode, allow
        return next();
    }
    if (!key || key !== API_KEY) {
        return res.status(401).json({ error: "Unauthorized: invalid API key" });
    }
    next();
}

// ======================
// In-memory cache for patients (to limit API calls)
// ======================
let patientsCache = null;
let patientsCacheTs = 0;
const PATIENTS_CACHE_TTL_MS = 30_000; // 30s - ajuste selon besoin

async function fetchAllPatients() {
    // use cache when fresh
    const now = Date.now();
    if (patientsCache && (now - patientsCacheTs) < PATIENTS_CACHE_TTL_MS) {
        return patientsCache;
    }
    if (!API_BASE) {
        console.warn("API_BASE_URL not set. fetchAllPatients will return []");
        return [];
    }
    const url = `${API_BASE}/patients`;
    try {
        const res = await fetch(url);
        if (!res.ok) {
            console.error("Failed to fetch patients:", res.status, await res.text());
            return [];
        }
        const data = await res.json();
        patientsCache = data;
        patientsCacheTs = Date.now();
        return data;
    } catch (err) {
        console.error("Error fetching patients:", err);
        return [];
    }
}

// helper: get aide id for a patient id by calling external API (uses cached patients list)
async function getAideForPatient(patientId) {
    try {
        const patients = await fetchAllPatients();
        if (!Array.isArray(patients)) return null;
        const p = patients.find(x => String(x.id_patient) === String(patientId));
        if (!p) return null;
        return p.fk_aide_soignant || null;
    } catch (err) {
        console.error("getAideForPatient error:", err);
        return null;
    }
}

// ======================
// WebSocket server + ACK management
// ======================

// map aideId -> Set(ws)
const wsClients = new Map();
// map aideId -> Map(alertId -> payload)
const pendingAlerts = new Map();

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`WebSocket server listening on port ${WS_PORT}`);

// helper to safely send JSON to ws
function wsSendSafe(ws, obj) {
    try {
        if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    } catch (err) {
        console.warn("wsSendSafe error:", err);
    }
}

wss.on("connection", (ws, req) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
        const token = url.searchParams.get("token");
        const aideId = url.searchParams.get("id");

        if (!aideId) {
            wsSendSafe(ws, { error: "Missing 'id' query param (aide-soignant id)" });
            ws.close();
            return;
        }

        if (API_KEY && token !== API_KEY) {
            wsSendSafe(ws, { error: "Invalid token" });
            ws.close();
            return;
        }

        // register connection
        if (!wsClients.has(aideId)) wsClients.set(aideId, new Set());
        wsClients.get(aideId).add(ws);

        // ensure pendingAlerts map exists
        if (!pendingAlerts.has(aideId)) pendingAlerts.set(aideId, new Map());

        console.log(`Aide-soignant connected: ${aideId} (connections: ${wsClients.get(aideId).size})`);

        // on connect: resend pending alerts for this aide
        const queue = pendingAlerts.get(aideId);
        for (const payload of queue.values()) {
            wsSendSafe(ws, payload);
        }

        ws.on("message", (msgBuf) => {
            // expect JSON messages
            let data;
            try {
                data = JSON.parse(msgBuf.toString());
            } catch (err) {
                console.warn("Invalid WS message (not JSON):", msgBuf.toString());
                return;
            }

            // handle ACK
            if (data && data.type === "ack" && data.alertId) {
                const q = pendingAlerts.get(aideId);
                if (q && q.has(data.alertId)) {
                    q.delete(data.alertId);
                    console.log(`ACK received: alertId=${data.alertId} from aide=${aideId}`);
                } else {
                    // maybe already removed or unknown
                    console.log(`ACK for unknown alertId=${data.alertId} from aide=${aideId}`);
                }
                return;
            }

            // optionally handle other WS message types (ping, client actions...)
            // e.g. client can request resend: { type: "resend_pending" }
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
        console.error("WS connection handling error:", err);
        try { ws.close(); } catch(e) {}
    }
});

// send an alert to an aide (stores in pendingAlerts until ACK)
function sendToAide(aideId, data) {
    // ensure queue exists
    if (!pendingAlerts.has(aideId)) pendingAlerts.set(aideId, new Map());

    const clients = wsClients.get(aideId);
    if (!clients || clients.size === 0) {
        // Save the alert in pendingAlerts even if aide is offline (will be delivered on reconnect)
        const alertId = crypto.randomUUID();
        const payload = { ...data, alertId, timestamp: new Date().toISOString() };
        pendingAlerts.get(aideId).set(alertId, payload);
        console.log(`Aide ${aideId} offline - stored alert ${alertId}`);
        return false;
    }

    // create alertId and store
    const alertId = crypto.randomUUID();
    const payload = { ...data, alertId, timestamp: new Date().toISOString() };
    pendingAlerts.get(aideId).set(alertId, payload);

    // send to all connected ws for that aide
    clients.forEach(ws => wsSendSafe(ws, payload));
    console.log(`Sent alert ${alertId} to aide ${aideId} (connections: ${clients.size})`);
    return true;
}

// retry mechanism: re-send pending alerts periodically
setInterval(() => {
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
        // Also keep pendingAlerts for aides currently offline (they'll be delivered on reconnect)
    } catch (err) {
        console.error("Retry interval error:", err);
    }
}, RETRY_INTERVAL_MS);

// ======================
// MQTT setup
// ======================
const mqttClient = mqtt.connect(MQTT_URL);

let mqttConnected = false;

mqttClient.on("connect", () => {
    mqttConnected = true;
    console.log("Connected to MQTT broker:", MQTT_URL);
    // subscribe to the alert topics pattern you use
    // Example topic form: alert/box/{patientId}/{alertType}
    mqttClient.subscribe("alert/box/+/+", (err) => {
        if (err) {
            console.error("MQTT subscribe error:", err);
        } else {
            console.log("Subscribed to MQTT topics: alert/box/+/+");
        }
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

    // parse topic expecting: alert/box/{patientId}/{alertType...}
    const parts = topic.split("/").filter(Boolean);
    if (parts.length >= 4 && parts[0] === "alert" && parts[1] === "box") {
        const patientId = parts[2];
        const alertType = parts.slice(3).join("/"); // support multi-segment alert types

        // get aide for patient via API
        const aideId = await getAideForPatient(patientId);

        // alert payload
        const payload = {
            type: "box_alert",
            patientId,
            alertType,
            message,
            topic
        };

        if (aideId) {
            sendToAide(aideId, payload);
        } else {
            console.log(`No aide-soignant found for patient ${patientId}; storing as unassigned or log`);
            // optionally store in a global pending list or log for manual handling
        }
    } else {
        // handle other MQTT topics if needed
    }
});

// ======================
// REST endpoints (management)
// ======================

app.get("/api/health", (req, res) => {
    res.json({
        status: "ok",
        mqttConnected,
        wsPort: WS_PORT,
        activeAides: Array.from(wsClients.keys())
    });
});

// list connected clients (aideId -> count)
app.get("/api/clients", apiKeyMiddleware, (req, res) => {
    const summary = {};
    wsClients.forEach((set, aideId) => {
        summary[aideId] = set.size;
    });
    res.json({ clients: summary });
});

// send manual alert to aide (useful for testing)
app.post("/api/send-alert", apiKeyMiddleware, (req, res) => {
    const { aideId, patientId, alertType, message } = req.body;
    if (!aideId || !patientId || !alertType) {
        return res.status(400).json({ error: "aideId, patientId and alertType required" });
    }
    const payload = {
        type: "box_alert",
        patientId,
        alertType,
        message: message || "(manual)"
    };
    const sent = sendToAide(aideId, payload);
    res.json({ sent });
});

// list patients for an aide (via remote API)
app.get("/api/patients/of/:aideId", apiKeyMiddleware, async (req, res) => {
    const aideId = req.params.aideId;
    try {
        const all = await fetchAllPatients();
        const myPatients = (all || []).filter(p => String(p.fk_aide_soignant) === String(aideId))
            .map(p => ({ id_patient: p.id_patient, nomFamille: p.nomFamille, prenom: p.prenom }));
        res.json({ patients: myPatients });
    } catch (err) {
        console.error("/api/patients/of error:", err);
        res.status(500).json({ error: "failed" });
    }
});

// optional: fetch prescriptions for a given patient via external API and return
app.get("/api/prescriptions/:patientId", apiKeyMiddleware, async (req, res) => {
    const pid = req.params.patientId;
    if (!API_BASE) return res.status(500).json({ error: "API_BASE_URL not configured" });
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

// ======================
// Start HTTP server
// ======================
app.listen(HTTP_PORT, () => {
    console.log(`HTTP server running on port ${HTTP_PORT}`);
});

// graceful shutdown
async function shutdown() {
    console.log("Shutting down...");
    try { mqttClient.end(); } catch (e) {}
    try { wss.close(); } catch (e) {}
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
