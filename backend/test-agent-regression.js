const assert = require('assert');
const { processQuery } = require('./mcp/agent');

const cases = [
  {
    name: 'return id maps to return_id',
    databaseId: 'sales-demo',
    query: 'what is the customer_name of this RET-00002',
    includes: ['return_id: RET-00002', 'customer_name:', 'Source: returns', 'Filter: return_id = ret 00002'],
    rows: (rows) => rows.length === 1 && rows[0].return_id === 'RET-00002' && Boolean(rows[0].customer_name)
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
    name: 'delivery status does not create generic status filter',
    databaseId: 'sales-demo',
    query: 'what is the delivery_status of ORD-00001',
    includes: ['order_id: ORD-00001', 'delivery_status: delivered', 'Source: shipments', 'Filter: order_id = ord 00001'],
    excludes: ['status = ord-00001'],
    rows: (rows) => rows.length === 1 && rows[0].order_id === 'ORD-00001' && rows[0].delivery_status === 'delivered'
  },
  {
    name: 'return product query maps to returns product_name',
    databaseId: 'sales-demo',
    query: 'customer_name, and refund_amount who returns Laptop Stand',
    includes: ['product_name: Laptop Stand', 'customer_name:', 'refund_amount:', 'Source: returns', 'Filter: product_name = laptop stand'],
    rows: (rows) => rows.length >= 1 && rows.every((row) => (
      row.product_name === 'Laptop Stand' && row.customer_name && Number.isFinite(Number(row.refund_amount))
    ))
  },
  {
    name: 'product quantity query maps to order_items product_name',
    databaseId: 'sales-demo',
    query: 'what is the quantity of Laptop Stand',
    includes: ['product_name: Laptop Stand', 'Source: order_items', 'Filter: product_name = laptop stand'],
    rows: (rows) => rows.length >= 1 && rows.every((row) => row.product_name === 'Laptop Stand')
  },
  {
    name: 'order status count uses orders',
    databaseId: 'sales-demo',
    query: 'how many orders whose order status is delivered',
    includes: ['Count:', 'Source: orders', 'Filter: order_status = delivered'],
    content: (content) => content && Number.isInteger(content.count) && content.count > 0
  },
  {
    name: 'cricket player age uses players',
    databaseId: 'cricket-demo',
    query: 'what is the age of the Rohan Nair',
    includes: ['player_name: Rohan Nair', 'age:', 'Source: players'],
    rows: (rows) => rows.length === 1 && rows[0].player_name === 'Rohan Nair' && Number.isFinite(Number(rows[0].age))
  },
  {
    name: 'country filter returns player names only',
    databaseId: 'cricket-demo',
    query: "who are the players who's country is Australia",
    includes: ['Source: players', 'Filter: country = australia'],
    rows: (rows) => rows.length > 0 && rows.every((row) => row.player_name && !row.country)
  },
  {
    name: 'matches played reads player stat, not matches collection',
    databaseId: 'cricket-demo',
    query: 'how many matches played by the Dhruv Verma',
    includes: ['player_name: Dhruv Verma', 'matches_played:', 'Source: players'],
    rows: (rows) => rows.length === 1 && Number.isFinite(Number(rows[0].matches_played))
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

    for (const unexpected of item.excludes || []) {
      assert(
        !result.response.includes(unexpected),
        `${item.name}: response should not include "${unexpected}"\n${result.response}`
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
