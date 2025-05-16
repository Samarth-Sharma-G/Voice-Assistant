# ☠️ One‑Piece Voice Assistant

> A Twilio **voice** bot that  
> – streams raw audio to your server,  
> – transcribes with Deepgram,  
> – enriches every turn with RAG (Weaviate + OpenAI),  
> – speaks back with Deepgram TTS,  
> – interrupts cleanly when the caller speaks, and  
> – escalates to a human agent on request while logging the hand‑off in MySQL.

---

## ✨ Features
|  |  |
|---|---|
| **Real‑time media** | Twilio `<Connect><Stream>` → WebSocket, no Functions. |
| **Retrieval‑Augmented** | FastAPI micro‑service rewrites the query, runs a Weaviate `nearText`, and feeds chunks into GPT. |
| **Interrupt‑safe TTS** | `assistantTalking` flag + `clear` event ⇒ never finishes the wrong answer. |
| **Escalation path** | GPT flag triggers `<Dial>` to `ESCALATION_NUMBER` and writes a row to RDS with the reason. |
| **Latency logs** | Per‑turn RAG / GPT / TTS / total timing in the console. |

---

## 🗂️ Project layout

```
.
├─ app.js                         # Node entry – Twilio media, GPT, TTS, RAG
├─ services/
│  ├─ gpt-service.js
│  ├─ rag-service.js              # thin HTTP client → FastAPI
│  ├─ stream-service.js
│  ├─ transcription-service.js
│  └─ tts-service.js
├─ services/RAG_service/          # Python FastAPI RAG micro‑service
│  ├─ app.py
│  ├─ __pycache__/
│  └─ requirements.txt
├─ .env
├─ package.json
└─ README.md
```

---

## 🚀 Quick start (local)

### 1 Clone & install

```bash
git clone https://github.com/your‑org/onepiece‑voice.git
cd onepiece‑voice

npm ci                           # Node deps
pip install -r services/RAG_service/requirements.txt
```

### 2 Create `.env`

```env
# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxx
SERVER=xxxxxx.ngrok-free.app              # public HTTPS URL

# OpenAI / Deepgram
OPENAI_API_KEY=sk-...
DEEPGRAM_API_KEY=...

# Weaviate
WEAVIATE_URL=https://xxxxx.weaviate.cloud
WEAVIATE_API_KEY=xxxxxxxx
WEAVIATE_CLASS=onepiece
RAG_TOP_K=5

# MySQL (RDS)
DB_HOST=clearcall.c50y02uk0yr3.us-east-2.rds.amazonaws.com
DB_USER=admin
DB_PASSWORD=clear4Call
DB_NAME=clearcall
DB_PORT=3306

# Escalation
ESCALATION_NUMBER=+18005551234
```

> **MySQL table**  
> ```sql
> CREATE TABLE IF NOT EXISTS human_escalation (
>   id INT AUTO_INCREMENT PRIMARY KEY,
>   caller_number VARCHAR(32) NOT NULL,
>   escalated_to  VARCHAR(32) NOT NULL,
>   reason        VARCHAR(255) NOT NULL,
>   created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
> );
> ```

### 3 Run both services

```bash
# terminal 1 – Node voice app
node app.js

# terminal 2 – FastAPI RAG
cd services/RAG_service
uvicorn app:app --host 0.0.0.0 --port 8001
```

### 4 Expose to Twilio

```bash
ngrok http 6969
# set Twilio Voice webhook → https://xxxx.ngrok-free.app/incoming
```

Call your Twilio number and try:  
*“Hi, can you tell me about returns? … Actually, can I talk to a human?”*

---

## 🐳 Docker (optional)

```bash
docker compose up --build
```

`docker-compose.yml` (not included here) would spin up:

* `voice-app` (Node :6969)  
* `rag-service` (FastAPI :8001)

---

## ☁️ Deploy

### Elastic Beanstalk (simple)

```bash
eb init --platform node.js
eb create onepiece‑voice‑env
eb deploy
```
Do the same for `services/RAG_service` or combine with a multi‑container Dockerrun.

### ECS Fargate (scalable)

1. Build & push both images to **ECR**  
2. Create two **Task Definitions**  
3. Put them behind an **ALB** (`/` → voice‑app, `/context` → rag‑service)  
4. Store secrets in **SSM Parameter Store** or **Secrets Manager**

---

## 📡 API reference

| Route | Service | Description |
|-------|---------|-------------|
| **POST /incoming** | Node | Twilio webhook → returns TwiML `<Connect><Stream>` |
| **WS /connection** | Node | Bidirectional media WebSocket |
| **POST /context**  | FastAPI | `{question,history,caller_number,escalated_to}` ⇒ `{context,is_escalation}` |

---

## 📝 License
MIT © 2025 Samarth Sharma
