# Generic Database and Document MCP Server

A local MCP-based application where an AI agent can inspect, query, and safely manipulate configured databases plus uploaded Excel, CSV, PDF, Word, text, Markdown, and JSON files.

## Prerequisites

1.  **Node.js**: v18+
2.  **Python**: 3.10+
3.  **MongoDB**: Installed and running locally on port 27017.
4.  **Ollama**: Installed locally with the `llama3.2:1b` model downloaded (`ollama run llama3.2:1b`).

## Architecture
-   **Frontend**: React + Vite + TailwindCSS + Recharts
-   **Backend**: Node.js + Express.js + Mongoose + MCP Agent System
-   **Analytics Service**: Python + FastAPI + Pandas
-   **AI**: Local Ollama (`llama3.2:1b` by default)

## Setup Instructions

### 1. Backend Setup
```bash
cd backend
npm install
# Optional: node seed.js loads the included sample MongoDB data.
# Optional: npm run seed:sales creates the sales_demo_mcp demo database.
```

### 2. Analytics Service Setup
```bash
cd analytics-service
python -m venv venv
# On Windows
.\venv\Scripts\activate
# On Mac/Linux
source venv/bin/activate

pip install -r requirements.txt # or install fastapi uvicorn pandas pymongo
```

### 3. Frontend Setup
```bash
cd frontend
npm install
```

## Running the Application

You can use the provided `start.bat` on Windows, or run these commands in separate terminals:

1.  **MongoDB**: Ensure your local MongoDB server is running.
2.  **Ollama**: Ensure Ollama is running (`ollama serve`).
3.  **Analytics Service**:
    ```bash
    cd analytics-service
    .\venv\Scripts\activate
    uvicorn app:app --reload --port 8000
    ```
4.  **Backend**:
    ```bash
    cd backend
    npm start
    ```
5.  **Frontend**:
    ```bash
    cd frontend
    npm run dev
    ```

## Giving Database Access Without Editing JSON

Use the web UI when the user does not know how to edit `mcp.databases.json`.

1.  Start the backend and frontend.
2.  Open the app in the browser.
3.  Go to **Database Access** in the sidebar.
4.  Fill in:
    -   **Connection ID**: a short name like `sales-db`
    -   **Database Type**: MongoDB, PostgreSQL, MySQL, or SQLite
    -   **Connection URI** or SQLite file path
    -   **Description**
5.  Click **Test Connection**.
6.  Click **Save Access**.

The app tests the connection, inspects collections/tables, estimates available rows where possible, then writes the connection to `mcp.databases.json` and refreshes the MCP database registry. If the connection fails, it is not saved. If the database is empty, it is saved with a warning so you can add data later. After saving, the user can ask:

```text
what databases can you access
describe the schema for sales-db
how many rows are in sales-db
```

For a safe editable copy of any configured database:
1.  Click **Snapshot** beside the connection in **Database Access**.
2.  The backend exports a capped local original snapshot to `database-store/originals`.
3.  The backend creates an editable working snapshot in `database-store/working`.
4.  Use **Original** to download the untouched snapshot and **Updated** to download the working snapshot.

The snapshot workflow works across MongoDB, PostgreSQL, MySQL, and SQLite connections when their adapters are available. It is a local JSON working copy, so changes do not hit the live database unless you explicitly use live database write tools.

## Giving Document Access

Use **Document Access** when the user has files instead of a database.

Supported uploads:
-   Excel: `.xlsx`, `.xls`
-   CSV: `.csv`
-   PDF: `.pdf`
-   Word: `.docx`
-   Text/Markdown/JSON: `.txt`, `.md`, `.json`

Workflow:
1.  Start the backend and frontend.
2.  Open **Document Access** in the sidebar.
3.  Upload the file.
4.  The backend stores two local copies:
    -   an untouched original copy in `document-store/originals`
    -   an editable working copy in `document-store/working`
5.  The agent and MCP clients can use document tools/resources.

Document MCP tools:
-   `document.list_sources`
-   `document.describe`
-   `document.search`
-   `document.query_table`
-   `document.answer_table_question`
-   `document.preview_update_cell`
-   `document.update_cell`
-   `document.add_row`
-   `document.delete_rows`

Document MCP resources:
-   `document://{documentId}/metadata`
-   `document://{documentId}/sheets/{sheetName}`
-   `document://{documentId}/chunks/{chunkIndex}`

Excel and CSV files are treated as tables. PDF, Word, text, and Markdown files are treated as searchable text chunks.

Example questions:
```text
what documents are uploaded
search documents for payment terms
describe document sales-data-...
show rows from the uploaded sales sheet
what is the product on date 02-03-2023
change product on date 02-03-2023 to Snacks
confirm
```

For Excel and CSV manipulation, the chat agent follows a safe workflow:
1.  You ask for a change.
2.  The agent calls `document.preview_update_cell` and shows the rows that will change.
3.  Nothing is changed until you reply `confirm`.
4.  Reply `cancel` to discard the pending change.

