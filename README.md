
# Azure Node.js API

This repository contains the source code for the Cloud API used in the IoT architecture. It is built with Node.js and Express, designed to be deployed on Azure App Service. It handles data persistence using Azure SQL Database and provides REST endpoints for the IoT Gateway and frontend applications.

## Project Overview

* **Runtime**: Node.js (v20 LTS recommended)
* **Database**: Azure SQL (MSSQL)
* **Deployment**: Azure App Service (Linux)
* **CI/CD**: GitHub Actions

## Prerequisites

Before deploying, ensure you have the following:

* **Azure Subscription**: To create App Services and SQL Databases.
* **GitHub Account**: To host the repository and run GitHub Actions.
* **Node.js & npm**: For local development and testing.

## Local Installation

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/sae-iot-api.git
cd sae-iot-api

```


2. **Install dependencies:**
```bash
npm install

```


3. **Run locally:**
   To run the server locally, you must configure a `.env` file with valid database credentials.
```bash
npm start

```


4. **Run tests:**
```bash
npm test

```



## Configuration

The application relies on environment variables to connect to the database and secure endpoints. These must be configured in the Azure App Service settings.

### Required Environment Variables

| Variable Name | Description | Example Value |
| --- | --- | --- |
| `DB_SERVER` | The hostname of the Azure SQL Server. | `sae-sql-server.database.windows.net` |
| `DB_NAME` | The name of the specific database. | `sae-db` |
| `DB_USER` | The admin username for SQL authentication. | `dbadmin` |
| `DB_PWD` | The password for the SQL user. | `SecurePassword123!` |
| `API_KEY` | A secret key to secure restricted endpoints. | `your_generated_api_key` |
| `PORT` | The port the server listens on (Azure sets this automatically). | `8080` |

## Deployment Guide

### 1. Database Setup (Azure Portal)

1. Create a new **SQL Database** resource in Azure.
2. Configure the **SQL Server** with SQL Authentication (User/Password).
3. In the "Networking" settings of the SQL Server, enable the option **"Allow Azure services and resources to access this server"**. This allows the App Service to connect to the database.

### 2. App Service Setup

1. Create a new **Web App** in Azure.
2. Select **Publish: Code**, **Runtime: Node 20 LTS**, and **OS: Linux**.
3. Navigate to **Settings > Environment variables** in the App Service menu.
4. Add all the variables listed in the "Configuration" section above.

### 3. CI/CD Pipeline (GitHub Actions)

This repository includes a GitHub Actions workflow file `.github/workflows/main_apidatabasesae.yml` configured to deploy automatically to Azure.

To enable it:

1. Download the **Publish Profile** from your Azure App Service "Overview" page.
2. Go to your GitHub repository **Settings > Secrets and variables > Actions**.
3. Create a new repository secret named `AZUREAPPSERVICE_PUBLISHPROFILE`.
4. Paste the content of the Publish Profile file as the value.
5. Ensure the `app-name` in `.github/workflows/main_apidatabasesae.yml` matches your Azure App Service name.

Any push to the `main` branch will now trigger a build and deployment.

## API Endpoints

The API exposes the following primary resources (subject to `API_KEY` verification in headers):

* **GET /api/health**: Returns the status of the API and database connection.
* **GET /api/patients**: Retrieves list of patients.
* **POST /api/prescriptions**: Adds a new prescription record.
* **POST /api/auth/login**: Authenticates users based on role (medecins, aidesoignants, patients).