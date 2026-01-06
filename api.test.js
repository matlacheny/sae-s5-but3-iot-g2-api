import request from 'supertest';
import {afterAll, beforeAll, beforeEach, describe, expect, it, jest} from '@jest/globals';
import WebSocket from 'ws';

// ==========================================
// 1. SETUP ENVIRONNEMENT (AVANT IMPORTS)
// ==========================================
process.env.API_KEY = process.env.API_KEY || "supercleAPI";
process.env.PORT = "0";
process.env.RETRY_INTERVAL_MS = "1000";
process.env.NODE_ENV = 'test';

// 👇 AJOUT CRUCIAL : Pour éviter l'erreur 500 dans /api/prescriptions
process.env.API_BASE_URL = process.env.API_BASE_URL |"https://api.fake-database.com";

// ==========================================
// 2. MOCKS GLOBAUX
// ==========================================
global.fetch = jest.fn();

jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        on: jest.fn(),
        subscribe: jest.fn(),
        end: jest.fn(),
        emit: jest.fn()
    }))
}));

// ==========================================
// 3. IMPORT DU SERVEUR
// ==========================================
import { app, server, wss, stopRetryTimer } from './server.js';

const API_KEY = process.env.API_KEY;

describe('IoT Server Tests', () => {

    let TEST_PORT;

    beforeAll((done) => {
        if (server.listening) {
            TEST_PORT = server.address().port;
            done();
        } else {
            server.on('listening', () => {
                TEST_PORT = server.address().port;
                done();
            });
        }
    });

    afterAll((done) => {
        stopRetryTimer();
        // On force la fermeture de tout pour que Jest s'arrête
        wss.close(() => {
            server.close(done);
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset du mock fetch par défaut
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => "OK"
        });
    });

    // ============================================
    // TESTS API REST
    // ============================================
    describe('GET /api/health', () => {
        it('devrait retourner 200 OK et la config', async () => {
            const res = await request(app).get('/api/health');
            expect(res.statusCode).toEqual(200);
            expect(res.body.status).toBe('ok');
        });
    });

    describe('Security Middleware', () => {
        it('devrait refuser l\'accès sans API Key', async () => {
            const res = await request(app).get('/api/clients');
            expect(res.statusCode).toEqual(401);
        });

        it('devrait refuser l\'accès avec mauvaise API Key', async () => {
            const res = await request(app)
                .get('/api/clients')
                .set('api_key', 'mauvaise_cle');
            expect(res.statusCode).toEqual(401);
        });

        it('devrait accepter l\'accès avec bonne API Key', async () => {
            const res = await request(app)
                .get('/api/clients')
                .set('api_key', API_KEY);
            expect(res.statusCode).toEqual(200);
        });
    });

    // ============================================
    // TESTS AUTHENTIFICATION
    // ============================================
    describe('POST /api/auth/login', () => {
        it('devrait rejeter s\'il manque des paramètres', async () => {
            const res = await request(app).post('/api/auth/login').send({ id: '1' });
            expect(res.statusCode).toEqual(400);
        });

        it('devrait rejeter un rôle invalide', async () => {
            const res = await request(app).post('/api/auth/login').send({
                id: '1', password: 'pwd', role: 'hacker'
            });
            expect(res.statusCode).toEqual(400);
        });

        it('devrait authentifier avec succès', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 1, mot_de_passe: 'bon_mdp' })
            });

            const res = await request(app).post('/api/auth/login').send({
                id: '1', password: 'bon_mdp', role: 'medecins'
            });
            expect(res.statusCode).toEqual(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ============================================
    // TESTS PRESCRIPTIONS
    // ============================================
    describe('POST /api/prescriptions', () => {
        it('devrait valider les champs obligatoires', async () => {
            const res = await request(app)
                .post('/api/prescriptions')
                .set('api_key', API_KEY)
                .send({ nom_medoc: 'Doliprane' });
            expect(res.statusCode).toEqual(400);
        });

        it('devrait réussir si l\'API externe répond OK', async () => {
            // Mock de la réponse de l'API externe (Database)
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 101 }) // Réponse de l'API externe
            });

            const res = await request(app)
                .post('/api/prescriptions')
                .set('api_key', API_KEY)
                .send({
                    heure_distrib: '12:00',
                    nom_medoc: 'Doliprane',
                    quantite_totale: 10,
                    quantite_restante: 10,
                    compartiment: 1
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.success).toBe(true);
        });
    });

    // ============================================
    // TESTS WEBSOCKET
    // ============================================
    describe('WebSocket Integration', () => {
        let wsClient;
        const AIDE_ID = 'aide_ws_1';
        const AIDE_PWD = 'secure_password';

        afterEach(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.close();
            }
        });

        it('WS: Devrait rejeter connexion sans paramètres (Fermeture attendue)', (done) => {
            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}`);
            wsClient.on('close', () => done());
            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.error) wsClient.close();
            });
        });

        it('WS: Devrait rejeter connexion avec mauvais token', (done) => {
            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=1&pwd=x&token=FAKE`);
            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.error === 'Invalid token') {
                    wsClient.close();
                    done();
                }
            });
            wsClient.on('close', () => done());
        });

        it('WS: Scénario complet (Connexion -> Réception Alerte -> ACK)', (done) => {
            // Mock Auth réussi pour la connexion WS
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ mot_de_passe: AIDE_PWD })
            });

            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=${AIDE_ID}&pwd=${AIDE_PWD}&token=${API_KEY}`);

            wsClient.on('open', async () => {
                // ⚠️ AJOUT DU DELAI : On attend 500ms pour être sûr que le serveur
                // a fini d'enregistrer le WebSocket dans sa Map 'wsClients'
                await new Promise(r => setTimeout(r, 500));

                // Maintenant on déclenche l'alerte
                await request(app)
                    .post('/api/test/send-alert')
                    .set('api_key', API_KEY)
                    .send({
                        aideId: AIDE_ID,
                        patientId: 'patient_test',
                        alertType: 'urgence'
                    });
            });

            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.type === 'box_alert') {
                    expect(msg.patientId).toBe('patient_test');
                    wsClient.send(JSON.stringify({ type: 'ack', alertId: msg.alertId }));
                    wsClient.close();
                    done();
                }
            });
        }, 10000); // Timeout augmenté à 10s pour ce test
    });
});