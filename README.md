# Novita Router

High-availability OpenAI-compatible HTTP proxy, multi-key failover pool, and Cloud Code Sandbox gateway for **Novita AI**, paired with a lightweight mobile-first **Dark Calmed Neo-Brutalism** Control Center.

Built with zero external Node.js framework dependencies — runs directly on native `node:http` / `node:https` + Python `novita-sandbox`.

---

## Fitur Utama

- **OpenAI-Compatible Gateway (`/v1/*`)**: Mendukung `/v1/chat/completions`, `/v1/models`, dan `/v1/embeddings` (termasuk streaming SSE). Bisa langsung dicolok ke Cursor, OpenAI SDK, LangChain, atau WebUI apa pun.
- **Multi-Key Pool & Auto-Failover**: Kelola banyak akun/API key Novita AI sekaligus, sinkronisasi saldo otomatis tiap 2 menit, rotasi key berdasarkan penggunaan terbaru, dan cooldown otomatis 60 detik saat terkena rate limit (`429`).
- **Katalog Model Live (`Models Tab`)**: Mengambil 99+ model aktif langsung dari upstream Novita (cached 10 menit) dengan pencarian instan, filter kategori (`DeepSeek`, `LLaMA`, `Qwen`, `Kimi`, `GLM`), tombol salin ID, dan tes latensi langsung.
- **Managed Client API Keys (`nr_live_...`)**: Buat, pantau jumlah request, dan cabut (revoke) API key klien secara terpisah tanpa mengekspos master key Novita ke aplikasi luar.
- **Cloud Sandbox Execution (`/api/sandbox/run`)**: Eksekusi kode Python di microVM cloud Novita AI via web dashboard maupun REST API.
- **Keamanan Berlapis (`Security Tab`)**:
  - **IP Allowlist** dengan deteksi IP klien otomatis (`CF-Connecting-IP` / `X-Forwarded-For` / socket) dan whitelist 1-klik.
  - **In-Memory Rate Limiter** per IP dengan batas request/menit yang bisa diubah live.
  - **Admin Password & Cookie/Bearer Auth** dengan rotasi password langsung dari dashboard tanpa restart.

---

## Struktur File

```
novita-router/
├── server.js                  # Core HTTP proxy, auth, rate limit, key pool & API routes
├── run_sandbox.py             # Runner eksekusi microVM Python via novita-sandbox SDK
├── public/
│   └── index.html             # Web Control Center (Overview, Models, Keys, Security, Sandbox, Logs)
├── keys.example.json          # Contoh daftar API key upstream Novita AI
├── security.example.json      # Contoh konfigurasi IP allowlist, rate limit & password
├── managed_keys.example.json  # Contoh storage managed client keys
├── package.json
└── requirements.txt           # Dependensi Python (novita-sandbox)
```

---

## Cara Install & Menjalankan

### 1. Prasyarat
- Node.js v18+
- Python 3.10+ (opsional jika ingin menggunakan fitur Cloud Sandbox)

### 2. Clone & Siapkan Konfigurasi
```bash
git clone https://github.com/rndsa/novita-router.git
cd novita-router

cp keys.example.json keys.json
cp security.example.json security.json
cp managed_keys.example.json managed_keys.json
```

Edit `keys.json` dengan API key Novita AI milikmu (atau set lewat environment variable `NOVITA_KEYS`), dan ubah `adminPassword` di `security.json`:
```bash
# Opsional: install SDK sandbox jika pakai fitur Cloud Sandbox
pip install -r requirements.txt
```

### 3. Jalankan Server
```bash
# Langsung via Node.js
PORT=8181 node server.js

# Atau via PM2 untuk production
pm2 start server.js --name novita-router
```

Buka dashboard di `http://127.0.0.1:8181` (atau domain reverse proxy milikmu).

---

## Environment Variables (Opsional)

| Variable | Default | Deskripsi |
|---|---|---|
| `PORT` | `8181` | Port HTTP server lokal |
| `ROUTER_USER` | `admin` | Username untuk HTTP Basic Auth |
| `ROUTER_PASS` | `change-this-password` | Password awal admin (ditimpa `security.json` jika ada) |
| `API_TOKEN` | `change-this-api-token` | Custom Bearer token untuk `/v1/*` saat API Guard aktif |
| `NOVITA_KEYS` | *(kosong)* | Daftar API key Novita dipisahkan koma (opsional pengganti `keys.json`) |

---

## Penggunaan API

### 1. OpenAI SDK (Python)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8181/v1",
    api_key="nr_live_..."  # Generate dari tab Keys di dashboard
)

res = client.chat.completions.create(
    model="deepseek/deepseek-v4.1-flash",
    messages=[{"role": "user", "content": "Halo!"}]
)
print(res.choices[0].message.content)
```

### 2. Cloud Sandbox API (`POST /api/sandbox/run`)
```bash
curl -X POST http://127.0.0.1:8181/api/sandbox/run \
  -H "Authorization: Bearer nr_live_..." \
  -H "Content-Type: application/json" \
  -d '{"code": "import sys; print(sys.version)"}'
```

---

## Lisensi

MIT — by ren
