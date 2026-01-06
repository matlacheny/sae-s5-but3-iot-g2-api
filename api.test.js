import request from 'supertest';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest} from '@jest/globals';
import WebSocket from 'ws';

// 1. Mocker les dépendances AVANT d'importer le serveur
// On empêche les vrais appels réseaux (fetch) et MQTT
global.fetch = jest.fn();

// Mock MQTT pour éviter la connexion réelle
jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        on: jest.fn(),
        subscribe: jest.fn(),
        end: jest.fn(),
        emit: jest.fn() // Pour simuler la réception de message
    }))
}));

// Import dynamique du serveur
import { app, server, wss } from './server.js';

process.env.API_KEY = process.env.API_KEY || "supercleAPI";
process.env.PORT = "0"; // Port aléatoire pour les tests
process.env.RETRY_INTERVAL_MS = "1000"; // Intervalle court pour les tests
process.env.NODE_ENV = 'test';

describe('IoT Server Tests', () => {

    // Helper pour attendre que le serveur soit prêt (si besoin)
    beforeAll((done) => {
        if (!server.listening) {
            server.listen(0, () => done()); // Port aléatoire
        } else {
            done();
        }
    });

    afterAll((done) => {
        server.close();
        wss.close(() => done());
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset du mock fetch par défaut (Status OK)
        global.fetch.mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({}),
            text: async () => "OK"
        });
    });

    // ============================================
    // 1. TESTS API REST (Basic & Middleware)
    // ============================================
    describe('GET /api/health', () => {
        it('devrait retourner 200 OK et la config', async () => {
            const res = await request(app).get('/api/health');
            expect(res.statusCode).toEqual(200);
            expect(res.body.status).toBe('ok');
            expect(res.body).toHaveProperty('activeAides');
        });
    });

    describe('Security Middleware', () => {
        it('devrait refuser l\'accès sans API Key sur route protégée', async () => {
            const res = await request(app).get('/api/clients');
            expect(res.statusCode).toEqual(401);
            expect(res.body.error).toMatch(/Unauthorized/);
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
    // 2. TESTS AUTHENTIFICATION (Login Endpoint)
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

        it('devrait gérer utilisateur introuvable (404 de l\'API externe)', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: false,
                status: 404,
                json: async () => ({})
            });

            const res = await request(app).post('/api/auth/login').send({
                id: '99', password: 'pwd', role: 'medecins'
            });
            expect(res.statusCode).toEqual(404);
        });

        it('devrait rejeter un mauvais mot de passe', async () => {
            // Mock API externe retourne le bon user
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 1, mot_de_passe: 'bon_mdp' })
            });

            const res = await request(app).post('/api/auth/login').send({
                id: '1', password: 'mauvais_mdp', role: 'medecins'
            });
            expect(res.statusCode).toEqual(401);
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
    // 3. TESTS PRESCRIPTIONS
    // ============================================
    describe('POST /api/prescriptions', () => {
        it('devrait valider les champs obligatoires', async () => {
            const res = await request(app)
                .post('/api/prescriptions')
                .set('api_key', API_KEY)
                .send({ nom_medoc: 'Doliprane' }); // Manque les autres
            expect(res.statusCode).toEqual(400);
        });

        it('devrait réussir si l\'API externe répond OK', async () => {
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ id: 101 })
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
    // 4. TESTS ALERTES & LOGIQUE MÉTIER
    // ============================================
    describe('POST /api/test/send-alert (Manual Trigger)', () => {
        it('devrait stocker l\'alerte en attente si l\'aide-soignant est hors ligne', async () => {
            const res = await request(app)
                .post('/api/test/send-alert')
                .set('api_key', API_KEY)
                .send({
                    aideId: 'aide_offline_1',
                    patientId: 'pat1',
                    alertType: 'chute'
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.sent).toBe(false); // False car non connecté WS
            expect(res.body.message).toContain('en attente');
        });
    });

    // ============================================
    // 5. TESTS WEBSOCKET (Connexion & Messages)
    // ============================================
    describe('WebSocket Integration', () => {
        let wsClient;
        let TEST_PORT;
        const AIDE_ID = 'aso1';
        const AIDE_PWD = 'pwd123';
        beforeAll(() => {
            // Si le serveur écoute déjà, on prend le port
            if (server.address()) {
                TEST_PORT = server.address().port;
            } else {
                // Sinon (cas rare en test), on met le port par défaut
                TEST_PORT = process.env.PORT || 3200;
            }
        });
        afterEach(() => {
            if (wsClient && wsClient.readyState === WebSocket.OPEN) {
                wsClient.close();
            }
        });

        it('WS: Devrait rejeter connexion sans paramètres', (done) => {
            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}`);
            wsClient.on('close', () => done());
            wsClient.on('open', () => done(new Error('Aurait dû échouer')));
        });

        it('WS: Devrait rejeter connexion avec mauvais token', (done) => {
            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=1&pwd=x&token=FAKE`);
            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.error === 'Invalid token') done();
            });
        });

        it('WS: Devrait rejeter si l\'API externe refuse le mot de passe', (done) => {
            // Mock API externe pour retourner le password
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ mot_de_passe: 'VRAI_MDP' })
            });

            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=${AIDE_ID}&pwd=FAUX_MDP&token=${API_KEY}`);

            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.error === 'Invalid password') done();
            });
        });

        it('WS: Scénario complet (Connexion -> Réception Alerte -> ACK)', (done) => {
            // 1. Mock Auth réussi
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ mot_de_passe: AIDE_PWD })
            });

            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=${AIDE_ID}&pwd=${AIDE_PWD}&token=${API_KEY}`);

            wsClient.on('open', async () => {
                // 2. Une fois connecté, on déclenche une alerte via l'API REST
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

                // 3. Vérifier réception alerte
                if (msg.type === 'box_alert') {
                    expect(msg.patientId).toBe('patient_test');

                    // 4. Envoyer ACK
                    wsClient.send(JSON.stringify({
                        type: 'ack',
                        alertId: msg.alertId
                    }));

                    // On laisse un petit délai pour que le serveur traite l'ACK (difficile à vérifier en blackbox, mais on s'assure que ça ne crash pas)
                    setTimeout(() => done(), 100);
                }
            });
        });
    });
});