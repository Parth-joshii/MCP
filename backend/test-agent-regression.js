const assert = require('assert');
const { processQuery } = require('./mcp/agent');

const cases = [
  {
    name: 'return id maps to return_id',
    databaseId: 'sales-demo',
    query: 'what is the customer_name of this RET-00002',
    includes: ['return_id: RET-00002', 'customer_name: Mira Kapoor', 'Source: returns', 'Filter: return_id = ret 00002'],
    rows: (rows) => rows.length === 1 && rows[0].return_id === 'RET-00002' && rows[0].customer_name === 'Mira Kapoor'
  },
  {
    name: 'product id prefers products collection',
    databaseId: 'sales-demo',
    query: 'what is the product_name of PRD-0020',
    includes: ['product_id: PRD-0020', 'product_name: Laptop Stand', 'Matched rows: 1', 'Source: products'],
    rows: (rows) => rows.length === 1 && rows[0].product_id === 'PRD-0020' && rows[0].product_name === 'Laptop Stand'
  },
  {
    name: 'customer id survives prompt cleanup',
    databaseId: 'sales-demo',
    query: 'what is the email of CUST-0001',
    includes: ['customer_id: CUST-0001', 'email: aarav.mehta@example.com', 'Source: customers'],
    rows: (rows) => rows.length === 1 && rows[0].customer_id === 'CUST-0001'
  },
  {
    name: 'return product query maps to returns product_name',
    databaseId: 'sales-demo',
    query: 'customer_name, and refund_amount who returns Laptop Stand',
    includes: ['customer_name: Mira Kapoor', 'refund_amount: 4965.24', 'Source: returns', 'Filter: product_name = laptop stand'],
    rows: (rows) => rows.length === 4 && rows.some((row) => row.customer_name === 'Mira Kapoor')
  },
  {
    name: 'product quantity query maps to order_items product_name',
    databaseId: 'sales-demo',
    query: 'what is the quantity of Laptop Stand',
    includes: ['product_name: Laptop Stand', 'Source: order_items', 'Filter: product_name = laptop stand'],
    rows: (rows) => rows.length === 20 && rows.every((row) => row.product_name === 'Laptop Stand')
  },
  {
    name: 'order status count uses orders',
    databaseId: 'sales-demo',
    query: 'how many orders whose order status is delivered',
    includes: ['Count: 198', 'Source: orders', 'Filter: order_status = delivered'],
    content: (content) => content && content.count === 198
  },
  {
    name: 'cricket player age uses players',
    databaseId: 'cricket-demo',
    query: 'what is the age of the Rohan Nair',
    includes: ['player_name: Rohan Nair', 'age: 25', 'Source: players'],
    rows: (rows) => rows.length === 1 && rows[0].player_name === 'Rohan Nair' && rows[0].age === 25
  },
  {
    name: 'country filter returns player names only',
    databaseId: 'cricket-demo',
    query: "who are the players who's country is Australia",
    includes: ['Source: players', 'Filter: country = australia'],
    rows: (rows) => rows.length === 19 && rows.every((row) => row.player_name && !row.country)
  },
  {
    name: 'matches played reads player stat, not matches collection',
    databaseId: 'cricket-demo',
    query: 'how many matches played by the Dhruv Verma',
    includes: ['player_name: Dhruv Verma', 'matches_played: 18', 'Source: players'],
    rows: (rows) => rows.length === 1 && rows[0].matches_played === 18
  }
];

const structuredRows = (result) => {
  const data = result.toolResult?.structuredContent;
  return Array.isArray(data) ? data : [];
};

const run = async () => {
  for (const item of cases) {
    const result = await processQuery(item.query, {
      scope: 'database',
      databaseId: item.databaseId,
      enhancePrompt: false,
      useLlmMongoPlanner: false
    });

    assert.strictEqual(result.toolUsed, 'database.query', `${item.name}: expected database.query, got ${result.toolUsed}`);
    assert(Array.isArray(result.mcpWorkflow) && result.mcpWorkflow.length >= 5, `${item.name}: missing MCP workflow trace`);

    for (const expected of item.includes || []) {
      assert(
        result.response.includes(expected),
        `${item.name}: response did not include "${expected}"\n${result.response}`
      );
    }

    if (item.rows) {
      const rows = structuredRows(result);
      assert(item.rows(rows), `${item.name}: row assertion failed\n${JSON.stringify(rows, null, 2)}`);
    }

    if (item.content) {
      assert(
        item.content(result.toolResult?.structuredContent),
        `${item.name}: structured content assertion failed\n${JSON.stringify(result.toolResult?.structuredContent, null, 2)}`
      );
    }

    console.log(`PASS ${item.name}`);
  }
};

run().then(() => {
  process.exit(0);
}).catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
