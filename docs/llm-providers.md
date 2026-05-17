# Use a different LLM

OpenMemo only needs `/v1/chat/completions` and `/v1/embeddings`. Any
provider that exposes both works. Swap the four `LLM_*` lines in
`.env` and re-run `./scripts/setup.sh`.

| Provider | `LLM_BASE_URL` | `LLM_CHAT_MODEL` | `LLM_EMBED_MODEL` | `LLM_EMBED_DIMENSIONS` | Free? |
|---|---|---|---|---|---|
| **DeepSeek** *(default)* | `https://api.deepseek.com` | `deepseek-chat` | `deepseek-embed` | `1536` | starter credit |
| OpenAI | `https://api.openai.com` | `gpt-4o-mini` | `text-embedding-3-small` | `1536` | trial credit |
| Together | `https://api.together.xyz` | `meta-llama/Llama-3.1-70B-Instruct-Turbo` | `togethercomputer/m2-bert-80M-32k-retrieval` | `768` | $1 free |
| Groq | `https://api.groq.com/openai` | `llama-3.1-70b-versatile` | use a separate embedder | n/a | generous free tier |
| Mistral | `https://api.mistral.ai` | `mistral-large-latest` | `mistral-embed` | `1024` | free trial |
| OpenRouter | `https://openrouter.ai/api` | `meta-llama/llama-3.1-70b-instruct` | use a separate embedder | n/a | many free models |

Anything else with an OpenAI-style endpoint works too — Anyscale,
Fireworks, local Ollama (`http://localhost:11434/v1`).

If `LLM_EMBED_DIMENSIONS` is not 1536, widen the column once before
the first deploy:

```sql
ALTER TABLE memory_bubble ALTER COLUMN embedding TYPE vector(NEW_SIZE);
DROP INDEX IF EXISTS memory_bubble_embedding_idx;
CREATE INDEX memory_bubble_embedding_idx
  ON memory_bubble USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL;
```
