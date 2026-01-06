import { jest, describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import request from "supertest";
import app from "./app.js"; // Assure-toi que c'est bien app.js (sans le listen)
import sql from "mssql";

// ==========================================
// MOCK DE LA BASE DE DONNÉES (MSSQL)
// ==========================================
// On utilise jest.mock ici
jest.mock("mssql", () => {
    const mRequest = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn()
    };
    const mPool = {
        request: jest.fn().mockReturnValue(mRequest),
        close: jest.fn()
    };

    return {
        connect: jest.fn().mockResolvedValue(mPool),
        Request: jest.fn(() => mRequest),
        VarChar: "VarChar",
        Date: "Date",
        // Ajoute d'autres types si nécessaire
    };
});

// ==========================================
// TESTS
// ==========================================
describe("API Tests", () => {
    const API_KEY = "test-secret-key";

    beforeAll(() => {
        process.env.API_KEY = API_KEY;
        // On met des fausses valeurs pour éviter que l'app essaie de se connecter pour de vrai
        process.env.DB_USER = "fake";
        process.env.DB_PASSWORD = "fake";
        process.env.DB_SERVER = "fake";
        process.env.DB_NAME = "fake";
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    // 1. TEST DE L'AUTHENTIFICATION
    describe("Security / Auth", () => {
        it("Devrait refuser l'accès sans clé API (401)", async () => {
            const res = await request(app).get("/api/medecins");
            expect(res.statusCode).toEqual(401);
        });

        it("Devrait refuser l'accès avec une mauvaise clé API (401)", async () => {
            const res = await request(app)
                .get("/api/medecins")
                .set("api_key", "mauvaise-cle");
            expect(res.statusCode).toEqual(401);
        });
    });

    // 2. TEST DES ROUTES MEDECINS (Lecture)
    describe("GET /api/medecins", () => {
        it("Devrait retourner la liste des médecins (Mock DB)", async () => {
            const mockData = [{ id_medecin: "MED01", nomFamille: "House" }];

            // On récupère le pool mocké
            const pool = await sql.connect();
            // On dit au mock : "quand on t'appelle, renvoie ça"
            pool.request().query.mockResolvedValueOnce({ recordset: mockData });

            const res = await request(app)
                .get("/api/medecins")
                .set("api_key", API_KEY);

            expect(res.statusCode).toEqual(200);
            expect(res.body).toEqual(mockData);
        });

        it("Devrait gérer les erreurs de base de données (500)", async () => {
            const pool = await sql.connect();
            pool.request().query.mockRejectedValueOnce(new Error("DB Connection Failed"));

            const res = await request(app)
                .get("/api/medecins")
                .set("api_key", API_KEY);

            expect(res.statusCode).toEqual(500);
        });
    });

    // 3. TEST D'AJOUT (Ecriture)
    describe("POST /api/medecins", () => {
        it("Devrait créer un médecin avec succès", async () => {
            const newMedecin = {
                id_medecin: "MED02",
                mot_de_passe: "secret",
                nomFamille: "Grey",
                prenom: "Meredith",
                date_naissance: "1980-01-01",
                sexe: "F",
                adresse_postale: "Seattle",
                adresse_electronique: "grey@hospital.com"
            };

            const pool = await sql.connect();
            pool.request().query.mockResolvedValueOnce({ rowsAffected: [1] });

            const res = await request(app)
                .post("/api/medecins")
                .set("api_key", API_KEY)
                .send(newMedecin);

            expect(res.statusCode).toEqual(200);
        });
    });

    // 4. HEALTHCHECK
    describe("GET /health", () => {
        it("Devrait retourner OK", async () => {
            const res = await request(app).get("/health");
            expect(res.statusCode).toEqual(200);
        });
    });
});