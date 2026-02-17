# ⚡ CF Xray Proxy (Enhanced)

**High-Performance Cloudflare Worker Proxy for VLESS / VMESS / Trojan**

This project is a highly optimized, robust, and feature-rich Cloudflare Worker script designed to proxy traffic for Xray-core protocols (VLESS, VMESS, Trojan) over WebSocket/HTTPUpgrade transports. It acts as a smart load balancer and failover manager for your backend servers.

## 🚀 Key Features

*   **Smart Load Balancing:** Supports **Expected Weighted Round-Robin** and **Sticky Sessions** for distributing traffic among multiple backend servers.
*   **High Availability & Failover:** Automatically detects unhealthy backends and routes traffic to healthy ones.
*   **Real-Time Health Checks:** Built-in mechanism to actively ping backends and measure latency.
*   **Protocol Support:** Full support for **VLESS**, **VMESS**, and **Trojan** protocols over WebSocket (ws), HTTPUpgrade, and xhttp transports.
*   **Secure & Stealthy:** Configurable health check paths and the ability to hide backend URLs from public view.
*   **Rate Limiting:** Protect your backends with connection-based rate limiting per IP.
*   **Zero-Dependency Build:** Bundled into a single, efficient `worker.js` file using `esbuild`.

---

## 🛠️ Configuration (Environment Variables)

Customize the worker's behavior by setting these **Environment Variables** in your Cloudflare Worker settings.

| Variable Name | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| **`BACKEND_LIST`** | ✅ | - | **Main Configuration.** A comma-separated list of backend servers. <br>Format: `url` or `url|weight`. <br>Example: `https://s1.example.com, https://s2.example.com|5` |
| **`BACKEND_URL`** | ❌ | - | *Fallback.* Single backend URL if `BACKEND_LIST` is not provided. <br>Example: `https://my-vless-server.com` |
| **`HEALTH_PATH`** | ❌ | `/health` | **Security.** The path used to view server health and status. <br>Example: `/secret-status-page` |
| **`HIDE_BACKEND_URLS`** | ❌ | `true` | **Privacy.** If `true`, hides backend URLs in the `/health` output. Set to `false` to debug latency/connectivity. |
| **`BACKEND_HEALTH_CHECK_INTERVAL`** | ❌ | `30000` | How often (in ms) to check backend health (Active Probing). Default is 30 seconds. |
| **`MAX_RETRIES`** | ❌ | `3` | Number of times to retry a connection before giving up. |
| **`BACKEND_STICKY_SESSION`** | ❌ | `false` | If `true`, tries to keep a client connected to the same backend (useful for some banking/gaming apps). |
| **`DEBUG`** | ❌ | `false` | Enable verbose logging in Cloudflare Dashboard (Real-time Logs). |
| **`RATE_LIMIT_ENABLED`** | ❌ | `false` | Enable connection rate limiting per IP. |
| **`RATE_LIMIT_MAX_CONN_PER_IP`** | ❌ | `5` | Max concurrent connections allowed per client IP. |

---

## 📡 API Endpoints

### Health Check
Endpoint: **`YOUR_WORKER_URL/<HEALTH_PATH>`** (Default: `/health`)

Returns the current status of all backend servers.

**Example Response (when `HIDE_BACKEND_URLS=false`):**
```json
{
  "status": "ok",
  "timestamp": 1723456789000,
  "totalBackends": 2,
  "healthyBackends": 2,
  "backends": [
    {
      "url": "https://server1.example.com",
      "healthy": true,
      "latency": 45,
      "failureCount": 0
    },
    {
      "url": "https://server2.example.com",
      "healthy": true,
      "latency": 52,
      "failureCount": 0
    }
  ]
}
```

### Landing Page
By default, visiting the root `/` path redirects to `https://www.aparat.com` for stealth.

---

## 📦 Deployment

### Method 1: Manual Copy-Paste (Easiest)
1.  **Build:** Ensure you have the `worker.js` file (provided in this repo releases or built manually).
2.  **Cloudflare:** Go to your Worker -> **Quick Edit**.
3.  **Paste:** Copy the entire content of `worker.js` and paste it into the editor.
4.  **Save & Deploy.**
5.  **Configure:** Go to **Settings -> Variables** and add the required variables (at least `BACKEND_LIST`).

### Method 2: Using Wrangler (Developer)
1.  Install dependencies: `npm install`
2.  Build the worker: `npm run build` (This generates `worker.js`)
3.  Deploy: `npx wrangler deploy`

---

## 🧩 Protocols & Transports

This worker handles the following transport upgrades transparently:
*   `Upgrade: websocket`
*   `Upgrade: xhttp`
*   `Upgrade: httpupgrade`

Make sure your **Client** (V2RayNG, etc.) matches the **Server** (Backend) transport settings (usually `ws` or `httpupgrade`). The path (e.g., `/vless-ws`) in your client must match the path configured on your backend server.

---

**Disclaimer:** This project is for educational and research purposes only. Use responsibly.
