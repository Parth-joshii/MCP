# Mongo Extraction Format

Use this contract whenever the agent needs LLaMA to create a MongoDB extraction plan.

## Workflow

```text
User question
-> prompt cleanup / keyword detection
-> trusted backend extractor when schema match is strong
-> otherwise LLaMA produces mongo-extraction-v1 JSON
-> backend validates collection, fields, filters, operation, and read-only safety
-> MCP tool database.query executes MongoDB
-> exact MongoDB result is sent to the final answer formatter
-> user receives Answer / Details / Next
```

The LLM never directly mutates MongoDB and should not be treated as the source of truth. MongoDB is the source of truth; the LLM only creates or formats a plan.

## mongo-extraction-v1

```json
{
  "version": "mongo-extraction-v1",
  "extractionPrompt": "Extract the payment_method for transaction_id TXN-00002 from the transactions collection.",
  "intent": {
    "answerType": "single_value",
    "requestedFields": ["payment_method"],
    "filterFields": ["transaction_id"],
    "reason": "The user asks for one field from one transaction record."
  },
  "mongoQuery": {
    "collection": "transactions",
    "operation": "find",
    "filter": {
      "transaction_id": {
        "$regex": "txn[-_\\s]*00002",
        "$options": "i"
      }
    },
    "projection": {
      "_id": 0,
      "transaction_id": 1,
      "payment_method": 1
    },
    "sort": {},
    "field": "",
    "pipeline": [],
    "limit": 20
  },
  "response": {
    "answerFields": ["transaction_id", "payment_method"],
    "includeTable": false,
    "format": "Answer / Details / Next"
  }
}
```

## Operation Rules

- Use `find` for direct field answers, details, and filtered row lists.
- Use `count` for "how many rows/documents/entities" questions.
- Use `distinct` only when the user asks for unique values.
- Use `aggregate` for group, total, sum, average, top, highest, lowest, min, and max questions.
- The selected collection must contain every requested answer field and every filter field.
- Use only read operations: `find`, `count`, `distinct`, `aggregate`.
- Never use `$where`, `$function`, `$lookup`, `$graphLookup`, `$out`, or `$merge`.

## Examples

Count:
```json
{
  "version": "mongo-extraction-v1",
  "extractionPrompt": "Count players where country is Australia.",
  "intent": {
    "answerType": "count",
    "requestedFields": ["player_name"],
    "filterFields": ["country"],
    "reason": "The user asks how many players match a country filter."
  },
  "mongoQuery": {
    "collection": "players",
    "operation": "count",
    "filter": {
      "country": {
        "$regex": "^australia$",
        "$options": "i"
      }
    },
    "projection": {},
    "sort": {},
    "field": "",
    "pipeline": [],
    "limit": 1
  },
  "response": {
    "answerFields": ["count"],
    "includeTable": false,
    "format": "Answer / Details / Next"
  }
}
```

Aggregate:
```json
{
  "version": "mongo-extraction-v1",
  "extractionPrompt": "Find the top 3 players by total_runs.",
  "intent": {
    "answerType": "aggregate",
    "requestedFields": ["player_name", "total_runs"],
    "filterFields": [],
    "reason": "The user asks for a ranked metric."
  },
  "mongoQuery": {
    "collection": "players",
    "operation": "aggregate",
    "filter": {},
    "projection": {},
    "sort": {},
    "field": "",
    "pipeline": [
      {
        "$group": {
          "_id": "$player_name",
          "total": {
            "$sum": "$total_runs"
          },
          "count": {
            "$sum": 1
          }
        }
      },
      {
        "$project": {
          "_id": 0,
          "player_name": "$_id",
          "total": 1,
          "count": 1
        }
      },
      {
        "$sort": {
          "total": -1
        }
      }
    ],
    "limit": 3
  },
  "response": {
    "answerFields": ["player_name", "total"],
    "includeTable": true,
    "format": "Answer / Details / Next"
  }
}
```
