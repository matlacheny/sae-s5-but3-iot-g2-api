import express from "express";
import sql from "mssql";
import dotenv from "dotenv";
import cors from "cors";
import helmet from "helmet";

dotenv.config();
const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

// =====================
//   DB CONFIG
// =====================
const dbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: process.env.DB_SERVER,
    database: process.env.DB_NAME,
    options: {
        encrypt: true,
        enableArithAbort: true
    },
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000
    }
};

// pool unique
let poolPromise = null;
async function getPool() {
    if (!poolPromise) {
        poolPromise = sql.connect(dbConfig);
        poolPromise.catch(err => {
            console.error("DB init error:", err);
            poolPromise = null;
        });
    }
    return poolPromise;
}

// =====================
// 🔐 API KEY MIDDLEWARE
// =====================
function apiKeyAuth(req, res, next) {
    const key = req.headers["api_key"];
    if (!key || key !== process.env.API_KEY) {
        return res.status(401).json({ error: "Unauthorized: invalid API key" });
    }
    next();
}

app.use('/api', apiKeyAuth); // TOUTES les routes /api protégées

// =====================
//  ROUTES API
// =====================

// ---------- AIDE SOIGNANT ----------
app.get("/api/aidesoignants", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query("SELECT * FROM AideSoignant");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/aidesoignants/:id", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input("id", sql.VarChar, req.params.id)
            .query("SELECT * FROM AideSoignant WHERE id_aide_soignant = @id");
        res.json(result.recordset[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/aidesoignants", async (req, res) => {
    const { id_aide_soignant, mot_de_passe, nomFamille, prenom, date_naissance, sexe, adresse_postale, adresse_electronique } = req.body;
    try {
        const pool = await getPool();
        await pool.request()
            .input("id", sql.VarChar, id_aide_soignant)
            .input("pwd", sql.VarChar, mot_de_passe)
            .input("nom", sql.VarChar, nomFamille)
            .input("prenom", sql.VarChar, prenom)
            .input("date_naissance", sql.Date, date_naissance)
            .input("sexe", sql.VarChar, sexe)
            .input("adresse_postale", sql.VarChar, adresse_postale)
            .input("adresse_electronique", sql.VarChar, adresse_electronique)
            .query(`
                INSERT INTO AideSoignant(id_aide_soignant, mot_de_passe, nomFamille, prenom, date_naissance, sexe, adresse_postale, adresse_electronique )
                VALUES (@id, @pwd, @nom, @prenom, @date_naissance, @sexe, @adresse_postale, @adresse_electronique)
            `);

        res.json({ message: "Aide-soignant créé" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- MEDECINS ----------
app.get("/api/medecins", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query("SELECT * FROM Medecin");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/medecins/:id", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input("id", sql.VarChar, req.params.id)
            .query("SELECT * FROM Medecin WHERE id_medecin = @id");
        res.json(result.recordset[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/medecin", async (req, res) => {
    const { id_medecin, mot_de_passe, nomFamille, prenom, date_naissance, sexe, adresse_postale, adresse_electronique } = req.body;

    try {
        const pool = await getPool();
        await pool.request()
            .input("id", sql.VarChar, id_patient)
            .input("pwd", sql.VarChar, mot_de_passe)
            .input("nom", sql.VarChar, nomFamille)
            .input("prenom", sql.VarChar, prenom)
            .input("date_naissance", sql.Date, date_naissance)
            .input("sexe", sql.VarChar, sexe)
            .input("adresse_postale", sql.VarChar, adresse_postale)
            .input("adresse_electronique", sql.VarChar, adresse_electronique)
            .query(`
                INSERT INTO Patient(id_medecin, mot_de_passe, nomFamille, prenom, date_naissance, sexe, adresse_postale, adresse_electronique)
                VALUES (@id, @pwd, @nom, @prenom, @date_naissance, @sexe, @adresse_postale, @adresse_electronique)
            `);

        res.json({ message: "Patient ajouté" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- PATIENTS ----------
app.get("/api/patients", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request().query("SELECT * FROM Patient");
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/patients/:id", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input("id", sql.VarChar, req.params.id)
            .query("SELECT * FROM Patient WHERE id_patient = @id");
        res.json(result.recordset[0] || null);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/patients", async (req, res) => {
    const { id_patient, mot_de_passe, nomFamille, prenom,date_naissance, sexe, adresse_postale, adresse_electronique, fk_aide_soignant, fk_medecin_traitant } = req.body;

    try {
        const pool = await getPool();
        await pool.request()
            .input("id", sql.VarChar, id_patient)
            .input("pwd", sql.VarChar, mot_de_passe)
            .input("nom", sql.VarChar, nomFamille)
            .input("prenom", sql.VarChar, prenom)
            .input("date_naissance", sql.Date, date_naissance)
            .input("sexe", sql.VarChar, sexe)
            .input("adresse_postale", sql.VarChar, adresse_postale)
            .input("adresse_electronique", sql.VarChar, adresse_electronique)
            .input("fkaso", sql.VarChar, fk_aide_soignant)
            .input("fkmed", sql.VarChar, fk_medecin_traitant)
            .query(`
                INSERT INTO Patient( id_patient, mot_de_passe, nomFamille, prenom,date_naissance, sexe, adresse_postale, adresse_electronique, fk_aide_soignant, fk_medecin_traitant)
                VALUES (@id, @pwd, @nom, @prenom, @date_naissance, @sexe, @adresse_postale, @adresse_electronique, @fkaso, @fkmed)
            `);

        res.json({ message: "Patient ajouté" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- PRESCRIPTIONS ----------
app.get("/api/prescriptions/:patientId", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input("idp", sql.VarChar, req.params.patientId)
            .query("SELECT * FROM Prescription WHERE id_patient = @idp ORDER BY date_prescription DESC");

        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post("/api/prescriptions", async (req, res) => {
    const { id_patient, id_medecin, date_prescription, commentaire } = req.body;

    try {
        const pool = await getPool();
        await pool.request()
            .input("idp", sql.VarChar, id_patient)
            .input("idm", sql.VarChar, id_medecin)
            .input("date", sql.Date, date_prescription)
            .input("com", sql.VarChar, commentaire)
            .query(`
                INSERT INTO Prescription(id_patient, id_medecin, date_prescription, commentaire)
                VALUES (@idp, @idm, @date, @com)
            `);

        res.json({ message: "Prescription ajoutée" });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ---------- MEDOC PATIENT ----------
app.get("/api/medocs/:patientId", async (req, res) => {
    try {
        const pool = await getPool();
        const result = await pool.request()
            .input("id", sql.VarChar, req.params.patientId)
            .query("SELECT * FROM MedocPatient WHERE fk_patient = @id");

        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// =====================
// HEALTHCHECK
// =====================
app.get("/health", (req, res) => res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on port ${port}`));
