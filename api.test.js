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
import { app, server, wss } from './server.js';

// ⚠️ CORRECTION ICI : On déclare API_KEY au niveau global du fichier
// pour qu'elle soit visible dans tous les tests 'describe' et 'it'
const API_KEY = process.env.API_KEY;

describe('IoT Server Tests', () => {

    let TEST_PORT;

    beforeAll((done) => {
        // On attend que le serveur soit prêt et on récupère son port
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
        // On ferme tout proprement pour éviter que Jest ne pende
        wss.close(() => {
            server.close(done);
        });
    });

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset du mock fetch par défaut (Status OK pour ne pas bloquer les appels basiques)
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
            // API_KEY est maintenant bien définie !
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

        // ⚠️ CORRECTION : Le serveur accepte la connexion (open) PUIS la ferme.
        // On ne doit pas échouer sur 'open', mais attendre 'close' ou un message d'erreur.
        it('WS: Devrait rejeter connexion sans paramètres (Fermeture attendue)', (done) => {
            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}`);

            // Si le serveur ferme la connexion, le test est réussi
            wsClient.on('close', () => done());

            // Si le serveur envoie un message d'erreur (c'est ce que fait ton code), c'est réussi aussi
            wsClient.on('message', (data) => {
                const msg = JSON.parse(data);
                if (msg.error) wsClient.close(); // Déclenchera l'event close ci-dessus
            });

            // On retire le fail sur 'open' car le handshake TCP réussit toujours
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
            wsClient.on('close', () => done()); // Si fermé directement, c'est bon aussi
        });

        it('WS: Scénario complet (Connexion -> Réception Alerte -> ACK)', (done) => {
            // Mock Auth réussi
            global.fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ mot_de_passe: AIDE_PWD })
            });

            wsClient = new WebSocket(`ws://localhost:${TEST_PORT}?id=${AIDE_ID}&pwd=${AIDE_PWD}&token=${API_KEY}`);

            wsClient.on('open', async () => {
                // Déclenche l'alerte une fois connecté
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
        });
    });
});