The document write tools update the local MCP working copy stored under `document-store/working`. The original copy in `document-store/originals` is kept unchanged. In **Document Access**, use **Original** to download the untouched file and **Updated** to download the working copy with confirmed edits. By default, large accidental edits are blocked after 100 matched rows. Change that with `MCP_DOCUMENT_MAX_MUTATION_ROWS`.

## Testing the MCP AI Agent

Go to the **Agent** page and try generic database or document queries:
-   "What databases can you access?"
-   "Describe the schema for default"
-   "How many rows are in default?"
-   "What documents are uploaded?"
-   "What is the product on date 02-03-2023?"
-   "Change product on date 02-03-2023 to Snacks"

Run the regression checks for the known MongoDB query patterns:
```bash
cd backend
npm run test:agent
```

This verifies prefixed ids such as `RET-00002`, `PRD-0020`, and `CUST-0001`, product-name filters, counts, and cricket demo field lookups against the local demo databases.

## Generic Database MCP Server

The backend includes a generic database MCP server built with the official `@modelcontextprotocol/sdk`. It is not tied to e-commerce data: the MCP server reads database access from configuration, exposes tools/resources/prompts, and lets MCP clients discover schemas before querying.

Official MCP transports:
-   **stdio**: `cd backend && npm run mcp:stdio`
-   **Streamable HTTP**: start the backend with `npm start`, then connect MCP clients to `http://localhost:5000/mcp`

The React chat UI uses `/api/mcp/chat` as an in-app MCP client facade. The official MCP server for external MCP clients is exposed through `npm run mcp:stdio` and `/mcp`.

Proper MCP workflow:
```text
MCP client initializes the server
-> client lists tools, resources, and prompts
-> client selects a database or document source
-> client reads schema/metadata resource or calls describe
-> model plans a safe structured tool call
-> MCP tool executes against the database/document
-> tool returns structured content
-> model formats the final answer for the user
```

Database question workflow:
```text
User question
-> database.list_connections when source is unknown
-> database.describe or database://{databaseId}/schema
-> safe plan: find, count, distinct, aggregate, or snapshot edit preview
-> database.query / snapshot tool
-> structured rows/counts/values
-> final Answer + Details response
```

Document question workflow:
```text
User question
-> document.list_sources when source is unknown
-> document.describe or document://{documentId}/metadata
-> document.answer_text_question for PDF/Word/text
-> document.answer_table_question or document.query_table for Excel/CSV
-> structured evidence/rows
-> final Answer + Details response
```

The Agent page shows this workflow trace under each answer so you can verify which MCP stage and tool were used.

Core MCP tools:
-   `database.list_connections`
-   `database.describe`
-   `database.count_rows`
-   `database.query`
-   `database.write`
-   `database.create_snapshot`
-   `database.list_snapshots`
-   `database.query_snapshot`
-   `database.preview_snapshot_update`
-   `database.update_snapshot_rows`
-   `database.add_snapshot_row`
-   `database.delete_snapshot_rows`
-   `document.list_sources`
-   `document.describe`
-   `document.search`
-   `document.query_table`
-   `document.answer_table_question`
-   `document.preview_update_cell`
-   `document.update_cell`
-   `document.add_row`
-   `document.delete_rows`

MCP resources:
-   `database://{databaseId}/schema`
-   `database://{databaseId}/collections/{collection}`

MCP prompts:
-   `database-investigate`
-   `document-investigate`

Prompt layer:
-   Corrects common typos and shorthand before tool selection, for example `prodcut`, `qty`, `cust name`, and `payement`.
-   Extracts keywords, dates, comparison filters, and intent hints from the user's prompt.
-   Optional **AI assist** mode sends the corrected prompt to Llama first so messy questions can be rewritten into clearer database/document queries before MCP tool selection.
-   For MongoDB, **AI assist** asks Llama to create a safe read-only extraction prompt/query plan from the selected schema. MongoDB executes that plan, then the extracted result is sent back to Llama for a professional final answer.
-   Passes the corrected prompt plus keyword plan to the Llama chat layer when the deterministic MCP tools need LLM help.
-   Formats final chat responses with `Answer`, `Details`, and `Next` sections where useful.

Useful chat queries:
-   "What databases can you access?"
-   "Describe the schema for default"
-   "Show 5 rows from the customers collection in default"
-   "How many documents are in the users collection?"
-   "Group orders by city and sum totalAmount"
-   "Count orders by status"
-   "Show total sales by city"
-   "Top 5 products by quantity"
-   "Average amount by state where status is completed"

Environment configuration:
```bash
OLLAMA_MODEL=llama3.2:1b
OLLAMA_FALLBACK_MODEL=llama3.2:1b
OLLAMA_NUM_CTX=768
OLLAMA_NUM_PREDICT=256
OLLAMA_API_URL=http://localhost:11434/api/generate
MCP_LLM_PROMPT_ENHANCER=false
MCP_PROMPT_ENHANCER_TIMEOUT_MS=6000
MCP_LLM_MONGO_PLANNER=false
MCP_MONGO_PLANNER_TIMEOUT_MS=8000
MCP_MONGO_FINAL_ANSWER_TIMEOUT_MS=8000
MCP_MONGO_FINAL_NUM_PREDICT=512
MONGO_URI=mongodb://localhost:27017/ai-ecommerce
MONGO_DB_NAME=ai-ecommerce
MCP_DATABASES_FILE=../mcp.databases.json
MCP_DEFAULT_DATABASE_ID=default
MCP_DB_DEFAULT_LIMIT=20
MCP_DB_MAX_LIMIT=100
MCP_ALLOW_DB_WRITES=false
MCP_DATABASE_SNAPSHOT_ROW_LIMIT=1000
MCP_DATABASE_SNAPSHOT_MAX_MUTATION_ROWS=1000
MCP_DOCUMENT_MAX_MUTATION_ROWS=100
```

