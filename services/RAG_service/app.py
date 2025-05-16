"""
FastAPI RAG micro-service
───────────────────────────────────────────────────────────────
POST /context
{
  "question":        "<caller utterance>",
  "history":         "Complete userContext so far",
  "caller_number":   "+15551234567",      # optional
  "escalated_to":    "+18005559876",      # optional
  "k":               4                    # optional
}

Returns
{
  "context":        "<chunk1>\n---\n<chunk2>...",
  "is_escalation":  false                 # true ⇒ Node app should <Dial>
}
"""
import os, json, mysql.connector, logging
from typing import List, Optional
from fastapi import FastAPI
from pydantic import BaseModel
import openai, weaviate
from weaviate.classes.init import Auth
import dotenv, colorama
from colorama import Fore, Style

colorama.init(autoreset=True)
dotenv.load_dotenv(dotenv.find_dotenv())
log = logging.getLogger("rag")

# ── env vars ──────────────────────────────────────────────────
openai.api_key   = os.getenv("OPENAI_API_KEY")

WEAVIATE_URL     = os.getenv("WEAVIATE_URL")
WEAVIATE_API_KEY = os.getenv("WEAVIATE_API_KEY")
VECTOR_CLASS     = os.getenv("WEAVIATE_CLASS")
DEFAULT_K        = int(os.getenv("RAG_TOP_K", 4))

DB_CONF = dict(
    host     = os.getenv("DB_HOST"),
    user     = os.getenv("DB_USER"),
    password = os.getenv("DB_PASSWORD"),
    database = os.getenv("DB_NAME"),
    port     = int(os.getenv("DB_PORT", 3306)),
)

# ── Weaviate client (single instance) ─────────────────────────
client = weaviate.connect_to_weaviate_cloud(
    cluster_url      = WEAVIATE_URL,
    headers          = {"X-OpenAI-Api-Key": openai.api_key},
    auth_credentials = Auth.api_key(api_key=WEAVIATE_API_KEY),
)

app = FastAPI()

# ── request / response schema ─────────────────────────────────
class RagRequest(BaseModel):
    question:        str
    history:         Optional[str] = None
    caller_number:   Optional[str] = None
    escalated_to:    Optional[str] = None
    k:               Optional[int] = None

class RagResponse(BaseModel):
    context:        str
    is_escalation:  bool

# ── helper #1: rewrite + detect escalation in ONE call ───────
def rewrite_and_detect(question: str, history: Optional[str]) -> tuple[str, bool]:
    fn = {
        "name": "process_query",
        "description": "Rewrite follow-up and flag escalation intent.",
        "parameters": {
            "type": "object",
            "properties": {
                "rewritten_query": { "type": "string" },
                "is_escalation":   { "type": "boolean" }
            },
            "required": ["rewritten_query", "is_escalation"]
        }
    }

    msgs = [
        { "role": "system",
          "content":
          "Return a standalone rewritten question - basically rewrite the question so it now has no indirect references and is independent from the history."
          "Also a boolean esclation flag: False by Default. In case human exclusively states they want to interact with an human or need an esclation - only then True.  I want to make myself very clear it shouldn't be that you feel the customer needs human help and you mark True - but them explicitly asking for human help or esclation to a human. Focus, this is an important decision" },
        { "role": "user",
          "content": f"History:\n{history or '[none]'}\n\nLatest:\n{question}" }
    ]

    resp = openai.chat.completions.create(
        model="gpt-4o",
        messages=msgs,
        functions=[fn],
        function_call={"name": "process_query"},
        temperature=0,
    )
    args = json.loads(resp.choices[0].message.function_call.arguments)
    rewritten, esc = args["rewritten_query"].strip(), bool(args["is_escalation"])
    print(f"{Fore.CYAN}Rewritten →{Style.RESET_ALL} {rewritten}")
    print(f"{Fore.CYAN}Escalation? →{Style.RESET_ALL} {esc}")
    return rewritten, esc

# ── helper #2: extract tags for vector search ─────────────────
def extract_tags(query: str) -> List[str]:
    prompt = ("Extract 3-7 concise keywords (comma-separated, no extra text) "
              "that best represent this query:\n\n" + query)
    resp   = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
    )
    tags = [t.strip() for t in resp.choices[0].message.content.split(",") if t.strip()]
    print(f"{Fore.CYAN}Tags →{Style.RESET_ALL} {tags}")
    return tags

# ── helper #3: Weaviate search ───────────────────────────────
def retrieve(tags: List[str], k: int) -> List[str]:
    try:
        res = client.collections.get(VECTOR_CLASS).query.near_text(tags, limit=k)
        chunks = [obj.properties["text"] for obj in res.objects]
        print(f"{Fore.CYAN}Retrieved {len(chunks)} chunks{Style.RESET_ALL}")
        return chunks
    except Exception as e:
        log.error("Weaviate query error: %s", e)
        return []

# ── helper #4: generate conversation summary and escalation reason ────────
def make_reason(text: str) -> str:
    resp = openai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system",
             "content": "Given a conversation transcript, provide a structured summary in the format:\n"
                       "CONVERSATION: Brief 1-2 line overview of what was discussed\n"
                       "ESCALATION: Specific reason why the customer wants human assistance"},
            {"role": "user", "content": text}  # Using full text, not truncated
        ],
        temperature=0
    )
    return resp.choices[0].message.content.strip()

# ── helper #5: write escalation row --------------------------
def write_escalation(caller: str, to: str, reason: str):
    try:
        with mysql.connector.connect(**DB_CONF) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO human_escalation "
                    "(caller_number, escalated_to, reason) VALUES (%s, %s, %s)",
                    (caller, to, reason)
                )
                conn.commit()
    except mysql.connector.Error as e:
        log.error("DB insert failed: %s", e)

# ── main endpoint ────────────────────────────────────────────
@app.post("/context", response_model=RagResponse)
def get_context(req: RagRequest):
    print(f"[DEBUG] Incoming RAG request: {dict(req)}")
    print(f"[DEBUG] caller_number: {req.caller_number}")
    k = req.k or DEFAULT_K

    rewritten, is_escalation = rewrite_and_detect(req.question, req.history)

    if is_escalation:
        # generate reason && insert row
        reason = make_reason(req.history or req.question)
        write_escalation(
            caller = req.caller_number or "unknown",
            to     = req.escalated_to or "unknown",
            reason = reason
        )
        return RagResponse(context="", is_escalation=True)

    tags    = extract_tags(rewritten)
    chunks  = retrieve(tags, k)
    context = "\n---\n".join(chunks)
    return RagResponse(context=context, is_escalation=False)
