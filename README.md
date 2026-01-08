Here is the neutral version of the **README.md** for your Raspberry Pi server, with all emojis removed.

---

# IoT Gateway Server (Raspberry Pi)

This project acts as the central gateway for the SAE IoT architecture. It runs on a Raspberry Pi using **Docker** and orchestrates communication between ESP32 sensors (LoRa/WiFi), the external database (Azure), and the frontend dashboard (Aide-Soignants).

## Features

* **Node.js API:** Handles business logic, alerts, and database synchronization.
* **MQTT Broker (Mosquitto):** Receives real-time data from sensors.
* **WebSocket Server:** Pushes live alerts to the frontend interface.
* **Monitoring Stack:** Prometheus & Grafana for server health visualization.
* **Secure Tunneling:** Ngrok for external access (optional).

## Prerequisites

* **Hardware:** Raspberry Pi 3B+, 4, or 5 (Recommended: 4GB RAM for Grafana).
* **OS:** Raspberry Pi OS (64-bit Lite recommended).
* **Software:**
* Git
* Docker & Docker Compose



## Installation Guide

### 1. Clone the Repository

```bash
git clone https://github.com/matlacheny/sae-s5-but3-iot-g2-api.git
cd sae-s5-but3-iot-g2-api

```

### 2. Configure Environment Variables

Create a `.env` file in the root directory to store your secrets.

```bash
nano .env

```

**Required Variables:**

```ini
# Server Configuration
PORT=3200
NODE_ENV=production

# Security
API_KEY=your_secure_api_key_here

# Services Connection
MQTT_URL=mqtt://mosquitto:1883
API_BASE_URL=https://your-azure-db-api.azurewebsites.net/api

# External Services (GitHub Gist for dynamic config)
GIST_ID=your_gist_id
GITHUB_TOKEN=your_github_token

```

### 3. Create Service Configurations

The Docker stack requires specific config files for Mosquitto and Prometheus.

**A. Mosquitto Config**

```bash
mkdir -p mosquitto/config
nano mosquitto/config/mosquitto.conf

```

*Content:*

```text
listener 1883
allow_anonymous true

```

**B. Prometheus Config**

```bash
nano prometheus.yml

```

*Content:*

```yaml
global:
  scrape_interval: 5s
scrape_configs:
  - job_name: 'iot-api'
    static_configs:
      - targets: ['app:3200']

```

### 4. Create the Docker Compose File

If not already present, create the `docker-compose.yml` file to define the stack.

```bash
nano docker-compose.yml

```

*(Paste the full Docker Compose configuration defined in the documentation, including services for `app`, `mosquitto`, `prometheus`, `grafana`, `ngrok`, and `watchtower`)*.

---

## Usage

### Start the Server

Run the entire stack in the background:

```bash
docker compose up -d --build

```

### Check Logs

To see the logs of the main Node.js application:

```bash
docker logs -f saeiotserver

```

*Expected Output:* `HTTP server running on port 3200` & `Connected to MQTT broker`.

### Stop the Server

```bash
docker compose down

```

---

## Monitoring & Access

| Service | Local URL | Description |
| --- | --- | --- |
| **API** | `http://<PI_IP>:3200` | Main backend endpoints. |
| **Grafana** | `http://<PI_IP>:3000` | Dashboard (Default login: `admin` / `admin`). |
| **Prometheus** | `http://<PI_IP>:9090` | Raw metrics data. |
| **Mosquitto** | `tcp://<PI_IP>:1883` | MQTT Broker for sensors. |

---

## API Endpoints

The server exposes several endpoints for management and data retrieval:

* **`GET /api/health`**: Check server status and MQTT connection.
* **`POST /api/auth/login`**: Authenticate users (Doctors, Nurses).
* **`GET /api/clients`**: List active WebSocket clients (Aide-Soignants).
* **`POST /api/send-alert`**: Manually trigger an alert box notification.
* **`GET /metrics`**: Prometheus metrics endpoint.

## Automatic Updates

The stack includes **Watchtower**. It automatically checks for new Docker images of the API every 60 seconds and updates the container if a new version is pushed to DockerHub (`matlacheny/saeiotserver:latest`).