The Agent page has an **AI assist** checkbox. For MongoDB, the backend now prefers the trusted schema extractor first. If the schema match is strong, the backend directly creates the safe `find`, `count`, `distinct`, or `aggregate` query. If the schema match is not strong enough, Llama must return the `mongo-extraction-v1` JSON contract, then the backend validates it before any MCP tool is executed.

Mongo extraction workflow:
```text
User question
-> prompt cleanup / keyword detection
-> trusted backend extractor when fields and filters match the schema
-> otherwise Llama returns mongo-extraction-v1 JSON
-> backend validates collection, fields, filters, operation, and read-only safety
-> MCP tool database.query executes MongoDB
-> exact MongoDB result
-> final answer formatter
-> user
```

Mongo extraction plan format:
```json
{
  "version": "mongo-extraction-v1",
  "extractionPrompt": "one precise sentence describing exactly which MongoDB records/values to extract",
  "intent": {
    "answerType": "single_value | row_list | count | distinct_values | aggregate",
    "requestedFields": ["fields needed in the final answer"],
    "filterFields": ["fields used to restrict rows"],
    "reason": "short reason for choosing the collection and operation"
  },
  "mongoQuery": {
    "collection": "one collection from schema",
    "operation": "find | count | distinct | aggregate",
    "filter": {},
    "projection": {},
    "sort": {},
    "field": "field for distinct only",
    "pipeline": [],
    "limit": 20
  },
  "response": {
    "answerFields": ["fields the final answer must include"],
    "includeTable": false,
    "format": "Answer / Details / Next"
  }
}
```

Full examples are in `docs/mongo-extraction-format.md`.

Database access configuration:
1.  Copy `mcp.databases.example.json` to `mcp.databases.json`.
2.  Add the database connections you want the MCP server to access.
3.  Keep `MCP_ALLOW_DB_WRITES=false` unless you explicitly want mutation tools enabled.

For the Python analytics service, the database comes from `MONGO_DB_NAME` or the database name inside `MONGO_URI`. For example:
```powershell
$env:MONGO_URI="mongodb://localhost:27017/my_new_database"
$env:MONGO_DB_NAME="my_new_database"
uvicorn app:app --reload --port 8000
```

## Data Manipulation Rules

The server is read-only by default for real databases. To allow database writes, set:
```powershell
$env:MCP_ALLOW_DB_WRITES="true"
```

Database snapshots can be edited safely without touching the live database. Supported snapshot edits:
-   update a field across matched rows/documents
-   add a row/document
-   delete rows/documents by row index or filters

For destructive database snapshot tools, always inspect first:
```text
database.create_snapshot -> database.preview_snapshot_update -> user confirms -> database.update_snapshot_rows
```

Document tables can be edited through MCP tools and through the chat confirmation flow. Supported document edits:
-   update a cell/column value across matched rows
-   add a new row
-   delete rows by row index or filters

For destructive document tools, always inspect first:
```text
document.preview_update_cell -> user confirms -> document.update_cell
```

MongoDB works with the dependencies already in this project. PostgreSQL, MySQL, and SQLite entries can be declared in the config, but their runtime drivers still need to be added before those adapters can execute real queries: `pg` for PostgreSQL, `mysql2` for MySQL, and `better-sqlite3` for SQLite.

Example MCP client configuration for stdio:
```json
{
  "mcpServers": {
    "database-mcp": {
      "command": "node",
      "args": [
        "C:/Users/USER/OneDrive/Desktop/Peojects/Rag_project/backend/mcp-stdio.js"
      ],
      "env": {
        "MONGO_URI": "mongodb://localhost:27017/ai-ecommerce",
        "MCP_ALLOW_DB_WRITES": "false"
      }
    }
  }
}
```

The React chat assistant uses Llama by default:
```bash
ollama pull llama3.2:1b
```

Then restart the backend. You can also start the backend with:
```powershell
$env:OLLAMA_MODEL="llama3.2:1b"
$env:OLLAMA_FALLBACK_MODEL="llama3.2:1b"
$env:OLLAMA_NUM_CTX="512"
npm start
```

If Ollama reports that the model needs more memory than is available, keep using the deterministic MCP tools or install a smaller Llama-compatible local model and set `OLLAMA_MODEL` to that model name.

The official MCP server does not require Ollama. Ollama is only used by the React chat endpoint at `/api/mcp/chat`; MCP clients can connect directly to `npm run mcp:stdio` or `http://localhost:5000/mcp`.
